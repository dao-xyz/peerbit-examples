package main

import (
	"reflect"
	"testing"
)

func TestNativeMountOptionsPerPlatform(t *testing.T) {
	linuxCache := "entry_timeout=0.1,attr_timeout=0,negative_timeout=0"
	tests := []struct {
		name  string
		goos  string
		fuseT bool
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
		// missing names.
		{name: "linux", goos: "linux", want: []string{"-s", "-o", linuxCache}},
		{
			name:  "linux debug",
			goos:  "linux",
			debug: true,
			want:  []string{"-s", "-o", linuxCache, "-d"},
		},
		// macFUSE keeps libfuse's defaults; FUSE-T turns off the NFS client's
		// attribute cache.
		{name: "darwin macFUSE", goos: "darwin", want: []string{"-s"}},
		{name: "darwin macFUSE debug", goos: "darwin", debug: true, want: []string{"-s", "-d"}},
		{name: "darwin FUSE-T", goos: "darwin", fuseT: true, want: []string{"-s", "-o", "noattrcache"}},
		{
			name:  "darwin FUSE-T debug",
			goos:  "darwin",
			fuseT: true,
			debug: true,
			want:  []string{"-s", "-o", "noattrcache", "-d"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeMountOptions(test.goos, test.fuseT, test.debug); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("native mount options = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestDarwinLoadsFuseTFollowsCgofuseOrder(t *testing.T) {
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
	const macFUSE = "/usr/local/lib/libfuse.2.dylib"
	const osxFUSE = "/usr/local/lib/libosxfuse.2.dylib"
	const fuseT = "/usr/local/lib/libfuse-t.dylib"
	tests := []struct {
		name      string
		libraries []string
		want      bool
	}{
		{name: "FUSE-T only", libraries: []string{fuseT}, want: true},
		{name: "macFUSE only", libraries: []string{macFUSE}},
		{name: "OSXFUSE and FUSE-T", libraries: []string{osxFUSE, fuseT}},
		{name: "macFUSE and FUSE-T", libraries: []string{macFUSE, fuseT}},
		{name: "neither"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := darwinLoadsFuseT(installed(test.libraries...)); got != test.want {
				t.Fatalf("darwinLoadsFuseT = %v, want %v", got, test.want)
			}
		})
	}
}
