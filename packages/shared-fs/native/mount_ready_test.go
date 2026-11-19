package main

import (
	"bytes"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// patience bounds each wait for something the code under test must do; it
// only gives up, so it is generous.
const patience = 30 * time.Second

// quietWindow is how long a test watches for a check that must not come. The
// wait checks only when it starts, on an arrival and at its deadline, so no
// check can come in it; a wait that re-checks on a timer faster than this
// fails.
const quietWindow = 500 * time.Millisecond

func TestMountDrive(t *testing.T) {
	for _, test := range []struct {
		mountpoint string
		drive      string
	}{
		{"P:", "P:"},
		{"p:", "P:"},
		{"Z:", "Z:"},
		{"P:\\", ""},
		{"P:/", ""},
		{"C:\\mnt\\shared", ""},
		{"/mnt/shared", ""},
		{"*", ""},
		{"1:", ""},
		{"", ""},
	} {
		drive, ok := mountDrive(test.mountpoint)
		if drive != test.drive || ok != (test.drive != "") {
			t.Errorf("mountDrive(%q) = %q, %v; want %q", test.mountpoint, drive, ok, test.drive)
		}
	}
}

// fakeDrives is a drive table whose letters a test defines. Each check sends
// its answer on checks.
type fakeDrives struct {
	mu      sync.Mutex
	letters map[string]bool
	arrived func()
	stops   int
	failure error
	// duringCheck runs once, inside the next check, after it read the table.
	duringCheck func()
	checks      chan bool
}

func newFakeDrives() *fakeDrives {
	return &fakeDrives{letters: map[string]bool{}, checks: make(chan bool, 16)}
}

func (d *fakeDrives) defined(drive string) (bool, error) {
	d.mu.Lock()
	defined, failure, during := d.letters[drive], d.failure, d.duringCheck
	d.duringCheck = nil
	d.mu.Unlock()
	if during != nil {
		during()
	}
	d.checks <- defined
	return defined, failure
}

func (d *fakeDrives) watch(arrived func()) (func(), error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.arrived = arrived
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		d.stops++
	}, nil
}

// define defines drive without a notice; arrive is the notice.
func (d *fakeDrives) define(drive string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.letters[drive] = true
}

func (d *fakeDrives) arrive() {
	d.mu.Lock()
	arrived := d.arrived
	d.mu.Unlock()
	arrived()
}

func (d *fakeDrives) stopCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.stops
}

// expectCheck receives the next check's answer. A wait that returns on done
// first fails the test; a nil done is never ready.
func (d *fakeDrives) expectCheck(t *testing.T, want bool, done <-chan error) {
	t.Helper()
	select {
	case got := <-d.checks:
		if got != want {
			t.Fatalf("a check found the drive defined=%v, want %v", got, want)
		}
	case err := <-done:
		t.Fatalf("wait returned %v before a check (want defined=%v)", err, want)
	case <-time.After(patience):
		t.Fatalf("no check (want defined=%v) within %s", want, patience)
	}
}

// expectNoCheck fails if a check comes, or the wait returns, within
// quietWindow while nothing arrives and the deadline has not passed.
func (d *fakeDrives) expectNoCheck(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case got := <-d.checks:
		t.Fatalf("a check (defined=%v) came without an arrival", got)
	case err := <-done:
		t.Fatalf("wait returned %v without an arrival", err)
	case <-time.After(quietWindow):
	}
}

// startWait starts w.wait with a deadline the test fires.
func startWait(t *testing.T, w *driveWatcher) (deadline chan time.Time, done chan error) {
	t.Helper()
	deadline = make(chan time.Time, 1)
	w.after = func(limit time.Duration) <-chan time.Time {
		if limit != w.limit {
			t.Errorf("deadline after %s, want the limit %s", limit, w.limit)
		}
		return deadline
	}
	done = make(chan error, 1)
	go func() { done <- w.wait() }()
	return deadline, done
}

func waitResult(t *testing.T, done chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(patience):
		t.Fatalf("wait did not return within %s", patience)
		return nil
	}
}

