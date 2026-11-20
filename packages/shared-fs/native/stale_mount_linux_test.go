//go:build linux

package main

import (
	"reflect"
	"syscall"
	"testing"
)

func TestFindMountInfoEntry(t *testing.T) {
	// Lines as the kernel writes them: optional fields before the separator,
	// octal escapes in paths, and a later mount at a path over an earlier one.
	table := "" +
		"22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:5 - proc proc rw\n" +
		"40 22 0:35 / /home/me/mnt rw,nosuid,nodev,relatime shared:20 - ext4 /dev/sda1 rw\n" +
		"41 40 0:36 / /home/me/mnt rw,nosuid,nodev,relatime shared:21 master:3 - fuse.peerbit-shared-fs peerbit-shared-fs rw,user_id=1000,group_id=1000\n" +
		"42 22 0:37 / /home/me/my\\040mount rw,relatime - fuse.sshfs me@host:/srv rw,user_id=1001,group_id=1001\n" +
		"43 22 0:38 / /home/me/plain rw,relatime - tmpfs tmpfs rw\n" +
		"malformed line\n"
	tests := []struct {
		target string
		want   *mountEntry
	}{
		{"/home/me/mnt", &mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: 1000}},
		{"/home/me/my mount", &mountEntry{fsType: "fuse.sshfs", source: "me@host:/srv", owner: 1001}},
		{"/home/me/plain", &mountEntry{fsType: "tmpfs", source: "tmpfs", owner: -1}},
		{"/home/me/missing", nil},
	}
	for _, test := range tests {
		if got := findMountInfoEntry(table, test.target); !reflect.DeepEqual(got, test.want) {
			t.Errorf("findMountInfoEntry(%q) = %#v, want %#v", test.target, got, test.want)
		}
	}
}

func TestUnescapeMountInfo(t *testing.T) {
	for escaped, want := range map[string]string{
		`/plain`:              "/plain",
		`/a\040b`:             "/a b",
		`/tab\011newline\012`: "/tab\tnewline\n",
		`/back\134slash`:      `/back\slash`,
		`/not\9octal`:         `/not\9octal`,
		`/short\04`:           `/short\04`,
	} {
		if got := unescapeMountInfo(escaped); got != want {
			t.Errorf("unescapeMountInfo(%q) = %q, want %q", escaped, got, want)
		}
	}
}

// The adapter's own mounts are the ones the host system recognises.
func TestLinuxDeadMountSystemRecognisesOnlyThisAdaptersMounts(t *testing.T) {
	system := hostDeadMountSystem()
	uid := system.uid
	if !system.disconnected(syscall.ENOTCONN) || system.disconnected(syscall.ENOENT) {
		t.Fatal("only ENOTCONN marks a disconnected FUSE mount on Linux")
	}
	for _, test := range []struct {
		entry *mountEntry
		want  bool
	}{
		{&mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: uid}, true},
		{&mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: uid + 1}, false},
		{&mountEntry{fsType: "fuse", source: "peerbit-shared-fs", owner: uid}, false},
		{&mountEntry{fsType: "fuse.peerbit-shared-fs", source: "sshfs", owner: uid}, false},
		{nil, false},
	} {
		if got := system.ours(test.entry); got != test.want {
			t.Errorf("ours(%#v) = %v, want %v", test.entry, got, test.want)
		}
	}
	root, err := lookupLinuxMount("/")
	if err != nil || root == nil {
		t.Fatalf("lookupLinuxMount(/) = %#v, %v", root, err)
	}
}
