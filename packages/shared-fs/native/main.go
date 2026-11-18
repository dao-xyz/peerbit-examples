package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	// A write to stdout or stderr after peerbit-fs exited must fail, not end
	// the adapter before it unmounts.
	ignoreBrokenPipes()
	endpoint := flag.String("endpoint", "", "shared-fs IPC endpoint")
	mountpoint := flag.String("mountpoint", "", "native mountpoint")
	debug := flag.Bool("debug", false, "enable native adapter debug output")
	flag.Parse()

	if *endpoint == "" || *mountpoint == "" {
		fmt.Fprintln(os.Stderr, "usage: PEERBIT_SHARED_FS_IPC_TOKEN=<token> peerbit-shared-fs-native --endpoint <endpoint> --mountpoint <mountpoint>")
		os.Exit(2)
	}
	// Set on Linux before main runs (parent_death_linux.go).
	if parentDeathErr != nil {
		fmt.Fprintf(os.Stderr, "peerbit-shared-fs-native: %v\n", parentDeathErr)
		os.Exit(1)
	}
	if parentDeathNote != "" {
		fmt.Fprintf(os.Stderr, "peerbit-shared-fs-native: %s\n", parentDeathNote)
	}

	// The CLI passes the IPC token in the environment, which other users
	// cannot read. Unset it, and the parent's process id, so nothing the
	// adapter starts, such as a mount helper, inherits them.
	token := os.Getenv(ipcTokenEnv)
	_ = os.Unsetenv(ipcTokenEnv)
	_ = os.Unsetenv(parentPIDEnv)
	// Opt-in profiling is configured through the environment so a CLI that
	// requests it cannot break an adapter built before profiling existed.
	profiler := openMountProfilerFromEnv(os.Getenv, os.Stderr)
	err := runNativeMount(*endpoint, *mountpoint, token, *debug, profiler)
	// The mount's Init already holds shutdown signals while profiling; this
	// also covers a mount that failed before Init. close is bounded.
	profiler.holdShutdownSignals()
	profiler.close()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
