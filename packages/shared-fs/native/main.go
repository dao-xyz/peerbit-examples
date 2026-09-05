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
	profile := flag.Bool("profile", false, "emit mount-path profile events as NDJSON on stderr")
	flag.Parse()

	if *endpoint == "" || *mountpoint == "" {
		fmt.Fprintln(os.Stderr, "usage: peerbit-shared-fs-native --endpoint <endpoint> --mountpoint <mountpoint>")
		os.Exit(2)
	}

	var profiler *mountProfiler
	if *profile {
		profiler = newMountProfiler(os.Stderr)
	}
	if err := runNativeMount(*endpoint, *mountpoint, *debug, profiler); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
