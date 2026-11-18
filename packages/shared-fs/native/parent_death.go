package main

import (
	"errors"
	"fmt"
	"strconv"
)

// parentPIDEnv carries the process id of the peerbit-fs mount process that
// starts the adapter. On Linux the adapter asks the kernel for SIGHUP when
// that process exits, then checks it is still its parent: one that exited
// before the request was made has already handed the adapter to another
// parent, which the request would watch instead.
const parentPIDEnv = "PEERBIT_SHARED_FS_PARENT_PID"

var errParentGone = errors.New("peerbit-fs exited before the adapter started")

// parentDeathErr is set when the adapter could not tie itself to its parent,
// or its parent is already gone. main reports it before doing anything else.
var parentDeathErr error

// armParentDeath ties the adapter to the process named by expected: without
// one (an adapter started by hand) it does nothing. setSignal asks for the
// signal; getppid is read only after that, so a parent that exits at any time
// is either seen here or signals the adapter.
func armParentDeath(expected string, setSignal func() error, getppid func() int) error {
	if expected == "" {
		return nil
	}
	parent, err := strconv.Atoi(expected)
	if err != nil || parent <= 0 {
		return fmt.Errorf("%s is not a process id: %q", parentPIDEnv, expected)
	}
	if err := setSignal(); err != nil {
		return fmt.Errorf("could not ask for a signal when peerbit-fs exits: %w", err)
	}
	if getppid() != parent {
		return errParentGone
	}
	return nil
}
