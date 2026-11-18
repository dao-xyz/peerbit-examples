//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// notifyHangup delivers SIGHUP, which a closed terminal sends and, on Linux,
// the kernel when peerbit-fs exits (parent_death_linux.go). Unhandled, it
// would end the adapter and leave the mount behind, disconnected. SIGINT and
// SIGTERM stay with cgofuse, which unmounts on them once mounted.
func notifyHangup(signals chan<- os.Signal) {
	signal.Notify(signals, syscall.SIGHUP)
}

// ignoreBrokenPipes keeps a write to stdout or stderr after peerbit-fs exited
// from ending the adapter with SIGPIPE before it unmounts: with SIGPIPE
// handled, the write fails with EPIPE instead.
func ignoreBrokenPipes() {
	signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE)
}