func newTestDriveWatcher(t *testing.T, drives *fakeDrives) (*driveWatcher, *bytes.Buffer) {
	t.Helper()
	w, err := newDriveWatcher("P:", drives, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	var notes bytes.Buffer
	w.log = &notes
	return w, &notes
}

func TestDriveWatcherWaitsForTheLetterAndChecksItAgainOnEachArrival(t *testing.T) {
	drives := newFakeDrives()
	w, notes := newTestDriveWatcher(t, drives)
	_, done := startWait(t, w)
	drives.expectCheck(t, false, done)
	// Without an arrival the wait does not look again: no timer re-checks.
	drives.expectNoCheck(t, done)
	// Another drive arrives: one more check, and P: is still undefined.
	drives.arrive()
	drives.expectCheck(t, false, done)
	// P: is defined and its arrival broadcast.
	drives.define("P:")
	drives.arrive()
	drives.expectCheck(t, true, nil)
	if err := waitResult(t, done); err != nil {
		t.Fatal(err)
	}
	if extra := len(drives.checks); extra != 0 {
		t.Fatalf("%d checks beyond one per arrival", extra)
	}
	if drives.stopCount() != 1 || notes.Len() != 0 {
		t.Fatalf("stops=%d notes=%q; want one stop and no note", drives.stopCount(), notes.String())
	}
}

func TestDriveWatcherKeepsAnArrivalThatComesDuringACheck(t *testing.T) {
	drives := newFakeDrives()
	w, _ := newTestDriveWatcher(t, drives)
	// The first check reads the table, then P: is defined and broadcast
	// before the wait listens for arrivals.
	drives.duringCheck = func() {
		drives.define("P:")
		drives.arrive()
	}
	_, done := startWait(t, w)
	drives.expectCheck(t, false, done)
	drives.expectCheck(t, true, nil)
	if err := waitResult(t, done); err != nil {
		t.Fatal(err)
	}
}

func TestDriveWatcherReturnsAtOnceForADefinedDrive(t *testing.T) {
	drives := newFakeDrives()
	w, _ := newTestDriveWatcher(t, drives)
	drives.define("P:")
	_, done := startWait(t, w)
	drives.expectCheck(t, true, nil)
	if err := waitResult(t, done); err != nil || drives.stopCount() != 1 {
		t.Fatalf("wait() = %v with %d stops; want nil and one stop", err, drives.stopCount())
	}
}

func TestDriveWatcherGivesUpAtItsLimit(t *testing.T) {
	t.Run("never defined", func(t *testing.T) {
		drives := newFakeDrives()
		w, notes := newTestDriveWatcher(t, drives)
		deadline, done := startWait(t, w)
		drives.expectCheck(t, false, done)
		deadline <- time.Time{}
		drives.expectCheck(t, false, nil)
		err := waitResult(t, done)
		if err == nil || err.Error() != "drive P: was not defined within 1h0m0s" {
			t.Fatalf("wait() = %v; want the limit's error", err)
		}
		if drives.stopCount() != 1 || notes.Len() != 0 {
			t.Fatalf("stops=%d notes=%q; want one stop and no note", drives.stopCount(), notes.String())
		}
	})
	t.Run("defined without a notice", func(t *testing.T) {
		drives := newFakeDrives()
		w, notes := newTestDriveWatcher(t, drives)
		deadline, done := startWait(t, w)
		drives.expectCheck(t, false, done)
		drives.define("P:")
		deadline <- time.Time{}
		drives.expectCheck(t, true, nil)
		if err := waitResult(t, done); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(notes.String(), "drive P: is defined, but no arrival notice reached the adapter within 1h0m0s") {
			t.Fatalf("notes = %q; want the lost notice named", notes.String())
		}
	})
}

func TestDriveWatcherReportsTableFailures(t *testing.T) {
	failure := errors.New("table unavailable")
	drives := newFakeDrives()
	drives.failure = failure
	w, _ := newTestDriveWatcher(t, drives)
	_, done := startWait(t, w)
	drives.expectCheck(t, false, nil)
	if err := waitResult(t, done); !errors.Is(err, failure) || drives.stopCount() != 1 {
		t.Fatalf("wait() = %v with %d stops; want the table's error and one stop", err, drives.stopCount())
	}

	if _, err := newDriveWatcher("P:", failingWatch{failure}, time.Hour); !errors.Is(err, failure) || !strings.HasPrefix(err.Error(), "listen for drive arrivals: ") {
		t.Fatalf("newDriveWatcher() error = %v; want the watch failure", err)
	}
}

type failingWatch struct{ err error }

func (f failingWatch) defined(string) (bool, error) { return false, nil }

func (f failingWatch) watch(func()) (func(), error) { return nil, f.err }

// pastDeadline makes w's limit pass before its wait looks at the table.
func pastDeadline(w *driveWatcher) {
	deadline := make(chan time.Time, 1)
	deadline <- time.Time{}
	w.after = func(time.Duration) <-chan time.Time { return deadline }
}

func TestReadyLineOnlyForAConfirmedMount(t *testing.T) {
	const ready = "peerbit-shared-fs-native ready\n"
	t.Run("letter defined", func(t *testing.T) {
		drives := newFakeDrives()
		drives.define("P:")
		w, _ := newTestDriveWatcher(t, drives)
		var stdout, stderr bytes.Buffer
		reportReady(w, &stdout, &stderr)
		if stdout.String() != ready || stderr.Len() != 0 {
			t.Fatalf("stdout %q, stderr %q; want only the ready line", stdout.String(), stderr.String())
		}
	})
	t.Run("letter defined without a notice by the limit", func(t *testing.T) {
		drives := newFakeDrives()
		// P: is defined just after the first check, and its arrival is lost.
		drives.duringCheck = func() { drives.define("P:") }
		w, notes := newTestDriveWatcher(t, drives)
		pastDeadline(w)
		var stdout, stderr bytes.Buffer
		reportReady(w, &stdout, &stderr)
		if stdout.String() != ready || stderr.Len() != 0 || !strings.Contains(notes.String(), "no arrival notice") {
			t.Fatalf("stdout %q, stderr %q, notes %q; want the ready line after the lost notice's note", stdout.String(), stderr.String(), notes.String())
		}
	})
	t.Run("letter not defined by the limit", func(t *testing.T) {
		drives := newFakeDrives()
		w, _ := newTestDriveWatcher(t, drives)
		pastDeadline(w)
		var stdout, stderr bytes.Buffer
		reportReady(w, &stdout, &stderr)
		if stdout.Len() != 0 {
			t.Fatalf("wrote %q for a drive that was never defined; want no ready line", stdout.String())
		}
		if want := "peerbit-shared-fs-native could not confirm the mount is attached: drive P: was not defined within 1h0m0s\n"; stderr.String() != want {
			t.Fatalf("stderr %q, want %q", stderr.String(), want)
		}
	})
}
