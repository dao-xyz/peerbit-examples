//go:build windows

package main

import "os"

// Windows sends no hangup: peerbit-fs stops the adapter by terminating it,
// and WinFsp removes the mount of a process that exited. A broken pipe fails
// the write without ending the process.
func notifyHangup(signals chan<- os.Signal) {
	_ = signals
}

func ignoreBrokenPipes() {}
