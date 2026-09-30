//go:build !native_mount

package main

import "fmt"

func runNativeMount(endpoint, mountpoint, token string, debug bool, profile *mountProfiler) error {
	_ = endpoint
	_ = mountpoint
	_ = token
	_ = debug
	_ = profile
	return fmt.Errorf("native mount support was not built; rebuild with -tags native_mount")
}
