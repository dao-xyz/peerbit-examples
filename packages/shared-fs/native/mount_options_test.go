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
		// macOS keeps macFUSE's defaults.
		{name: "darwin", goos: "darwin", want: []string{"-s"}},
		{name: "darwin debug", goos: "darwin", debug: true, want: []string{"-s", "-d"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeMountOptions(test.goos, test.debug); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("native mount options = %#v, want %#v", got, test.want)
			}
		})
	}
}
