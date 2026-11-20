package main

import (
	"errors"
	"os"
)

// linuxKernelCacheOptions bound what the Linux kernel caches for the mount:
// a name's binding to a file for at most 0.1 s, attributes never, and
// missing names never. A short name cache removes the per-component LOOKUP
// that every path syscall otherwise costs; git re-resolves the same
// directories in bursts of a few milliseconds, so 0.1 s keeps nearly all of
// a 1 s cache's gain with a tenth of its window. Attributes stay uncached so
// every stat sees other peers' changes. Open answers ESTALE for a name that a
// stale binding still shows (see openErrno).
//
// These options take effect only because go.mod replaces cgofuse with a fork
// that no longer clears libfuse's parsed config at FUSE 3 init. Without the
// fork every timeout is 0; without these options the fork would give libfuse's
// defaults of 1 s for names and attributes. Keep both together.
const linuxKernelCacheOptions = "entry_timeout=0.1,attr_timeout=0,negative_timeout=0"

// The macOS libraries cgofuse tries, in its order (fuse/host_cgo.go). It loads
// the first that exists, so a Mac with both macFUSE and FUSE-T mounts through
// macFUSE.
const (
	macFUSELibrary = "/usr/local/lib/libfuse.2.dylib"    // macFUSE 4 and later
	osxFUSELibrary = "/usr/local/lib/libosxfuse.2.dylib" // OSXFUSE, macFUSE 3
	fuseTLibrary   = "/usr/local/lib/libfuse-t.dylib"
)

// errFuseTUnsupported is the adapter's startup error on a Mac where cgofuse
// would load FUSE-T. peerbit-fs mount refuses with the same text before it
// opens the filesystem (library/src/native-mount-runtime.ts).
var errFuseTUnsupported = errors.New("FUSE-T is not supported: install macFUSE (brew install --cask macfuse) to mount on macOS; FUSE-T can stay installed. Found FUSE-T's /usr/local/lib/libfuse-t.dylib but not macFUSE's /usr/local/lib/libfuse.2.dylib or /usr/local/lib/libosxfuse.2.dylib.")

// nativeRuntimeError refuses, before anything is mounted, a Mac where cgofuse
// would load FUSE-T: shared-fs CI does not test FUSE-T, and its license allows
// non-commercial use only, so macOS mounts go through macFUSE alone. A Mac
// with neither runtime is left to cgofuse, which reports that it cannot find
// FUSE.
func nativeRuntimeError(goos string, exists func(path string) bool) error {
	if goos != "darwin" || exists(macFUSELibrary) || exists(osxFUSELibrary) || !exists(fuseTLibrary) {
		return nil
	}
	return errFuseTUnsupported
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// nativeMountOptions returns the cgofuse mount arguments before the
// mountpoint. macFUSE (through FUSE 2.8) keeps libfuse's defaults: names and
// attributes cached for 1 s, missing names never. On Linux and macOS the
// mount table names the mount after nativeFSName, by which a mount left
// disconnected is recognised (clearDeadMount).
func nativeMountOptions(goos string, debug bool) []string {
	options := []string{"-s"}
	switch goos {
	case "windows":
		// WinFsp derives a persistent ACL from uid/gid/mode. Shared-fs has no
		// portable ownership metadata, so absent uid/gid otherwise become 0.
		// Naming the mounting account as synthetic owner grants FILE_WRITE_EA,
		// which CreateFileW requests for normal CREATE_ALWAYS/open("w") calls.
		options = append(options, "-o", "uid=-1,gid=-1")
	case "linux":
		options = append(options, "-o", linuxKernelCacheOptions, "-o", "fsname="+nativeFSName+",subtype="+nativeFSName)
	case "darwin":
		options = append(options, "-o", "fsname="+nativeFSName)
	}
	if debug {
		options = append(options, "-d")
	}
	return options
}
