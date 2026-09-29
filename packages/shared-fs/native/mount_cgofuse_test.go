//go:build native_mount

package main

import (
	"bytes"
	"os"
	"reflect"
	"runtime"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

func TestStatfsProfilesCompleteNativeCallback(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output, 4)
	fs := &peerbitFS{profile: profile}
	var stat fuse.Statfs_t
	if code := fs.Statfs("/", &stat); code != 0 {
		t.Fatalf("statfs returned %d", code)
	}
	profile.close()
	records, _ := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 1 || records[0].Phase != "native.callback" || records[0].Operation != "statfs" || !records[0].OK || records[0].Detail != nil {
		t.Fatalf("unexpected profile records: %#v", records)
	}
}

func TestIOCallbackProfileCarriesSizeOffsetAndErrno(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output, 4)
	fs := &peerbitFS{profile: profile}
	fs.beginIOCallback("read", 4096, 1<<20)(-fuse.ENOENT)
	fs.beginIOCallback("write", 131072, 0)(131072)
	fs.beginCallback("link")(-fuse.ENOSYS)
	profile.close()

	records, _ := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 3 {
		t.Fatalf("got %d records, want three", len(records))
	}
	read, write, link := records[0], records[1], records[2]
	if read.Operation != "read" || read.OK || detailNumber(t, read, "bytes") != 4096 || detailNumber(t, read, "offset") != 1<<20 ||
		detailNumber(t, read, "errno") != int64(-fuse.ENOENT) || read.Detail["code"] != "ENOENT" {
		t.Fatalf("unexpected read record: %#v", read)
	}
	if write.Operation != "write" || !write.OK || detailNumber(t, write, "bytes") != 131072 || detailNumber(t, write, "offset") != 0 ||
		write.Detail["errno"] != nil || write.Detail["code"] != nil {
		t.Fatalf("unexpected write record: %#v", write)
	}
	if link.OK || link.Detail["code"] != "ENOSYS" || link.Detail["bytes"] != nil {
		t.Fatalf("unexpected link record: %#v", link)
	}
}

func TestDisabledCallbackProfileHasNoFinisher(t *testing.T) {
	fs := &peerbitFS{}
	if fs.beginCallback("getattr") != nil || fs.beginIOCallback("read", 1, 0) != nil {
		t.Fatal("disabled profiling returned a callback finisher")
	}
}

func TestErrnoMapsRetryableReadiness(t *testing.T) {
	got := errno(&ipcError{
		Code:    "EAGAIN",
		Message: "initial view is still settling",
	})
	if got != -fuse.EAGAIN {
		t.Fatalf("expected %d, got %d", -fuse.EAGAIN, got)
	}
}

