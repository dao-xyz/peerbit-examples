//go:build native_mount && windows

package main

import (
	"bytes"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

var procDefineDosDeviceW = kernel32Procs.NewProc("DefineDosDeviceW")

const (
	dddRemoveDefinition   = 0x2
	dddExactMatchOnRemove = 0x4
)

// freeDrive returns a drive letter that nothing defines, from Z: down.
func freeDrive(t *testing.T) string {
	t.Helper()
	for letter := 'Z'; letter >= 'D'; letter-- {
		drive := string(letter) + ":"
		defined, err := windowsDrives{}.defined(drive)
		if err != nil {
			t.Fatal(err)
		}
		if !defined {
			return drive
		}
	}
	t.Skip("no free drive letter from D: to Z:")
	return ""
}

// defineDrive maps drive to target the way subst does. DefineDosDevice
// broadcasts the arrival as it does for the drive WinFsp defines.
func defineDrive(t *testing.T, drive, target string) {
	t.Helper()
	name, _ := syscall.UTF16PtrFromString(drive)
	path, _ := syscall.UTF16PtrFromString(target)
	if ok, _, err := procDefineDosDeviceW.Call(0, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(path))); uint32(ok) == 0 {
		t.Fatalf("DefineDosDeviceW(%s, %s): %v", drive, target, err)
	}
	t.Cleanup(func() {
		flags := uintptr(dddRemoveDefinition | dddExactMatchOnRemove)
		if ok, _, err := procDefineDosDeviceW.Call(flags, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(path))); uint32(ok) == 0 {
			t.Errorf("remove %s: %v", drive, err)
		}
	})
}

func TestMountWatcherWaitsForADriveLetter(t *testing.T) {
	drive := freeDrive(t)
	limit := driveWaitLimit
	driveWaitLimit = 100 * time.Millisecond
	t.Cleanup(func() { driveWaitLimit = limit })
	watcher, err := newMountWatcher(drive)
	if err != nil {
		t.Fatal(err)
	}
	if err := watcher.wait(); err == nil || err.Error() != "drive "+drive+" was not defined within 100ms" {
		t.Fatalf("wait() = %v for %s, which nothing defines; want it to give up", err, drive)
	}

	defineDrive(t, drive, t.TempDir())
	if watcher, err = newMountWatcher(drive); err != nil {
		t.Fatal(err)
	}
	if err := watcher.wait(); err != nil {
		t.Fatalf("wait() = %v for %s, which is defined", err, drive)
	}

	// A directory mountpoint is not waited for.
	if watcher, err = newMountWatcher(t.TempDir()); err != nil || watcher != nil {
		t.Fatalf("newMountWatcher(directory) = %v, %v; want no watcher", watcher, err)
	}
}

// checkingDrives sends each answer of the host's table on checks.
type checkingDrives struct {
	windowsDrives
	checks chan bool
}

func (d checkingDrives) defined(drive string) (bool, error) {
	defined, err := d.windowsDrives.defined(drive)
	d.checks <- defined
	return defined, err
}

func TestWindowsDrivesHearTheArrivalDefineDosDeviceBroadcasts(t *testing.T) {
	drive := freeDrive(t)
	drives := checkingDrives{checks: make(chan bool, 16)}
	watcher, err := newDriveWatcher(drive, drives, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// Only an arrival can end this wait: the deadline is the test's.
	deadline := make(chan time.Time, 1)
	watcher.after = func(time.Duration) <-chan time.Time { return deadline }
	var notes bytes.Buffer
	watcher.log = &notes
	done := make(chan error, 1)
	go func() { done <- watcher.wait() }()
	finished := false
	t.Cleanup(func() {
		if !finished {
			deadline <- time.Time{}
			<-done
		}
	})
	select {
	case defined := <-drives.checks:
		if defined {
			t.Fatalf("%s is defined before the test defines it", drive)
		}
	case <-time.After(patience):
		t.Fatalf("the wait did not look for %s within %s", drive, patience)
	}

	defineDrive(t, drive, t.TempDir())
	select {
	case err := <-done:
		finished = true
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(patience):
		t.Fatalf("no arrival notice for %s reached the watcher within %s", drive, patience)
	}
	if notes.Len() != 0 {
		t.Fatalf("notes = %q; want none", notes.String())
	}
	// The wait checked again on each arrival and returned on the check that
	// found the drive.
	last := false
	for len(drives.checks) > 0 {
		last = <-drives.checks
	}
	if !last {
		t.Fatalf("the wait returned without a check that found %s", drive)
	}
}
