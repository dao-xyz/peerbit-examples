package main

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

// nativeMountOptions returns the cgofuse mount arguments before the
// mountpoint. macOS (macFUSE through FUSE 2.8) keeps libfuse's defaults: names
// and attributes cached for 1 s, missing names never.
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
		options = append(options, "-o", linuxKernelCacheOptions)
	}
	if debug {
		options = append(options, "-d")
	}
	return options
}
