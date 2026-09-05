//go:build native_mount

package main

import (
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

func TestErrnoMapsRetryableTransientForThisRuntime(t *testing.T) {
	got := errno(&ipcError{
		Code:    "EAGAIN",
		Message: "initial view is still settling",
	})
	want := -fuse.EAGAIN
	if runtime.GOOS == "windows" {
		want = -fuse.ENOLCK
	}
	if got != want {
		t.Fatalf("expected %d, got %d", want, got)
	}
}

func TestReaddirPassesCompleteStatsWithoutGetattrRequests(t *testing.T) {
	var requests atomic.Uint64
	observedRequests := make(chan ipcRequest, 16)
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		requests.Add(1)
		observedRequests <- request
		return []interface{}{
			map[string]interface{}{
				"name": "child",
				"kind": "directory",
				"stat": map[string]interface{}{
					"size": 0, "mode": 0o040755,
					"mtimeMs": 1_725_000_000_125, "ctimeMs": 1_725_000_000_250,
					"nlink": 2,
				},
			},
			map[string]interface{}{
				"name": "note.txt",
				"kind": "file",
				"stat": map[string]interface{}{
					"size": 12_345, "mode": 0o100644,
					"mtimeMs": 1_725_000_001_375, "ctimeMs": 1_725_000_001_500,
					"nlink": 1,
				},
			},
		}
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	fs := &peerbitFS{client: client}
	stats := make(map[string]*fuse.Stat_t)
	fillCalls := 0

	got := fs.Readdir("/workspace", func(name string, stat *fuse.Stat_t, _ int64) bool {
		fillCalls++
		if stat != nil {
			copy := *stat
			stats[name] = &copy
		}
		return true
	}, 0, 0)

	if got != 0 {
		t.Fatalf("expected readdir success, got errno %d", got)
	}
	if count := requests.Load(); count != 1 {
		t.Fatalf("expected exactly one readdir request and no getattr requests, got %d", count)
	}
	assertReaddirRequest(t, <-observedRequests, "/workspace")
	if fillCalls != 4 {
		t.Fatalf("expected dot entries plus two children, got %d callbacks", fillCalls)
	}
	directory := stats["child"]
	if directory == nil || directory.Mode != nativeStatMode(0o040755) || directory.Size != 0 || directory.Nlink != 2 {
		t.Fatalf("unexpected directory stat: %#v", directory)
	}
	if directory.Mtim != msToTimespec(1_725_000_000_125) || directory.Ctim != msToTimespec(1_725_000_000_250) {
		t.Fatalf("unexpected directory timestamps: mtime=%#v ctime=%#v", directory.Mtim, directory.Ctim)
	}
	file := stats["note.txt"]
	if file == nil || file.Mode != nativeStatMode(0o100644) || file.Size != 12_345 || file.Nlink != 1 {
		t.Fatalf("unexpected file stat: %#v", file)
	}
	if file.Mtim != msToTimespec(1_725_000_001_375) || file.Ctim != msToTimespec(1_725_000_001_500) {
		t.Fatalf("unexpected file timestamps: mtime=%#v ctime=%#v", file.Mtim, file.Ctim)
	}
}

func TestReaddirFallsBackForLegacyAndMalformedStats(t *testing.T) {
	valid := map[string]interface{}{
		"path": "/valid.txt", "kind": "file", "size": 5,
		"mode": 0o100644, "mtimeMs": 1_725_000_000_000,
		"ctimeMs": 1_725_000_000_000, "nlink": 1,
	}
	entries := []interface{}{
		map[string]interface{}{"name": "legacy.txt", "kind": "file"},
		map[string]interface{}{"name": "not-an-object.txt", "kind": "file", "stat": "invalid"},
		map[string]interface{}{"name": "missing-field.txt", "kind": "file", "stat": map[string]interface{}{
			"path": "/missing-field.txt", "kind": "file", "size": 1,
			"mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1,
		}},
		map[string]interface{}{"name": "negative-size.txt", "kind": "file", "stat": map[string]interface{}{
			"path": "/negative-size.txt", "kind": "file", "size": -1,
			"mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "wrong-mode.txt", "kind": "file", "stat": map[string]interface{}{
			"path": "/wrong-mode.txt", "kind": "file", "size": 1,
			"mode": 0o040755, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "wrong-path.txt", "kind": "file", "stat": map[string]interface{}{
			"path": "/somewhere-else.txt", "kind": "file", "size": 1,
			"mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "fractional-time.txt", "kind": "file", "stat": map[string]interface{}{
			"path": "/fractional-time.txt", "kind": "file", "size": 1,
			"mode": 0o100644, "mtimeMs": 1.5, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "valid.txt", "kind": "file", "stat": valid},
	}
	observedRequests := make(chan ipcRequest, 16)
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		observedRequests <- request
		// Model an older JavaScript server: extra function arguments are
		// ignored and its compact legacy response remains valid.
		return entries
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	fs := &peerbitFS{client: client}
	seen := make(map[string]bool)

	got := fs.Readdir("/", func(name string, stat *fuse.Stat_t, _ int64) bool {
		if name != "." && name != ".." {
			seen[name] = stat != nil
		}
		return true
	}, 0, 0)

	if got != 0 {
		t.Fatalf("expected readdir success, got errno %d", got)
	}
	assertReaddirRequest(t, <-observedRequests, "/")
	if got := len(observedRequests); got != 0 {
		t.Fatalf("readdir made %d unexpected follow-up requests", got)
	}
	if len(seen) != len(entries) {
		t.Fatalf("expected %d child callbacks, got %d", len(entries), len(seen))
	}
	for name, hadStat := range seen {
		if name == "valid.txt" {
			if !hadStat {
				t.Fatal("complete metadata did not reach fill")
			}
			continue
		}
		if hadStat {
			t.Fatalf("legacy or malformed metadata for %q must fall back to nil", name)
		}
	}
}

func assertReaddirRequest(t *testing.T, request ipcRequest, expectedPath string) {
	t.Helper()
	if request.Op != "readdir" {
		t.Fatalf("expected one readdir request, got %q", request.Op)
	}
	expectedArgs := 1
	if requestReaddirStats {
		expectedArgs = 2
	}
	if len(request.Args) != expectedArgs {
		t.Fatalf("readdir args = %#v, expected %d for this build", request.Args, expectedArgs)
	}
	if path, ok := request.Args[0].(string); !ok || path != expectedPath {
		t.Fatalf("readdir path = %#v, expected %q", request.Args[0], expectedPath)
	}
	if !requestReaddirStats {
		return
	}
	options, ok := request.Args[1].(map[string]interface{})
	if !ok || len(options) != 1 || options["includeStats"] != true {
		t.Fatalf("readdir-plus options = %#v, expected includeStats=true", request.Args[1])
	}
}

func TestUnsupportedMetadataMutationsFailClosed(t *testing.T) {
	// A nil IPC client makes an accidental request fail loudly. Metadata is not
	// represented by the Shared FS model, so the adapter must reject these
	// operations before it can report false success for any path.
	fs := &peerbitFS{}
	requestedTimes := []fuse.Timespec{
		fuse.NewTimespec(time.Unix(946684800, 0)),
		fuse.NewTimespec(time.Unix(946684801, 0)),
	}
	tests := []struct {
		name string
		run  func() int
	}{
		{
			name: "chmod",
			run:  func() int { return fs.Chmod("/missing", 0o755) },
		},
		{
			name: "chown",
			run:  func() int { return fs.Chown("/missing", 1000, 1000) },
		},
		{
			name: "utimens",
			run: func() int {
				return fs.Utimens("/missing", requestedTimes)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.run(); got != -fuse.ENOSYS {
				t.Fatalf("expected %d, got %d", -fuse.ENOSYS, got)
			}
		})
	}
}

// This verifies the adapter boundary, not which flags a specific kernel or
// WinFsp supplies to cgofuse's Create callback.
func TestCreateForwardsCgofuseCallbackFlags(t *testing.T) {
	requests := make(chan ipcRequest, 1)
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		requests <- request
		return float64(41)
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	fs := &peerbitFS{client: client}
	flags := fuse.O_WRONLY | fuse.O_CREAT | fuse.O_EXCL | fuse.O_APPEND

	errno, handle := fs.Create("/exclusive-append.txt", flags, 0o640)
	if errno != 0 {
		t.Fatalf("expected create success, got errno %d", errno)
	}
	if handle != 41 {
		t.Fatalf("expected handle 41, got %d", handle)
	}

	request := <-requests
	if request.Op != "open" {
		t.Fatalf("expected open request, got %q", request.Op)
	}
	if len(request.Args) != 2 {
		t.Fatalf("expected two open arguments, got %#v", request.Args)
	}
	if path, ok := request.Args[0].(string); !ok || path != "/exclusive-append.txt" {
		t.Fatalf("expected forwarded path, got %#v", request.Args[0])
	}
	if forwarded, ok := request.Args[1].(float64); !ok || int(forwarded) != flags {
		t.Fatalf("expected flags %#x, got %#v", flags, request.Args[1])
	}
}

func TestMknodUsesExclusiveCreateWithoutTruncate(t *testing.T) {
	requests := make(chan ipcRequest, 2)
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		requests <- request
		return float64(41)
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	fs := &peerbitFS{client: client}

	if got := fs.Mknod("/new-node.txt", 0o640, 0); got != 0 {
		t.Fatalf("expected mknod success, got errno %d", got)
	}

	openRequest := <-requests
	if openRequest.Op != "open" || len(openRequest.Args) != 2 {
		t.Fatalf("expected open(path, flags), got %#v", openRequest)
	}
	if path, ok := openRequest.Args[0].(string); !ok || path != "/new-node.txt" {
		t.Fatalf("expected mknod path, got %#v", openRequest.Args[0])
	}
	flags, ok := openRequest.Args[1].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object flags, got %#v", openRequest.Args[1])
	}
	if len(flags) != 4 || flags["write"] != true || flags["create"] != true || flags["exclusive"] != true || flags["releaseFailure"] != "discard" {
		t.Fatalf("expected write/create/exclusive/discard flags, got %#v", flags)
	}
	if _, exists := flags["truncate"]; exists {
		t.Fatalf("mknod must not request truncate: %#v", flags)
	}

	releaseRequest := <-requests
	if releaseRequest.Op != "release" || len(releaseRequest.Args) != 1 {
		t.Fatalf("expected release(handle), got %#v", releaseRequest)
	}
	if handle, ok := releaseRequest.Args[0].(float64); !ok || handle != 41 {
		t.Fatalf("expected release handle 41, got %#v", releaseRequest.Args[0])
	}
}

func TestMknodReleaseFailureCanBeRetried(t *testing.T) {
	failedRelease := false
	server := startIPCResponseServer(t, func(request ipcRequest) ipcResponse {
		if request.Op == "release" && !failedRelease {
			failedRelease = true
			return ipcResponse{
				ID: request.ID,
				OK: false,
				Error: &ipcErrorObject{
					Code:    "EIO",
					Message: "injected one-shot release failure",
				},
			}
		}
		return ipcResponse{ID: request.ID, OK: true, Result: float64(41)}
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	fs := &peerbitFS{client: client}

	if got := fs.Mknod("/retry-node.txt", 0o640, 0); got != -fuse.EIO {
		t.Fatalf("expected first mknod release to fail with EIO, got %d", got)
	}
	if got := fs.Mknod("/retry-node.txt", 0o640, 0); got != 0 {
		t.Fatalf("expected mknod retry to proceed, got errno %d", got)
	}
}
