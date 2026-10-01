package main

import (
	"path"
	"strings"
)

// linkRelativeTarget rewrites an absolute symlink target as the same path
// relative to the link's directory: a link "/a/x/l" to "/a/b/c" stores
// "../b/c". A relative target, or a link path that is not absolute, is
// returned as given.
//
// The Windows adapter applies it to every new link. WinFsp passes a target on
// the mount's own volume with its drive stripped ("P:\a\b" arrives as
// "/a/b"), and a rooted one ("\a\b") the same way, so both name a path from
// the mount root. Stored relative, such a link resolves inside every peer's
// mount, and WinFsp can read it back: it refuses absolute targets without
// the rellinks mount option. WinFsp creates a file link under a hidden name in
// the link's own directory and renames it into place, so the directory is
// the same.
func linkRelativeTarget(linkPath, target string) string {
	if !strings.HasPrefix(target, "/") || !strings.HasPrefix(linkPath, "/") {
		return target
	}
	from := pathComponents(path.Dir(path.Clean(linkPath)))
	to := pathComponents(path.Clean(target))
	common := 0
	for common < len(from) && common < len(to) && from[common] == to[common] {
		common++
	}
	parts := make([]string, 0, len(from)-common+len(to)-common)
	for range from[common:] {
		parts = append(parts, "..")
	}
	parts = append(parts, to[common:]...)
	if len(parts) == 0 {
		return "."
	}
	return strings.Join(parts, "/")
}

// pathComponents splits a clean absolute path; the root has none.
func pathComponents(clean string) []string {
	if clean == "/" {
		return nil
	}
	return strings.Split(clean[1:], "/")
}

// slashDotProbe reports whether getattr refuses path with ENOENT: on Windows,
// any path ending in "/.". When getattr("/.") at mount finds a directory,
// WinFsp's FUSE layer decides whether a symlink is a directory link by asking
// for "<link>/.". The backend drops "." segments without following the link,
// so that answer is the link itself and no link would get
// FILE_ATTRIBUTE_DIRECTORY. Refusing the probe makes WinFsp read each link and
// stat its target instead. Windows itself never sends "." segments.
func slashDotProbe(goos, path string) bool {
	return goos == "windows" && strings.HasSuffix(path, "/.")
}
