//go:build native_mount && !darwin

package main

// mountWatcher is a no-op outside macOS: Linux FUSE and WinFsp call Init only
// once the mount is attached.
type mountWatcher struct{}

func newMountWatcher(mountpoint string) (*mountWatcher, error) {
	_ = mountpoint
	return nil, nil
}

func (w *mountWatcher) wait() error {
	return nil
}
