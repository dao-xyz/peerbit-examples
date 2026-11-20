//go:build native_mount && !darwin && !windows

package main

// mountWatcher is a no-op on Linux: libfuse calls Init only once the kernel
// has attached the mount. macOS and Windows have their own.
type mountWatcher struct{}

func newMountWatcher(mountpoint string) (*mountWatcher, error) {
	_ = mountpoint
	return nil, nil
}

func (w *mountWatcher) wait() error {
	return nil
}
