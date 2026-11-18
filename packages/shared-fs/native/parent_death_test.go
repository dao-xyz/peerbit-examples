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
		calls     []string
	}{
		// Started by hand, not by peerbit-fs: nothing to watch.
		{name: "no parent named", expected: "", calls: nil},
		{name: "parent alive", expected: "4242", parent: 4242, calls: []string{"setSignal", "getppid"}},
		// The parent exited before the signal was requested, so the adapter
		// already has another parent, which the signal would watch instead.
		{name: "parent already gone", expected: "4242", parent: 1, want: errParentGone.Error(), calls: []string{"setSignal", "getppid"}},
		{name: "signal refused", expected: "4242", setSignal: failed, want: "prctl failed", calls: []string{"setSignal"}},
		{name: "not a process id", expected: "peerbit", want: parentPIDEnv + ` is not a process id: "peerbit"`, calls: nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var calls []string
			err := armParentDeath(test.expected, func() error {
				calls = append(calls, "setSignal")
				return test.setSignal
			}, func() int {
				calls = append(calls, "getppid")
				return test.parent
			})
			if (err == nil) != (test.want == "") || (err != nil && !strings.Contains(err.Error(), test.want)) {
				t.Fatalf("armParentDeath = %v, want %q", err, test.want)
			}
			if !reflect.DeepEqual(calls, test.calls) {
				t.Fatalf("calls = %v, want %v (the parent is checked only after the signal is set)", calls, test.calls)
			}
		})
	}
}
