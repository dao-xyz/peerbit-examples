//go:build darwin

package main

import (
	"syscall"
	"testing"
)

func TestDarwinDeadMountSystemRecognisesOnlyThisAdaptersMounts(t *testing.T) {
	system := hostDeadMountSystem()
	uid := system.uid
	if !system.disconnected(syscall.ENXIO) || !system.disconnected(syscall.ENOTCONN) || system.disconnected(syscall.ENOENT) {
		t.Fatal("ENXIO and ENOTCONN mark a disconnected macFUSE mount")
	}
	for _, test := range []struct {
		entry *mountEntry
		want  bool
	}{
		{&mountEntry{fsType: "macfuse", source: "peerbit-shared-fs", owner: uid}, true},
		{&mountEntry{fsType: "osxfuse", source: "peerbit-shared-fs", owner: uid}, true},
		{&mountEntry{fsType: "macfuse", source: "peerbit-shared-fs", owner: uid + 1}, false},
		{&mountEntry{fsType: "macfuse", source: "sshfs", owner: uid}, false},
		{&mountEntry{fsType: "apfs", source: "peerbit-shared-fs", owner: uid}, false},
		{nil, false},
	} {
		if got := system.ours(test.entry); got != test.want {
			t.Errorf("ours(%#v) = %v, want %v", test.entry, got, test.want)
		}
	}
	// The root volume is listed, and is not this adapter's.
	root, err := lookupDarwinMount("/")
	if err != nil || root == nil || root.fsType == "" {
		t.Fatalf("lookupDarwinMount(/) = %#v, %v", root, err)
	}
	if system.ours(root) {
		t.Fatalf("the root volume %#v counts as this adapter's mount", root)
	}
}
