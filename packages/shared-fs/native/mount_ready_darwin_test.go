//go:build native_mount && darwin

package main

import "testing"

func TestIsMountedAt(t *testing.T) {
	if mounted, err := isMountedAt("/"); err != nil || !mounted {
		t.Fatalf("isMountedAt(/) = %v, %v; want true", mounted, err)
	}
	if mounted, err := isMountedAt(t.TempDir()); err != nil || mounted {
		t.Fatalf("isMountedAt(temp dir) = %v, %v; want false", mounted, err)
	}
}

func TestMountWatcherReturnsForAttachedMount(t *testing.T) {
	watcher, err := newMountWatcher("/")
	if err != nil {
		t.Fatal(err)
	}
	if err := watcher.wait(); err != nil {
		t.Fatal(err)
	}
}
