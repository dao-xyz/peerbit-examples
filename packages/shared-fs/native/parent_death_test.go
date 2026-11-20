package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestArmParentDeath(t *testing.T) {
	failed := errors.New("prctl failed")
	tests := []struct {
		name      string
		expected  string
		setSignal error
		parent    int
		want      string
		note      string
		calls     []string
	}{
		// Started by hand, not by peerbit-fs: nothing to watch.
		{name: "no parent named", expected: "", calls: nil},
		{name: "parent alive", expected: "4242", parent: 4242, calls: []string{"setSignal", "getppid"}},
		// A wrapper that did not exec the adapter, or a peerbit-fs that exited
		// before the signal was requested: the adapter says so and goes on,
		// since its IPC connections still end the mount.
		{name: "another parent", expected: "4242", parent: 4243, note: "the adapter's parent is process 4243, not peerbit-fs (process 4242), so no signal reaches it when peerbit-fs exits; it still unmounts when its IPC connection to peerbit-fs ends. A wrapper script should start the adapter with exec.", calls: []string{"setSignal", "getppid"}},
		{name: "parent already gone", expected: "4242", parent: 1, note: "the adapter's parent is process 1, not peerbit-fs (process 4242)", calls: []string{"setSignal", "getppid"}},
		{name: "signal refused", expected: "4242", setSignal: failed, want: "prctl failed", calls: []string{"setSignal"}},
		{name: "not a process id", expected: "peerbit", want: parentPIDEnv + ` is not a process id: "peerbit"`, calls: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls []string
			note, err := armParentDeath(test.expected, func() error {
				calls = append(calls, "setSignal")
				return test.setSignal
			}, func() int {
				calls = append(calls, "getppid")
				return test.parent
			})
			if (err == nil) != (test.want == "") || (err != nil && !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("armParentDeath error = %v, want %q", err, test.want)
			}
			if (note == "") != (test.note == "") || !strings.Contains(note, test.note) {
				t.Fatalf("armParentDeath note = %q, want %q", note, test.note)
			}
			if !reflect.DeepEqual(calls, test.calls) {
				t.Fatalf("calls = %v, want %v (the parent is checked only after the signal is set)", calls, test.calls)
			}
		})
	}
}
