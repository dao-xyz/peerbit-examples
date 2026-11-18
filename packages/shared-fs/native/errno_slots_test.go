package main

import (
	"runtime"
	"syscall"
	"testing"
)

// EDQUOT is 122 on Linux and 69 on macOS; Windows has none, so the adapter
// reports a quota as ENOSPC there.
func TestEDQUOTErrnoPerOS(t *testing.T) {
	for goos, want := range map[string]int{
		"linux":   122,
		"darwin":  69,
		"windows": 0,
	} {
		if got := edquotErrno(goos); got != want {
			t.Fatalf("edquotErrno(%q) = %d, want %d", goos, got, want)
		}
	}
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		if got, want := edquotErrno(runtime.GOOS), int(syscall.EDQUOT); got != want {
			t.Fatalf("edquotErrno(%q) = %d, but syscall.EDQUOT is %d", runtime.GOOS, got, want)
		}
	}
}
