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
