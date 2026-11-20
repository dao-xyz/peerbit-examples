package main

import (
	"fmt"
	"io"
	"path/filepath"
	"strconv"
)

// nativeFSName names this adapter's mounts in the mount table: their source
// (fsname) and, on Linux, their type (fuse.peerbit-shared-fs). A mount that
// an adapter left disconnected when it died is recognised by it.
const nativeFSName = "peerbit-shared-fs"

// mountEntry is the topmost mount at a path, as the mount table lists it.
type mountEntry struct {
	fsType string
	source string
	// owner is the id of the user who mounted it, or -1 if not listed.
	owner int
}

// deadMountSystem is how clearDeadMount sees the host; tests replace it. The
// zero value, used where a mount cannot outlive its adapter (Windows), finds
// nothing to clear.
type deadMountSystem struct {
	// probe reaches path: nil for a directory or a live mount.
	probe func(path string) error
	// disconnected reports whether a probe error is what a FUSE mount answers
	// once the process serving it has died.
	disconnected func(err error) bool
	// lookup returns the topmost mount at path, or nil if none is listed.
	lookup func(path string) (*mountEntry, error)
	// fsTypes are the mount types this adapter's mounts have.
	fsTypes []string
	uid     int
	unmount func(path string) error
	// hint is the command that removes such a mount by hand.
	hint string
}

// clearDeadMount unmounts a mount at path that an earlier adapter of this
// user left disconnected when it died, so a new mount can take its place. It
// leaves alone a directory, a live mount and anything it cannot prove is such
// a mount, which it reports instead, since mounting there would fail anyway.
func clearDeadMount(path string, system deadMountSystem) (cleared bool, err error) {
	if system.probe == nil {
		return false, nil
	}
	reached := system.probe(path)
	if reached == nil || !system.disconnected(reached) {
		return false, nil
	}
	entry, err := system.lookup(path)
	if err != nil {
		return false, fmt.Errorf("%s is disconnected (%v) and the mount table could not be read: %w", path, reached, err)
	}
	if !system.ours(entry) {
		return false, fmt.Errorf("%s is disconnected (%v), but it is not a mount that a peerbit-fs adapter of this user left: %s. Unmount it (%s %s), then mount again", path, reached, describeMountEntry(entry), system.hint, path)
	}
	if err := system.unmount(path); err != nil {
		return false, fmt.Errorf("could not unmount the disconnected mount that an earlier adapter left at %s: %v. Unmount it (%s %s), then mount again", path, err, system.hint, path)
	}
	if reached := system.probe(path); reached != nil && system.disconnected(reached) {
		return false, fmt.Errorf("%s is still disconnected (%v) after unmounting the mount an earlier adapter left there. Unmount it (%s %s), then mount again", path, reached, system.hint, path)
	}
	return true, nil
}

// clearAndReportDeadMount clears path as clearDeadMount does and says on stderr
// when it unmounted something.
func clearAndReportDeadMount(path string, system deadMountSystem, stderr io.Writer) error {
	cleared, err := clearDeadMount(path, system)
	if cleared {
		fmt.Fprintf(stderr, "peerbit-shared-fs-native: unmounted the disconnected mount that an earlier adapter left at %s\n", path)
	}
	return err
}

// runClearDeadMount is --clear-dead-mount: peerbit-fs mount runs it after its
// adapter exited without unmounting, so the mountpoint is not left
// disconnected until the next mount there. It exits 0 when nothing is left to
// clear, and 1 when it reports a mount it may not or could not unmount.
func runClearDeadMount(path string, system deadMountSystem, stderr io.Writer) int {
	if err := clearAndReportDeadMount(path, system, stderr); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

func (system deadMountSystem) ours(entry *mountEntry) bool {
	if entry == nil || entry.source != nativeFSName || entry.owner != system.uid {
		return false
	}
	for _, fsType := range system.fsTypes {
		if entry.fsType == fsType {
			return true
		}
	}
	return false
}

func describeMountEntry(entry *mountEntry) string {
	if entry == nil {
		return "the mount table lists no mount there"
	}
	owner := "unknown"
	if entry.owner >= 0 {
		owner = strconv.Itoa(entry.owner)
	}
	return fmt.Sprintf("type %s, source %s, mounted by user %s", entry.fsType, entry.source, owner)
}

// mountTablePath is the path the mount table lists for path. Its last
// component is kept as given: resolving it would reach into the disconnected
// mount.
func mountTablePath(path string) (string, error) {
	path, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}
