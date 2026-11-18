package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

var errTestDisconnected = errors.New("transport endpoint is not connected")

// fakeDeadMountHost is a mountpoint as clearDeadMount sees it, recording what
// it is asked to do.
type fakeDeadMountHost struct {
	probes    []error
	entry     *mountEntry
	lookupErr error
	unmounted error
	calls     []string
}

func (host *fakeDeadMountHost) system() deadMountSystem {
	return deadMountSystem{
		probe: func(path string) error {
			host.calls = append(host.calls, "probe")
			probe := host.probes[0]
			if len(host.probes) > 1 {
				host.probes = host.probes[1:]
			}
			return probe
		},
		disconnected: func(err error) bool { return errors.Is(err, errTestDisconnected) },
		lookup: func(path string) (*mountEntry, error) {
			host.calls = append(host.calls, "lookup")
			return host.entry, host.lookupErr
		},
		fsTypes: []string{"fuse.peerbit-shared-fs"},
		uid:     1000,
		unmount: func(path string) error {
			host.calls = append(host.calls, "unmount")
			return host.unmounted
		},
		hint: "fusermount3 -u",
	}
}

func TestClearDeadMount(t *testing.T) {
	ours := &mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: 1000}
	tests := []struct {
		name    string
		host    fakeDeadMountHost
		cleared bool
		// want is a fragment of the error, empty for none.
		want  []string
		calls []string
	}{
		{
			name:  "a directory or a live mount is left alone",
			host:  fakeDeadMountHost{probes: []error{nil}},
			calls: []string{"probe"},
		},
		{
			// Mounting reports a missing mountpoint itself.
			name:  "another error is left to the mount",
			host:  fakeDeadMountHost{probes: []error{os.ErrNotExist}},
			calls: []string{"probe"},
		},
		{
			name:    "a disconnected mount an adapter of this user left is unmounted",
			host:    fakeDeadMountHost{probes: []error{errTestDisconnected, nil}, entry: ours},
			cleared: true,
			calls:   []string{"probe", "lookup", "unmount", "probe"},
		},
		{
			name:  "another filesystem's disconnected mount is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: &mountEntry{fsType: "fuse.sshfs", source: "peerbit-shared-fs", owner: 1000}},
			want:  []string{"is disconnected (transport endpoint is not connected), but it is not a mount that a peerbit-fs adapter of this user left: type fuse.sshfs, source peerbit-shared-fs, mounted by user 1000", "Unmount it (fusermount3 -u /mnt/peerbit), then mount again"},
			calls: []string{"probe", "lookup"},
		},
		{
			name:  "a mount from another source is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: &mountEntry{fsType: "fuse.peerbit-shared-fs", source: "other", owner: 1000}},
			want:  []string{"type fuse.peerbit-shared-fs, source other, mounted by user 1000"},
			calls: []string{"probe", "lookup"},
		},
		{
			name:  "another user's mount is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: &mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: 0}},
			want:  []string{"mounted by user 0"},
			calls: []string{"probe", "lookup"},
		},
		{
			name:  "a mount without a listed owner is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: &mountEntry{fsType: "fuse.peerbit-shared-fs", source: "peerbit-shared-fs", owner: -1}},
			want:  []string{"mounted by user unknown"},
			calls: []string{"probe", "lookup"},
		},
		{
			// For example, the disconnected mount is a parent directory.
			name:  "a path the mount table does not list is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}},
			want:  []string{"the mount table lists no mount there"},
			calls: []string{"probe", "lookup"},
		},
		{
			name:  "an unreadable mount table is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, lookupErr: errors.New("permission denied")},
			want:  []string{"the mount table could not be read: permission denied"},
			calls: []string{"probe", "lookup"},
		},
		{
			name:  "a failed unmount is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: ours, unmounted: errors.New("fusermount3: busy")},
			want:  []string{"could not unmount the disconnected mount that an earlier adapter left at /mnt/peerbit: fusermount3: busy", "fusermount3 -u /mnt/peerbit"},
			calls: []string{"probe", "lookup", "unmount"},
		},
		{
			name:  "a mount still disconnected after unmounting is reported",
			host:  fakeDeadMountHost{probes: []error{errTestDisconnected}, entry: ours},
			want:  []string{"is still disconnected (transport endpoint is not connected) after unmounting"},
			calls: []string{"probe", "lookup", "unmount", "probe"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			host := test.host
			cleared, err := clearDeadMount("/mnt/peerbit", host.system())
			if cleared != test.cleared {
				t.Fatalf("cleared = %v, want %v", cleared, test.cleared)
			}
			if (err == nil) != (len(test.want) == 0) {
				t.Fatalf("clearDeadMount error = %v, want %q", err, test.want)
			}
			for _, fragment := range test.want {
				if !strings.Contains(err.Error(), fragment) {
					t.Fatalf("clearDeadMount error %q does not contain %q", err, fragment)
				}
			}
			if !reflect.DeepEqual(host.calls, test.calls) {
				t.Fatalf("calls = %v, want %v", host.calls, test.calls)
			}
		})
	}
}

// Windows has nothing to clear: no mount outlives its adapter there.
func TestClearDeadMountWithoutAHostSystemDoesNothing(t *testing.T) {
	if cleared, err := clearDeadMount("/mnt/peerbit", deadMountSystem{}); cleared || err != nil {
		t.Fatalf("clearDeadMount = %v, %v", cleared, err)
	}
}

// The mount table lists resolved paths, but resolving the mountpoint itself
// would reach into a disconnected mount: only its parent is resolved.
func TestMountTablePathResolvesOnlyTheParent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("WinFsp mounts drives; no mount table is read on Windows")
	}
	directory := t.TempDir()
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(resolved, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	got, err := mountTablePath(filepath.Join(link, "mnt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(resolved, "mnt"); got != want {
		t.Fatalf("mountTablePath = %q, want %q", got, want)
	}
}

// The host system leaves a plain directory alone.
func TestHostDeadMountSystemLeavesADirectoryAlone(t *testing.T) {
	if cleared, err := clearDeadMount(t.TempDir(), hostDeadMountSystem()); cleared || err != nil {
		t.Fatalf("clearDeadMount = %v, %v", cleared, err)
	}
}
