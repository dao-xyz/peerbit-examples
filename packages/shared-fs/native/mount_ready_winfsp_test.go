//go:build native_mount

package main

import (
	"bufio"
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/winfsp/cgofuse/fuse"
)

// stdoutLines swaps os.Stdout for a pipe until the test ends and delivers
// each line written to it.
func stdoutLines(t *testing.T) <-chan string {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = writer
	lines := make(chan string, 64)
	read := make(chan struct{})
	go func() {
		defer close(read)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			default:
			}
		}
	}()
	t.Cleanup(func() {
		os.Stdout = original
		writer.Close()
		<-read
		reader.Close()
	})
	return lines
}

// The order is fsp_fuse_loop_start's in WinFsp 2.1: init, the probes that
// read the root, then the volume, the drive letter and the dispatcher.
func TestReadyLineWaitsForTheDriveLetterInWinFspOrder(t *testing.T) {
	fs, requests := recordingFS(t, map[string]interface{}{"mode": float64(0o40755), "nlink": float64(2)})
	drives := newFakeDrives()
	// runNativeMount creates the watcher before host.Mount.
	watcher, err := newDriveWatcher("P:", drives, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	deadline := make(chan time.Time, 1)
	watcher.after = func(time.Duration) <-chan time.Time { return deadline }
	fs.mounted = watcher
	// As runNativeMount does: Init hands the stop its way to unmount.
	fs.stop = &mountStop{}
	stdout := stdoutLines(t)
	ready := false
	t.Cleanup(func() {
		// A test that failed before the ready line leaves the wait blocked:
		// release it. Init gave the wait this test's stdout pipe, so a line it
		// writes later cannot reach the real stdout.
		if !ready {
			deadline <- time.Time{}
		}
	})
	noReadyLine := func(when string) {
		t.Helper()
		select {
		case line := <-stdout:
			ready = true
			t.Fatalf("%s, while P: is not defined, the adapter wrote %q", when, line)
		default:
		}
	}

	fs.Init()
	// The wait has looked once: P: is not defined, so no ready line.
	select {
	case line := <-stdout:
		ready = true
		t.Fatalf("the adapter wrote %q before it looked for P:", line)
	case defined := <-drives.checks:
		if defined {
			t.Fatal("P: is defined before WinFsp defines it")
		}
	case <-time.After(patience):
		t.Fatalf("the ready wait did not look for P: within %s", patience)
	}

	var statfs fuse.Statfs_t
	if code := fs.Statfs("/", &statfs); code != 0 {
		t.Fatalf("statfs / = %d", code)
	}
	var stat fuse.Stat_t
	if code := fs.Getattr("/", &stat, ^uint64(0)); code != 0 || stat.Mode&fuse.S_IFMT != fuse.S_IFDIR {
		t.Fatalf("getattr / = %d, mode %o; want the root directory", code, stat.Mode)
	}
	expectRequest(t, requests, "getattr", "/")
	if code, _ := fs.Readlink("/"); code != -fuse.EINVAL {
		t.Fatalf("readlink / = %d, want EINVAL (symlinks supported)", code)
	}
	fs.Getattr("/.", &stat, ^uint64(0))
	if runtime.GOOS != "windows" {
		expectRequest(t, requests, "getattr", "/.")
	}
	if code, _ := fs.Getxattr("/", "non-existant-a11ec902d22f4ec49003af15282d3b00"); code != -fuse.ENOSYS {
		t.Fatalf("getxattr probe = %d, want ENOSYS", code)
	}
	noReadyLine("after WinFsp's probes")

	// FspFileSystemSetMountPoint: DefineDosDevice defines P: and broadcasts
	// its arrival.
	drives.define("P:")
	drives.arrive()
	drives.expectCheck(t, true, nil)
	select {
	case line := <-stdout:
		ready = true
		if line != "peerbit-shared-fs-native ready" {
			t.Fatalf("the adapter wrote %q, want its ready line", line)
		}
	case <-time.After(patience):
		t.Fatalf("no ready line within %s of P: arriving", patience)
	}

	// What a client does on the ready line (the CLI then prints Mounted):
	// its mkdir reaches the adapter.
	if code := fs.Mkdir("/npm-app", 0o777); code != 0 {
		t.Fatalf("mkdir /npm-app = %d", code)
	}
	expectRequest(t, requests, "mkdir", "/npm-app")
	if drives.stopCount() != 1 {
		t.Fatalf("the watcher stopped %d times, want once", drives.stopCount())
	}
}