// Linux caches names for up to 0.1 s, so Open can see ENOENT for a name
// another peer just removed. Only Linux answers ESTALE, which makes the
// kernel retry the open with a fresh lookup (and create the file for O_CREAT).
func TestOpenAnswersESTALEForMissingPathOnLinuxOnly(t *testing.T) {
	for _, test := range []struct {
		goos string
		code int
		want int
	}{
		{"linux", -fuse.ENOENT, -linuxESTALE},
		{"linux", -fuse.EISDIR, -fuse.EISDIR},
		{"linux", -fuse.EACCES, -fuse.EACCES},
		{"linux", -fuse.EAGAIN, -fuse.EAGAIN},
		{"linux", -fuse.EIO, -fuse.EIO},
		{"darwin", -fuse.ENOENT, -fuse.ENOENT},
		{"windows", -fuse.ENOENT, -fuse.ENOENT},
	} {
		if got := openErrno(test.code, test.goos); got != test.want {
			t.Fatalf("openErrno(%d, %s) = %d, want %d", test.code, test.goos, got, test.want)
		}
	}
	if runtime.GOOS == "linux" && linuxESTALE != int(syscall.ESTALE) {
		t.Fatalf("linuxESTALE = %d, but syscall.ESTALE is %d", linuxESTALE, int(syscall.ESTALE))
	}

	server := startIPCResponseServer(t, func(request ipcRequest) ipcResponse {
		return ipcResponse{ID: request.ID, OK: false, Error: &ipcErrorObject{Code: "ENOENT", Message: "missing"}}
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	var output bytes.Buffer
	profile := newMountProfiler(&output, 8)
	fs := &peerbitFS{client: client, profile: profile}

	wantOpen, wantName := -fuse.ENOENT, "ENOENT"
	if runtime.GOOS == "linux" {
		wantOpen, wantName = -linuxESTALE, "ESTALE"
	}
	if code, handle := fs.Open("/removed.txt", fuse.O_WRONLY|fuse.O_TRUNC); code != wantOpen || handle != ^uint64(0) {
		t.Fatalf("open = (%d, %#x), want (%d, no handle)", code, handle, wantOpen)
	}
	// Getattr also answers LOOKUP, and Create follows a negative lookup, so
	// both keep ENOENT on every platform.
	var stat fuse.Stat_t
	if code := fs.Getattr("/removed.txt", &stat, ^uint64(0)); code != -fuse.ENOENT {
		t.Fatalf("getattr = %d, want ENOENT", code)
	}
	if code, _ := fs.Create("/missing/new.txt", fuse.O_WRONLY|fuse.O_CREAT, 0o644); code != -fuse.ENOENT {
		t.Fatalf("create = %d, want ENOENT", code)
	}
	profile.close()

	records, _ := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 3 {
		t.Fatalf("got %d callback records, want three: %#v", len(records), records)
	}
	open := records[0]
	if open.Operation != "open" || open.OK || detailNumber(t, open, "errno") != int64(wantOpen) || open.Detail["code"] != wantName {
		t.Fatalf("unexpected open record: %#v", open)
	}
	for _, record := range records[1:] {
		if record.OK || record.Detail["code"] != "ENOENT" {
			t.Fatalf("unexpected %s record: %#v", record.Operation, record)
		}
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
			map[string]interface{}{
				"name": "link",
				"kind": "symlink",
				"stat": map[string]interface{}{
					"size": 8, "mode": 0o120777,
					"mtimeMs": 1_725_000_002_000, "ctimeMs": 1_725_000_002_000,
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
	if fillCalls != 5 {
		t.Fatalf("expected dot entries plus three children, got %d callbacks", fillCalls)
	}
	if runtime.GOOS != "windows" {
		// Without readdir-plus the host gets only the type bits, for d_type.
		for name, mode := range map[string]uint32{"child": statModeDirectory, "note.txt": statModeRegular, "link": statModeSymlink} {
			if stat := stats[name]; stat == nil || *stat != (fuse.Stat_t{Mode: mode}) {
				t.Fatalf("%s: stat = %#v, expected only the type bits %o", name, stat, mode)
			}
		}
		return
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
	if link := stats["link"]; link == nil || link.Mode != nativeStatMode(0o120777) || link.Size != 8 {
		t.Fatalf("unexpected symlink stat: %#v", link)
	}
}

func TestValidatedDirentStatRejectsLegacyAndMalformedStats(t *testing.T) {
	valid := map[string]interface{}{
		"path": "/valid.txt", "kind": "file", "size": 5,
		"mode": 0o100644, "mtimeMs": 1_725_000_000_000,
		"ctimeMs": 1_725_000_000_000, "nlink": 1,
	}
	entries := []map[string]interface{}{
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
		map[string]interface{}{"name": "empty-link", "kind": "symlink", "stat": map[string]interface{}{
			"size": 0, "mode": 0o120777, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "regular-link", "kind": "symlink", "stat": map[string]interface{}{
			"size": 1, "mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "link-mode-file", "kind": "file", "stat": map[string]interface{}{
			"size": 1, "mode": 0o120777, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1,
		}},
		map[string]interface{}{"name": "valid.txt", "kind": "file", "stat": valid},
	}
	for _, entry := range entries {
		name := entry["name"].(string)
		if hasStat := validatedDirentStat("/", name, entry) != nil; hasStat != (name == "valid.txt") {
			t.Fatalf("validatedDirentStat(%q) returned a stat: %v", name, hasStat)
		}
	}
}

func assertReaddirRequest(t *testing.T, request ipcRequest, expectedPath string) {
	t.Helper()
	if request.Op != "readdir" {
		t.Fatalf("expected one readdir request, got %q", request.Op)
	}
	expectedArgs := 1
	if runtime.GOOS == "windows" {
		expectedArgs = 2
	}
	if len(request.Args) != expectedArgs {
		t.Fatalf("readdir args = %#v, expected %d for this build", request.Args, expectedArgs)
	}
	if path, ok := request.Args[0].(string); !ok || path != expectedPath {
		t.Fatalf("readdir path = %#v, expected %q", request.Args[0], expectedPath)
	}
	if runtime.GOOS != "windows" {
		return
	}
	options, ok := request.Args[1].(map[string]interface{})
	if !ok || len(options) != 1 || options["includeStats"] != true {
		t.Fatalf("readdir-plus options = %#v, expected includeStats=true", request.Args[1])
	}
}

// recordingFS answers every request with result and records it.
func recordingFS(t *testing.T, result interface{}) (*peerbitFS, chan ipcRequest) {
	t.Helper()
	requests := make(chan ipcRequest, 8)
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		requests <- request
		return result
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	t.Cleanup(client.close)
	return &peerbitFS{client: client}, requests
}

func expectRequest(t *testing.T, requests chan ipcRequest, op string, args ...interface{}) {
	t.Helper()
	request := <-requests
	if request.Op != op || !reflect.DeepEqual(request.Args, args) {
		t.Fatalf("got %s %#v, want %s %#v", request.Op, request.Args, op, args)
	}
}

func TestMetadataMutations(t *testing.T) {
	fs, requests := recordingFS(t, nil)
	// A nil IPC client fails loudly on any request, so these cases prove the
	// adapter answers them without IPC.
	local := &peerbitFS{}
	mtime := func(sec, nsec int64) []fuse.Timespec {
		return []fuse.Timespec{{Sec: 1, Nsec: 5}, {Sec: sec, Nsec: nsec}}
	}
	maxSec := int64(maxSafeJSONInteger / 1000)
	for _, test := range []struct {
		name string
		run  func() int
		want int
	}{
		{"chown", func() int { return local.Chown("/f", 1000, 1000) }, 0},
		{"utimens without times", func() int { return local.Utimens("/f", nil) }, 0},
		{"utimens UTIME_OMIT", func() int { return local.Utimens("/f", mtime(0, fuse.UTIME_OMIT)) }, 0},
		{"utimens macOS UTIME_OMIT", func() int { return local.Utimens("/f", mtime(0, -2)) }, 0},
		{"utimens nsec out of range", func() int { return local.Utimens("/f", mtime(0, 1e9)) }, 0},
		{"utimens before 1970", func() int { return local.Utimens("/f", mtime(-1, 0)) }, -fuse.EINVAL},
		{"utimens seconds too large", func() int { return local.Utimens("/f", mtime(maxSec+1, 0)) }, -fuse.EINVAL},
		{"utimens ms too large", func() int { return local.Utimens("/f", mtime(maxSec, 999e6)) }, -fuse.EINVAL},
	} {
		if got := test.run(); got != test.want {
			t.Fatalf("%s returned %d, want %d", test.name, got, test.want)
		}
	}

	if runtime.GOOS == "windows" {
		if got := local.Chmod("/f", fuse.S_IFREG|0o755); got != 0 {
			t.Fatalf("Windows chmod returned %d, want a local no-op", got)
		}
	} else {
		if got := fs.Chmod("/f", fuse.S_IFREG|0o4755); got != 0 {
			t.Fatalf("chmod returned %d", got)
		}
		expectRequest(t, requests, "setattr", "/f", map[string]interface{}{"mode": float64(0o4755)})
	}
	if got := fs.Utimens("/f", mtime(946684800, 123_456_789)); got != 0 {
		t.Fatalf("utimens returned %d", got)
	}
	expectRequest(t, requests, "setattr", "/f", map[string]interface{}{"mtimeMs": float64(946684800123)})
	if got := fs.Utimens("/f", mtime(maxSec, 991e6)); got != 0 {
		t.Fatalf("utimens at the JSON bound returned %d", got)
	}
	expectRequest(t, requests, "setattr", "/f", map[string]interface{}{"mtimeMs": float64(maxSafeJSONInteger)})
	for _, nsec := range []int64{fuse.UTIME_NOW, -1} {
		before := time.Now().UnixMilli()
		if got := fs.Utimens("/f", mtime(0, nsec)); got != 0 {
			t.Fatalf("utimens now (%d) returned %d", nsec, got)
		}
		after := time.Now().UnixMilli()
		request := <-requests
		attrs, _ := request.Args[1].(map[string]interface{})
		ms, _ := attrs["mtimeMs"].(float64)
		if request.Op != "setattr" || int64(ms) < before || int64(ms) > after {
			t.Fatalf("utimens now (%d) sent %s %#v, want mtimeMs in [%d, %d]", nsec, request.Op, request.Args, before, after)
		}
	}
}

func TestSymlinkAndReadlink(t *testing.T) {
	fs, requests := recordingFS(t, "../lib/tool.js")
	if got := fs.Symlink("../lib/tool.js", "/bin/tool"); got != 0 {
		t.Fatalf("symlink returned %d", got)
	}
	expectRequest(t, requests, "symlink", "../lib/tool.js", "/bin/tool")
	if got, target := fs.Readlink("/bin/tool"); got != 0 || target != "../lib/tool.js" {
		t.Fatalf("readlink = (%d, %q)", got, target)
	}
	expectRequest(t, requests, "readlink", "/bin/tool")

	local := &peerbitFS{}
	if got := local.Symlink("bad\xff", "/bad"); got != -fuse.EINVAL {
		t.Fatalf("invalid UTF-8 target returned %d, want EINVAL", got)
	}
	if got, _ := local.Readlink("/"); got != -fuse.EINVAL {
		t.Fatalf("readlink / returned %d, want EINVAL", got)
	}
	numeric, _ := recordingFS(t, float64(3))
	if got, _ := numeric.Readlink("/bin/tool"); got != -fuse.EIO {
		t.Fatalf("non-string readlink result returned %d, want EIO", got)
	}
}

func TestAccessChecksExecBit(t *testing.T) {
	for _, test := range []struct {
		mode uint32
		mask uint32
		want int
	}{
		{0o100644, fuse.X_OK, -fuse.EACCES},
		{0o100644, fuse.R_OK | fuse.W_OK, 0},
		{0o100755, fuse.X_OK, 0},
		{0o040755, fuse.X_OK, 0},
		{0o120777, fuse.X_OK, 0},
	} {
		fs, _ := recordingFS(t, map[string]interface{}{"mode": float64(test.mode)})
		want := test.want
		if runtime.GOOS == "windows" {
			want = 0
		}
		if got := fs.Access("/f", test.mask); got != want {
			t.Fatalf("access(mode %#o, mask %d) = %d, want %d", test.mode, test.mask, got, want)
		}
	}
}

func TestStatOwnerDefaultsToMountingUser(t *testing.T) {
	stat := statFromResult(map[string]interface{}{"mode": float64(0o100644)})
	wantUID, wantGID := uint32(os.Getuid()), uint32(os.Getgid())
	if runtime.GOOS == "windows" {
		wantUID, wantGID = 0, 0
	}
	if stat.Uid != wantUID || stat.Gid != wantGID {
		t.Fatalf("owner = %d:%d, want %d:%d", stat.Uid, stat.Gid, wantUID, wantGID)
	}
	if stat := statFromResult(map[string]interface{}{"uid": float64(7), "gid": float64(8)}); stat.Uid != 7 || stat.Gid != 8 {
		t.Fatalf("explicit owner = %d:%d, want 7:8", stat.Uid, stat.Gid)
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

	errno, handle := fs.Create("/exclusive-append.txt", flags, fuse.S_IFREG|0o4751)
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
	// WinFsp derives create modes from ACLs, so Windows forwards none.
	wantArgs := 3
	if runtime.GOOS == "windows" {
		wantArgs = 2
	}
	if len(request.Args) != wantArgs {
		t.Fatalf("expected %d open arguments, got %#v", wantArgs, request.Args)
	}
	if path, ok := request.Args[0].(string); !ok || path != "/exclusive-append.txt" {
		t.Fatalf("expected forwarded path, got %#v", request.Args[0])
	}
	if forwarded, ok := request.Args[1].(float64); !ok || int(forwarded) != flags {
		t.Fatalf("expected flags %#x, got %#v", flags, request.Args[1])
	}
	if wantArgs == 3 && request.Args[2] != float64(0o751) {
		t.Fatalf("expected create mode 0751, got %#v", request.Args[2])
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

	// cgofuse's create fallback passes S_IFREG|mode.
	if got := fs.Mknod("/new-node.txt", fuse.S_IFREG|0o750, 0); got != 0 {
		t.Fatalf("expected mknod success, got errno %d", got)
	}

	openRequest := <-requests
	wantArgs := 3
	if runtime.GOOS == "windows" {
		wantArgs = 2
	}
	if openRequest.Op != "open" || len(openRequest.Args) != wantArgs {
		t.Fatalf("expected open(path, flags[, mode]), got %#v", openRequest)
	}
	if wantArgs == 3 && openRequest.Args[2] != float64(0o750) {
		t.Fatalf("expected create mode 0750, got %#v", openRequest.Args[2])
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
