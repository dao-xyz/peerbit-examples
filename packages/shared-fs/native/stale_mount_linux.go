//go:build linux

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// A FUSE mount whose process died answers ENOTCONN. /proc/self/mountinfo
// lists its type (fuse.<subtype>), source (fsname) and the user who mounted
// it (user_id), and fusermount, which mounted it, removes it.
func hostDeadMountSystem() deadMountSystem {
	return deadMountSystem{
		probe: func(path string) error {
			_, err := os.Stat(path)
			return err
		},
		disconnected: func(err error) bool { return errors.Is(err, syscall.ENOTCONN) },
		lookup:       lookupLinuxMount,
		fsTypes:      []string{"fuse." + nativeFSName},
		uid:          os.Getuid(),
		unmount:      fusermountUnmount,
		hint:         "fusermount3 -u",
	}
}

func lookupLinuxMount(path string) (*mountEntry, error) {
	target, err := mountTablePath(path)
	if err != nil {
		return nil, err
	}
	table, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	return findMountInfoEntry(string(table), target), nil
}

// findMountInfoEntry returns the last, so topmost, mount at target. A line
// is "id parent major:minor root mountpoint options [optional...] - type
// source superoptions", with space, tab, newline and backslash in a field
// written as octal escapes.
func findMountInfoEntry(table string, target string) *mountEntry {
	var found *mountEntry
	for _, line := range strings.Split(table, "\n") {
		fields := strings.Split(line, " ")
		separator := -1
		for index := 6; index < len(fields); index++ {
			if fields[index] == "-" {
				separator = index
				break
			}
		}
		if separator < 0 || len(fields) < separator+4 || unescapeMountInfo(fields[4]) != target {
			continue
		}
		found = &mountEntry{
			fsType: unescapeMountInfo(fields[separator+1]),
			source: unescapeMountInfo(fields[separator+2]),
			owner:  mountInfoOwner(fields[separator+3]),
		}
	}
	return found
}

func unescapeMountInfo(field string) string {
	if !strings.Contains(field, `\`) {
		return field
	}
	var unescaped strings.Builder
	for index := 0; index < len(field); index++ {
		if field[index] == '\\' && index+3 < len(field) {
			if value, err := strconv.ParseUint(field[index+1:index+4], 8, 8); err == nil {
				unescaped.WriteByte(byte(value))
				index += 3
				continue
			}
		}
		unescaped.WriteByte(field[index])
	}
	return unescaped.String()
}

// mountInfoOwner reads user_id, which the kernel lists for FUSE mounts.
func mountInfoOwner(superOptions string) int {
	for _, option := range strings.Split(superOptions, ",") {
		if value, ok := strings.CutPrefix(option, "user_id="); ok {
			if uid, err := strconv.Atoi(value); err == nil {
				return uid
			}
		}
	}
	return -1
}

// fallbackUnmount unmounts when cgofuse cannot. cgofuse runs fusermount, the
// FUSE 2 name, which an install of FUSE 3 alone may lack; this tries
// fusermount3 first.
func fallbackUnmount(path string) error {
	return fusermountUnmount(path)
}

// fusermountUnmount unmounts as fusermount3 does for its user, and lazily if
// a process still holds a file there: the mount is detached at once and
// released when the last such file is closed.
func fusermountUnmount(path string) error {
	command := "fusermount3"
	if _, err := exec.LookPath(command); err != nil {
		command = "fusermount"
	}
	output, err := exec.Command(command, "-u", path).CombinedOutput()
	if err == nil {
		return nil
	}
	lazyOutput, lazyErr := exec.Command(command, "-u", "-z", path).CombinedOutput()
	if lazyErr == nil {
		return nil
	}
	return fmt.Errorf("%s -u: %v (%s); %s -u -z: %v (%s)", command, err, strings.TrimSpace(string(output)), command, lazyErr, strings.TrimSpace(string(lazyOutput)))
}
