//go:build !windows

package main

import (
	"io"
	"os"
	"syscall"
	"testing"
)

// While a profiler holds shutdown signals, SIGINT is delivered to its channel
// instead of running Go's default action (process exit). If registration were
// missing, this test process would terminate here.
func TestProfilerHoldsShutdownSignalsUntilClose(t *testing.T) {
	profile := newMountProfiler(io.Discard, 4)
	profile.holdShutdownSignals()
	profile.holdShutdownSignals()
	if err := syscall.Kill(os.Getpid(), syscall.SIGINT); err != nil {
		t.Fatal(err)
	}
	if received := <-profile.signals; received != os.Interrupt {
		t.Fatalf("received %v, want interrupt", received)
	}
	profile.close()

	var disabled *mountProfiler
	disabled.holdShutdownSignals()
	disabled.close()
}
