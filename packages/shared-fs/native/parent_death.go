package main

import (
	"fmt"
	"strconv"
)

// parentPIDEnv carries the process id of the peerbit-fs mount process that
// starts the adapter. On Linux the adapter asks the kernel for SIGHUP when its
// parent exits, then checks that its parent is that process.
const parentPIDEnv = "PEERBIT_SHARED_FS_PARENT_PID"

// parentDeathErr is set when the adapter could not ask for the signal. main
// reports it before doing anything else.
var parentDeathErr error

// parentDeathNote is set when the adapter's parent is not peerbit-fs. main
// prints it and goes on.
var parentDeathNote string

// armParentDeath ties the adapter to the process named by expected: without
// one (an adapter started by hand) it does nothing. setSignal asks for the
// signal; getppid is read only after that, so a parent that exits at any time
// is either seen here or signals the adapter.
//
// Another parent is not refused: it is a wrapper that started the adapter
// without exec (a shell script, sudo, strace -f), or peerbit-fs exited before
// the request. The signal then watches that process instead, and the note says
// so. Either way the IPC connections still end the mount: they fail at once
// when peerbit-fs is gone, and end when it exits.
func armParentDeath(expected string, setSignal func() error, getppid func() int) (note string, err error) {
	if expected == "" {
		return "", nil
	}
	parent, err := strconv.Atoi(expected)
	if err != nil || parent <= 0 {
		return "", fmt.Errorf("%s is not a process id: %q", parentPIDEnv, expected)
	}
	if err := setSignal(); err != nil {
		return "", fmt.Errorf("could not ask for a signal when peerbit-fs exits: %w", err)
	}
	if actual := getppid(); actual != parent {
		return fmt.Sprintf("the adapter's parent is process %d, not peerbit-fs (process %d), so no signal reaches it when peerbit-fs exits; it still unmounts when its IPC connection to peerbit-fs ends. A wrapper script should start the adapter with exec.", actual, parent), nil
	}
	return "", nil
}
