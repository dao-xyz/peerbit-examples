//go:build darwin

package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// mntNoWait is MNT_NOWAIT from <sys/mount.h>: getfsstat answers from the
// kernel's mount table without asking each filesystem, this one included, for
// fresh statistics.
const mntNoWait = 2

// mntForce is MNT_FORCE from <sys/mount.h>.
const mntForce = 0x80000

// macFUSE keeps a mount whose process died. Its root's attributes stay
// readable, so a stat cannot tell; opening it should fail with ENXIO, and
// ENOTCONN is taken too (neither is checked against macFUSE in CI yet).
// getfsstat lists its type (macfuse, osxfuse before macFUSE 4), source
// (fsname) and owner, and its owner may unmount it.
func hostDeadMountSystem() deadMountSystem {
	return deadMountSystem{
		probe: func(path string) error {
			fd, err := syscall.Open(path, syscall.O_RDONLY, 0)
			if err == nil {
				syscall.Close(fd)
			}
			return err
		},
		disconnected: func(err error) bool {
			return errors.Is(err, syscall.ENXIO) || errors.Is(err, syscall.ENOTCONN)
		},
		lookup:  lookupDarwinMount,
		fsTypes: []string{"macfuse", "osxfuse"},
		uid:     os.Getuid(),
		unmount: func(path string) error {
			err := syscall.Unmount(path, 0)
			if err == nil {
				return nil
			}
			if forced := syscall.Unmount(path, mntForce); forced != nil {
				return fmt.Errorf("unmount: %v; forced unmount: %v", err, forced)
			}
			return nil
		},
		hint: "diskutil unmount force",
	}
}

// fallbackUnmount unmounts when cgofuse could not.
func fallbackUnmount(path string) error {
	return syscall.Unmount(path, mntForce)
}

func lookupDarwinMount(path string) (*mountEntry, error) {
	target, err := mountTablePath(path)
	if err != nil {
		return nil, err
	}
	mounts, err := darwinMounts()
	if err != nil {
		return nil, err
	}
	var found *mountEntry
	for index := range mounts {
		if cString(mounts[index].Mntonname[:]) == target {
			found = &mountEntry{
				fsType: cString(mounts[index].Fstypename[:]),
				source: cString(mounts[index].Mntfromname[:]),
				owner:  int(mounts[index].Owner),
			}
		}
	}
	return found, nil
}

// darwinMounts reads the kernel's mount table.
func darwinMounts() ([]syscall.Statfs_t, error) {
	for {
		count, err := syscall.Getfsstat(nil, mntNoWait)
		if err != nil {
			return nil, fmt.Errorf("getfsstat: %w", err)
		}
		// Leave room for mounts added between the two calls; a full buffer
		// means the table grew past it, so read it again.
		mounts := make([]syscall.Statfs_t, count+8)
		n, err := syscall.Getfsstat(mounts, mntNoWait)
		if err != nil {
			return nil, fmt.Errorf("getfsstat: %w", err)
		}
		if n < len(mounts) {
			return mounts[:n], nil
		}
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
