package main

import (
	"reflect"
	"testing"
)

func TestNativeMountOptionsUseTheMountingAccountOnWindows(t *testing.T) {
	tests := []struct {
		name  string
		goos  string
		debug bool
		width int
		want  []string
	}{
		{
			name:  "windows",
			goos:  "windows",
			width: 1,
			want:  []string{"-s", "-o", "uid=-1,gid=-1"},
		},
		{
			name:  "windows debug",
			goos:  "windows",
			debug: true,
			width: 1,
			want:  []string{"-s", "-o", "uid=-1,gid=-1", "-d"},
		},
		{name: "linux", goos: "linux", width: 1, want: []string{"-s"}},
		{name: "darwin", goos: "darwin", width: 1, want: []string{"-s"}},
		{name: "linux concurrent", goos: "linux", width: 4, want: []string{}},
		{name: "darwin concurrent debug", goos: "darwin", debug: true, width: 16, want: []string{"-d"}},
		{name: "windows concurrent", goos: "windows", width: 2, want: []string{"-o", "uid=-1,gid=-1"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeMountOptions(test.goos, test.debug, test.width); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("native mount options = %#v, want %#v", got, test.want)
			}
		})
	}
}
