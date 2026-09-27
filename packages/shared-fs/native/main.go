package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	endpoint := flag.String("endpoint", "", "shared-fs IPC endpoint")
	mountpoint := flag.String("mountpoint", "", "native mountpoint")
	debug := flag.Bool("debug", false, "enable native adapter debug output")
	flag.Parse()

	if *endpoint == "" || *mountpoint == "" {
		fmt.Fprintln(os.Stderr, "usage: peerbit-shared-fs-native --endpoint <endpoint> --mountpoint <mountpoint>")
		os.Exit(2)
	}

	// Opt-in profiling is configured through the environment so a CLI that
	// requests it cannot break an adapter built before profiling existed.
	profiler := openMountProfilerFromEnv(os.Getenv, os.Stderr)
	err := runNativeMount(*endpoint, *mountpoint, *debug, profiler)
	// The mount's Init already holds shutdown signals while profiling; this
	// also covers a mount that failed before Init. close is bounded.
	profiler.holdShutdownSignals()
	profiler.close()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
