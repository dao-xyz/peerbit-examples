//go:build native_mount

package main

import (
	"path/filepath"
	"testing"
)

// The adapter refuses a Mac with only FUSE-T before it connects or mounts. No
// server listens at the endpoint, so a check made after connecting would
// return a connection error instead.
func TestRunNativeMountRefusesFuseTBeforeConnecting(t *testing.T) {
	goos, exists := mountGOOS, fuseLibraryExists
	t.Cleanup(func() { mountGOOS, fuseLibraryExists = goos, exists })
	mountGOOS = "darwin"
	fuseLibraryExists = func(path string) bool { return path == fuseTLibrary }

	endpoint := filepath.Join(t.TempDir(), "no-server.sock")
	err := runNativeMount(endpoint, t.TempDir(), "", false, nil)
	// Unwrapped, so the adapter prints the text peerbit-fs mount prints.
	if err != errFuseTUnsupported {
		t.Fatalf("runNativeMount = %v, want %v", err, errFuseTUnsupported)
	}
}
