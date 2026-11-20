//go:build !linux && !darwin

package main

import "errors"

// On Windows, WinFsp removes a mount when the process serving it exits, so
// no mount outlives its adapter.
func hostDeadMountSystem() deadMountSystem {
	return deadMountSystem{}
}

// fallbackUnmount has nothing to try where cgofuse's unmount (fuse_exit on
// Windows) did not succeed.
func fallbackUnmount(path string) error {
	_ = path
	return errors.New("the FUSE host could not unmount it")
}
