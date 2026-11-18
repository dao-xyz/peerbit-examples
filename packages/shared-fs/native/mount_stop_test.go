package main

import (
	"errors"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func countingUnmount() (func(), *atomic.Int32, <-chan struct{}) {
	var calls atomic.Int32
	called := make(chan struct{}, 4)
	return func() {
		calls.Add(1)
		called <- struct{}{}
	}, &calls, called
}

func TestMountStopUnmountsOnceForTheFirstReason(t *testing.T) {
	unmount, calls, _ := countingUnmount()
	stop := &mountStop{}
	stop.mounted(unmount)
	first := errors.New("first")
	stop.request(first)
	stop.request(errors.New("second"))
	stop.request(nil)
	if calls.Load() != 1 || stop.err() != first {
		t.Fatalf("unmounted %d times, reason %v", calls.Load(), stop.err())
	}
}

// A stop that comes before the filesystem is mounted unmounts it as soon as
// it is.
func TestMountStopRequestedBeforeTheMountUnmountsWhenMounted(t *testing.T) {
	unmount, calls, called := countingUnmount()
	stop := &mountStop{}
	stop.request(nil)
	if calls.Load() != 0 {
		t.Fatal("unmounted before the filesystem was mounted")
	}
	stop.mounted(unmount)
	receiveWithin(t, called, "the deferred unmount")
	if calls.Load() != 1 || stop.err() != nil {
		t.Fatalf("unmounted %d times, reason %v", calls.Load(), stop.err())
	}
}

// A hangup (a closed terminal, or on Linux the death of peerbit-fs) unmounts,
// and is not an error: the adapter was asked to stop.
func TestSuperviseMountStopsOnAHangup(t *testing.T) {
	unmount, calls, _ := countingUnmount()
	stop := &mountStop{}
	stop.mounted(unmount)
	hangups := make(chan os.Signal, 1)
	hangups <- os.Interrupt
	superviseMount(stop, hangups, make(chan error))
	if calls.Load() != 1 || stop.err() != nil {
		t.Fatalf("unmounted %d times, reason %v", calls.Load(), stop.err())
	}
}

// A lifeline that ends (peerbit-fs died or closed the IPC server) unmounts,
// and the adapter reports why.
func TestSuperviseMountStopsWhenTheLifelineEnds(t *testing.T) {
	unmount, calls, _ := countingUnmount()
	stop := &mountStop{}
	stop.mounted(unmount)
	lifeline := make(chan error, 1)
	lifeline <- io.EOF
	superviseMount(stop, make(chan os.Signal), lifeline)
	if calls.Load() != 1 || stop.err() == nil || !strings.Contains(stop.err().Error(), "IPC connection to peerbit-fs ended (EOF)") {
		t.Fatalf("unmounted %d times, reason %v", calls.Load(), stop.err())
	}
}

// The adapter closes its lifeline after the mount ended; that is no reason to
// unmount.
func TestSuperviseMountIgnoresALifelineTheAdapterClosed(t *testing.T) {
	unmount, calls, _ := countingUnmount()
	stop := &mountStop{}
	stop.mounted(unmount)
	lifeline := make(chan error, 1)
	lifeline <- nil
	superviseMount(stop, make(chan os.Signal), lifeline)
	if calls.Load() != 0 || stop.err() != nil {
		t.Fatalf("unmounted %d times, reason %v", calls.Load(), stop.err())
	}
}
