package main

func nativeMountOptions(goos string, debug bool) []string {
	options := []string{"-s"}
	if goos == "windows" {
		// WinFsp derives a persistent ACL from uid/gid/mode. Shared-fs has no
		// portable ownership metadata, so absent uid/gid otherwise become 0.
		// Naming the mounting account as synthetic owner grants FILE_WRITE_EA,
		// which CreateFileW requests for normal CREATE_ALWAYS/open("w") calls.
		options = append(options, "-o", "uid=-1,gid=-1")
	}
	if debug {
		options = append(options, "-d")
	}
	return options
}
