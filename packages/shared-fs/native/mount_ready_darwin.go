//go:build native_mount && darwin

package main

import (
	"fmt"
	"path/filepath"
	"syscall"
)

// mntNoWait is MNT_NOWAIT from <sys/mount.h>: getfsstat answers from the
// kernel's mount table without asking each filesystem, this one included, for
// fresh statistics.
const mntNoWait = 2

// mountWatcher reports when the mountpoint is attached. FUSE-T calls Init from
// its NFS server before macOS attaches the NFS mount, so a ready line written
// from Init alone can precede the mount; macFUSE's Init follows the kernel
// mount, so its wait returns at once. The watcher subscribes to the kernel's
// filesystem events (EVFILT_FS, which posts VQ_MOUNT for every new mount)
// before it reads the mount table, so a mount between the two is never
// missed, and it rereads the table only when an event arrives.
type mountWatcher struct {
	kq   int
	path string
}

// newMountWatcher must run before the mount: resolving the mountpoint after it
// is attached would call into this filesystem.
func newMountWatcher(mountpoint string) (*mountWatcher, error) {
	path, err := filepath.Abs(mountpoint)
	if err != nil {
		return nil, err
	}
	if path, err = filepath.EvalSymlinks(path); err != nil {
		return nil, err
	}
	kq, err := syscall.Kqueue()
	if err != nil {
		return nil, fmt.Errorf("kqueue: %w", err)
	}
	change := syscall.Kevent_t{Filter: syscall.EVFILT_FS, Flags: syscall.EV_ADD | syscall.EV_CLEAR}
	if _, err := syscall.Kevent(kq, []syscall.Kevent_t{change}, nil, nil); err != nil {
		syscall.Close(kq)
		return nil, fmt.Errorf("register filesystem events: %w", err)
	}
	return &mountWatcher{kq: kq, path: path}, nil
}

// wait blocks until a filesystem is mounted at the watched path.
func (w *mountWatcher) wait() error {
	defer syscall.Close(w.kq)
	events := make([]syscall.Kevent_t, 8)
	for {
		mounted, err := isMountedAt(w.path)
		if err != nil {
			return err
		}
		if mounted {
			return nil
		}
		if _, err := syscall.Kevent(w.kq, nil, events, nil); err != nil && err != syscall.EINTR {
			return fmt.Errorf("wait for filesystem events: %w", err)
		}
	}
}

func isMountedAt(path string) (bool, error) {
	for {
		count, err := syscall.Getfsstat(nil, mntNoWait)
		if err != nil {
			return false, fmt.Errorf("getfsstat: %w", err)
		}
		// Leave room for mounts added between the two calls; a full buffer
		// means the table grew past it, so read it again.
		mounts := make([]syscall.Statfs_t, count+8)
		n, err := syscall.Getfsstat(mounts, mntNoWait)
		if err != nil {
			return false, fmt.Errorf("getfsstat: %w", err)
		}
		if n == len(mounts) {
			continue
		}
		for i := range mounts[:n] {
			if cString(mounts[i].Mntonname[:]) == path {
				return true, nil
			}
		}
		return false, nil
	}
}

func cString(value []int8) string {
	bytes := make([]byte, 0, len(value))
	for _, c := range value {
		if c == 0 {
			break
		}
		bytes = append(bytes, byte(c))
	}
	return string(bytes)
}
