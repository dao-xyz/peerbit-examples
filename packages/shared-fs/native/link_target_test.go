package main

import "testing"

func TestLinkRelativeTarget(t *testing.T) {
	for _, test := range []struct {
		link, target, want string
	}{
		// WinFsp creates a file link under a hidden name in the link's
		// directory before renaming it into place.
		{"/lp/.fuse_hidden0123456789abcdef", "/lp/dir", "dir"},
		{"/a/x/l", "/a/b/c", "../b/c"},
		{"/l", "/", "."},
		{"/a/b/l", "/", "../.."},
		{"/a/l", "/a", "."},
		{"/a/l", "/a/l", "l"},
		{"/a/b/l", "/a/b/c/d", "c/d"},
		{"/l", "/x/y", "x/y"},
		// Components compare whole: "/ab" is not below "/a".
		{"/ab/l", "/a/x", "../a/x"},
		// Absolute targets are cleaned first.
		{"/a/l", "//b//c/", "../b/c"},
		{"/a/l", "/a/./b/../c", "c"},
		// Relative and empty targets, and relative link paths, stay as given.
		{"/lp/l", "target.txt", "target.txt"},
		{"/a/l", "../x", "../x"},
		{"/a/l", "./x", "./x"},
		{"/a/l", "", ""},
		{"l", "/x", "/x"},
	} {
		if got := linkRelativeTarget(test.link, test.target); got != test.want {
			t.Errorf("linkRelativeTarget(%q, %q) = %q, want %q", test.link, test.target, got, test.want)
		}
	}
}

func TestSlashDotProbeOnlyOnWindows(t *testing.T) {
	for _, test := range []struct {
		goos, path string
		want       bool
	}{
		// WinFsp's mount-time probe, then one per symlink.
		{"windows", "/.", true},
		{"windows", "/lp/dir-link/.", true},
		{"windows", "/", false},
		{"windows", "/lp/dir-link", false},
		{"windows", "/lp/.fuse_hidden0123456789abcdef", false},
		{"windows", "/lp/..", false},
		{"linux", "/.", false},
		{"darwin", "/lp/dir-link/.", false},
	} {
		if got := slashDotProbe(test.goos, test.path); got != test.want {
			t.Errorf("slashDotProbe(%q, %q) = %v, want %v", test.goos, test.path, got, test.want)
		}
	}
}
