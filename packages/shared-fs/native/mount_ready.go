package main

import (
	"fmt"
	"io"
	"os"
	"time"
)

// attachWaiter reports when the mount is attached: Init writes the ready line
// once wait returns (see mountWatcher).
type attachWaiter interface {
	wait() error
}

// reportReady writes the ready line once mounted reports the mount attached.
// When the wait fails it says why and writes no ready line: peerbit-fs mount
// then fails at its readiness limit instead of printing Mounted for a mount
// that may not be there.
func reportReady(mounted attachWaiter, stdout, stderr io.Writer) {
	if err := mounted.wait(); err != nil {
		fmt.Fprintf(stderr, "peerbit-shared-fs-native could not confirm the mount is attached: %v\n", err)
		return
	}
	fmt.Fprintln(stdout, "peerbit-shared-fs-native ready")
}

// driveWaitLimit bounds the wait for a drive letter. WinFsp defines it as
// soon as init and its probes of the root return; the CLI gives the adapter
// 15 s to report ready.
var driveWaitLimit = 10 * time.Second

// mountDrive returns the drive ("P:") when mountpoint names a drive letter,
// which WinFsp mounts with DefineDosDevice.
func mountDrive(mountpoint string) (string, bool) {
	if len(mountpoint) != 2 || mountpoint[1] != ':' {
		return "", false
	}
	letter := mountpoint[0]
	switch {
	case letter >= 'A' && letter <= 'Z':
	case letter >= 'a' && letter <= 'z':
		letter -= 'a' - 'A'
	default:
		return "", false
	}
	return string([]byte{letter, ':'}), true
}

// driveTable is the host's table of drive letters: on Windows, defined asks
// QueryDosDeviceW and watch hears the WM_DEVICECHANGE arrival notice that
// DefineDosDevice broadcasts.
type driveTable interface {
	defined(drive string) (bool, error)
	// watch calls arrived after each drive arrival until stop is called.
	watch(arrived func()) (stop func(), err error)
}

// driveWatcher reports when the mount's drive letter is defined. WinFsp calls
// init before it creates the volume and defines the letter, so a ready line
// written at init can precede the drive, and a client that acts on it at once
// gets ENOENT. The watcher subscribes to drive arrivals before the mount,
// checks the letter when the wait starts and again only after an arrival,
// and gives up after limit.
type driveWatcher struct {
	drive    string
	table    driveTable
	limit    time.Duration
	after    func(time.Duration) <-chan time.Time
	log      io.Writer
	arrivals chan struct{}
	stop     func()
}

// newDriveWatcher subscribes to drive arrivals, so it must run before the
// mount.
func newDriveWatcher(drive string, table driveTable, limit time.Duration) (*driveWatcher, error) {
	w := &driveWatcher{
		drive: drive,
		table: table,
		limit: limit,
		after: time.After,
		log:   os.Stderr,
		// One pending arrival is enough: the wait checks the table after it.
		arrivals: make(chan struct{}, 1),
	}
	stop, err := table.watch(w.arrived)
	if err != nil {
		return nil, fmt.Errorf("listen for drive arrivals: %w", err)
	}
	w.stop = stop
	return w, nil
}

func (w *driveWatcher) arrived() {
	select {
	case w.arrivals <- struct{}{}:
	default:
	}
}

// wait returns once the drive is defined. At the limit it stops waiting for
// an arrival and looks once more, which tells a lost notice (WinFsp says the
// broadcast fails on some systems) from a drive that was never defined.
func (w *driveWatcher) wait() error {
	defer w.stop()
	deadline := w.after(w.limit)
	for {
		defined, err := w.table.defined(w.drive)
		if err != nil || defined {
			return err
		}
		select {
		case <-w.arrivals:
		case <-deadline:
			if defined, err = w.table.defined(w.drive); err != nil {
				return err
			}
			if !defined {
				return fmt.Errorf("drive %s was not defined within %s", w.drive, w.limit)
			}
			fmt.Fprintf(w.log, "peerbit-shared-fs-native: drive %s is defined, but no arrival notice reached the adapter within %s\n", w.drive, w.limit)
			return nil
		}
	}
}
