package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestNativeMountOptionsPerPlatform(t *testing.T) {
	linuxCache := "entry_timeout=0.1,attr_timeout=0,negative_timeout=0"
	linuxName := "fsname=peerbit-shared-fs,subtype=peerbit-shared-fs"
	tests := []struct {
		name  string
		goos  string
		debug bool
		want  []string
	}{
		{
			name: "windows",
			goos: "windows",
			want: []string{"-s", "-o", "uid=-1,gid=-1"},
		},
		{
			name:  "windows debug",
			goos:  "windows",
			debug: true,
			want:  []string{"-s", "-o", "uid=-1,gid=-1", "-d"},
		},
		// The Linux kernel caches names for 0.1 s, never attributes or
		// missing names. The mount table lists the mount as
		// "peerbit-shared-fs" of type fuse.peerbit-shared-fs.
		{name: "linux", goos: "linux", want: []string{"-s", "-o", linuxCache, "-o", linuxName}},
		{
			name:  "linux debug",
			goos:  "linux",
			debug: true,
			want:  []string{"-s", "-o", linuxCache, "-o", linuxName, "-d"},
		},
		// macFUSE keeps libfuse's defaults; the mount's source is named.
		{name: "darwin", goos: "darwin", want: []string{"-s", "-o", "fsname=peerbit-shared-fs"}},
		{name: "darwin debug", goos: "darwin", debug: true, want: []string{"-s", "-o", "fsname=peerbit-shared-fs", "-d"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeMountOptions(test.goos, test.debug); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("native mount options = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestNativeRuntimeErrorRefusesOnlyFuseT(t *testing.T) {
	installed := func(libraries ...string) func(string) bool {
		return func(path string) bool {
			for _, library := range libraries {
				if library == path {
					return true
				}
			}
			return false
		}
	}
	// The paths cgofuse dlopens on macOS, in its order.
	const macFUSE = "/usr/local/lib/libfuse.2.dylib"
	const osxFUSE = "/usr/local/lib/libosxfuse.2.dylib"
	const fuseT = "/usr/local/lib/libfuse-t.dylib"
	tests := []struct {
		name      string
		goos      string
		libraries []string
		want      error
	}{
		{name: "macFUSE only", goos: "darwin", libraries: []string{macFUSE}},
		{name: "OSXFUSE only", goos: "darwin", libraries: []string{osxFUSE}},
		{name: "FUSE-T only", goos: "darwin", libraries: []string{fuseT}, want: errFuseTUnsupported},
		// cgofuse loads macFUSE first, so FUSE-T stays unused.
		{name: "macFUSE and FUSE-T", goos: "darwin", libraries: []string{macFUSE, fuseT}},
		{name: "OSXFUSE and FUSE-T", goos: "darwin", libraries: []string{osxFUSE, fuseT}},
		// cgofuse reports that it cannot find FUSE.
		{name: "none", goos: "darwin"},
		// Only macOS loads these libraries.
		{name: "linux", goos: "linux", libraries: []string{fuseT}},
		{name: "windows", goos: "windows", libraries: []string{fuseT}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeRuntimeError(test.goos, installed(test.libraries...)); got != test.want {
				t.Fatalf("nativeRuntimeError = %v, want %v", got, test.want)
			}
		})
	}
}

func TestFuseTRefusalNamesTheFixAndTheCheckedLibraries(t *testing.T) {
	message := errFuseTUnsupported.Error()
	for _, want := range []string{
		"FUSE-T is not supported",
		"install macFUSE",
		"/usr/local/lib/libfuse.2.dylib",
		"/usr/local/lib/libosxfuse.2.dylib",
		"/usr/local/lib/libfuse-t.dylib",
	} {
		if !strings.Contains(message, want) {
			t.Errorf("FUSE-T refusal %q does not mention %q", message, want)
		}
	}
}
