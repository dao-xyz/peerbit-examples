//go:build native_mount

package main

import (
	"testing"

	"github.com/winfsp/cgofuse/fuse"
)

func TestErrnoMapsRetryableReadiness(t *testing.T) {
	got := errno(&ipcError{
		Code:    "EAGAIN",
		Message: "initial view is still settling",
	})
	if got != -fuse.EAGAIN {
		t.Fatalf("expected %d, got %d", -fuse.EAGAIN, got)
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
