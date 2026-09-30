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
		fmt.Fprintln(os.Stderr, "usage: PEERBIT_SHARED_FS_IPC_TOKEN=<token> peerbit-shared-fs-native --endpoint <endpoint> --mountpoint <mountpoint>")
		os.Exit(2)
	}

	// The CLI passes the IPC token in the environment, which other users
	// cannot read. Unset it so nothing the adapter starts, such as a mount
	// helper, inherits it.
	token := os.Getenv(ipcTokenEnv)
	_ = os.Unsetenv(ipcTokenEnv)
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
