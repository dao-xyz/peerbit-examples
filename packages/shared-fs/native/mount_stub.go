//go:build !native_mount

package main

import "fmt"

func runNativeMount(endpoint string, mountpoint string, debug bool, profile *mountProfiler) error {
	_ = endpoint
	_ = mountpoint
	_ = debug
	_ = profile
	return fmt.Errorf("native mount support was not built; rebuild with -tags native_mount")
}
