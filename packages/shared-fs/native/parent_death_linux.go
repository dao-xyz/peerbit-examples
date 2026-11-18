//go:build linux

package main

import (
	"os"
	"syscall"
)

// init runs on the main thread, which lives as long as the process: Linux
// keeps the parent-death signal per thread and drops it when that thread
// exits. The signal is SIGHUP, on which the adapter unmounts and exits
// (notifyHangup).
func init() {
	parentDeathNote, parentDeathErr = armParentDeath(os.Getenv(parentPIDEnv), setParentDeathSignal, os.Getppid)
}

func setParentDeathSignal() error {
	_, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_PDEATHSIG, uintptr(syscall.SIGHUP), 0)
	if errno != 0 {
		return errno
	}
	return nil
}
