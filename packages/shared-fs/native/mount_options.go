package main

import "os"

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

// fuseTCacheOptions turn off the macOS NFS client's attribute cache for a
// FUSE-T mount. FUSE-T ignores libfuse's timeouts, and the NFS client's
// default (5 to 60 s) hid other peers' changes for up to 18 s in a two-mount
// probe and made concurrent appends overwrite each other; with this option
// both were exact. macFUSE's caching is unchanged.
const fuseTCacheOptions = "noattrcache"

// darwinLoadsFuseT reports whether cgofuse will load FUSE-T. cgofuse loads the
// first of macFUSE's libfuse.2.dylib, OSXFUSE's libosxfuse.2.dylib and
// FUSE-T's libfuse-t.dylib that exists (fuse/host_cgo.go), so a host with both
// runtimes mounts through macFUSE, which is not given FUSE-T's options.
func darwinLoadsFuseT(exists func(path string) bool) bool {
	for _, library := range []string{"/usr/local/lib/libfuse.2.dylib", "/usr/local/lib/libosxfuse.2.dylib"} {
		if exists(library) {
			return false
		}
	}
	return exists("/usr/local/lib/libfuse-t.dylib")
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// nativeMountOptions returns the cgofuse mount arguments before the
// mountpoint. macFUSE (through FUSE 2.8) keeps libfuse's defaults: names and
// attributes cached for 1 s, missing names never. FUSE-T serves the mount
// through a local NFS server, whose client caches what it chooses; fuseT turns
// its attribute cache off.
func nativeMountOptions(goos string, fuseT bool, debug bool) []string {
	options := []string{"-s"}
	switch goos {
	case "windows":
		// WinFsp derives a persistent ACL from uid/gid/mode. Shared-fs has no
		// portable ownership metadata, so absent uid/gid otherwise become 0.
		// Naming the mounting account as synthetic owner grants FILE_WRITE_EA,
		// which CreateFileW requests for normal CREATE_ALWAYS/open("w") calls.
		options = append(options, "-o", "uid=-1,gid=-1")
	case "linux":
		options = append(options, "-o", linuxKernelCacheOptions)
	case "darwin":
		if fuseT {
			options = append(options, "-o", fuseTCacheOptions)
		}
	}
	if debug {
		options = append(options, "-d")
	}
	return options
}
