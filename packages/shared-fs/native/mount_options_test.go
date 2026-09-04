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
		{name: "linux", goos: "linux", want: []string{"-s"}},
		{name: "darwin", goos: "darwin", want: []string{"-s"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := nativeMountOptions(test.goos, test.debug); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("native mount options = %#v, want %#v", got, test.want)
			}
		})
	}
}
