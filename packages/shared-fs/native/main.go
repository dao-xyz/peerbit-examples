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
	ipcConcurrency := flag.Int("ipc-concurrency", defaultIPCConcurrency, "number of independent native IPC connections (1-16)")
	flag.Parse()

	if *endpoint == "" || *mountpoint == "" {
		fmt.Fprintln(os.Stderr, "usage: peerbit-shared-fs-native --endpoint <endpoint> --mountpoint <mountpoint>")
		os.Exit(2)
	}
	if err := validateIPCConcurrency(*ipcConcurrency); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if err := runNativeMount(*endpoint, *mountpoint, *debug, *ipcConcurrency); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
