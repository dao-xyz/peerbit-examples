package main

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type recordedIPCRequest struct {
	op   string
	args []interface{}
}

type fakeIPCLane struct {
	requestMu sync.Mutex
	recordMu  sync.Mutex
	requests  []recordedIPCRequest
	requestFn func(op string, args ...interface{}) (interface{}, error)
	closeFn   func()
	closes    atomic.Uint64
}

func (l *fakeIPCLane) request(op string, args ...interface{}) (interface{}, error) {
	// Match ipcClient: every individual lane is a serialized byte stream.
	l.requestMu.Lock()
	defer l.requestMu.Unlock()
	l.recordMu.Lock()
	l.requests = append(l.requests, recordedIPCRequest{op: op, args: append([]interface{}(nil), args...)})
	l.recordMu.Unlock()
	if l.requestFn != nil {
		return l.requestFn(op, args...)
	}
	return nil, nil
}

func (l *fakeIPCLane) close() {
	l.closes.Add(1)
	if l.closeFn != nil {
		l.closeFn()
	}
}

func (l *fakeIPCLane) snapshot() []recordedIPCRequest {
	l.recordMu.Lock()
	defer l.recordMu.Unlock()
	requests := make([]recordedIPCRequest, len(l.requests))
	copy(requests, l.requests)
	return requests
}

func mustTestIPCClientPool(t *testing.T, lanes ...ipcLane) *ipcClientPool {
	t.Helper()
	pool, err := newIPCClientPoolWithLanes(lanes)
	if err != nil {
		t.Fatal(err)
	}
	return pool
}

func TestIPCClientPoolBounds(t *testing.T) {
	for _, width := range []int{1, 2, 16} {
		t.Run(fmt.Sprintf("accepts-%d", width), func(t *testing.T) {
			lanes := make([]ipcLane, width)
			for index := range lanes {
				lanes[index] = &fakeIPCLane{}
			}
			pool, err := newIPCClientPoolWithLanes(lanes)
			if err != nil {
				t.Fatal(err)
			}
			pool.close()
		})
	}
	for _, width := range []int{-1, 0, 17, 1 << 20} {
		t.Run(fmt.Sprintf("rejects-%d", width), func(t *testing.T) {
			if err := validateIPCConcurrency(width); err == nil {
				t.Fatalf("expected width %d to be rejected", width)
			}
		})
	}
}

func TestIPCClientPoolOpensNoMoreThanItsConfiguredRealConnections(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return float64(1)
	})
	pool, err := newIPCClientPool("tcp://"+server.listener.Addr().String(), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.close()
	for request := 0; request < 12; request++ {
		if _, err := pool.request("getattr", fmt.Sprintf("/%d", request)); err != nil {
			t.Fatal(err)
		}
	}
	if got := server.accepted.Load(); got != 4 {
		t.Fatalf("pool accepted %d real connections, want configured width 4", got)
	}
}

func TestIPCClientPoolRejectsMalformedAndDuplicateLiveHandles(t *testing.T) {
	for _, result := range []interface{}{-1, 1.5, "41", uint64(maxIPCJSONSafeInteger + 1)} {
		t.Run(fmt.Sprintf("malformed-%v", result), func(t *testing.T) {
			lane := &fakeIPCLane{requestFn: func(string, ...interface{}) (interface{}, error) {
				return result, nil
			}}
			pool := mustTestIPCClientPool(t, lane)
			defer pool.close()
			if _, err := pool.open("/malformed", 0); err == nil {
				t.Fatalf("invalid handle %#v was accepted", result)
			}
		})
	}

	lane := &fakeIPCLane{requestFn: func(string, ...interface{}) (interface{}, error) {
		return float64(41), nil
	}}
	pool := mustTestIPCClientPool(t, lane)
	defer pool.close()
	if _, err := pool.open("/first", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.open("/duplicate", 0); err == nil {
		t.Fatal("duplicate live handle was allowed to replace its lane binding")
	}
}

func TestIPCClientPoolPinsEveryFileHandleOperationToItsOpenLane(t *testing.T) {
	lane0 := &fakeIPCLane{}
	lane1 := &fakeIPCLane{}
	lane0.requestFn = func(op string, _ ...interface{}) (interface{}, error) {
		if op == "open" {
			return float64(101), nil
		}
		if op == "read" {
			return []byte("lane-0"), nil
		}
		return float64(1), nil
	}
	lane1.requestFn = func(op string, _ ...interface{}) (interface{}, error) {
		if op == "open" {
			return float64(202), nil
		}
		if op == "read" {
			return []byte("lane-1"), nil
		}
		return float64(1), nil
	}
	pool := mustTestIPCClientPool(t, lane0, lane1)
	defer pool.close()

	handle0, err := pool.open("/zero", 0)
	if err != nil || handle0 != 101 {
		t.Fatalf("first open = (%d, %v), want (101, nil)", handle0, err)
	}
	handle1, err := pool.open("/one", 0)
	if err != nil || handle1 != 202 {
		t.Fatalf("second open = (%d, %v), want (202, nil)", handle1, err)
	}

	operations := []struct {
		handle uint64
		op     string
		args   []interface{}
	}{
		{handle0, "getattr", []interface{}{`/zero`}},
		{handle1, "getattr", []interface{}{`/one`}},
		{handle0, "read", []interface{}{8, int64(0)}},
		{handle1, "write", []interface{}{[]byte("x"), int64(0)}},
		{handle0, "truncate", []interface{}{int64(0)}},
		{handle1, "flush", nil},
		{handle0, "fsync", nil},
	}
	for _, operation := range operations {
		var requestErr error
		if operation.op == "getattr" {
			_, requestErr = pool.requestForOptionalHandle(operation.handle, operation.op, operation.args...)
		} else {
			_, requestErr = pool.requestForHandle(operation.handle, operation.op, operation.args...)
		}
		if requestErr != nil {
			t.Fatalf("%s(%d) failed: %v", operation.op, operation.handle, requestErr)
		}
	}
	if err := pool.release(handle1); err != nil {
		t.Fatal(err)
	}
	if err := pool.release(handle0); err != nil {
		t.Fatal(err)
	}

	assertLaneHandles := func(lane int, requests []recordedIPCRequest, handle uint64) {
		t.Helper()
		for _, request := range requests {
			if request.op == "open" || request.op == "getattr" {
				continue
			}
			if len(request.args) == 0 || request.args[0] != handle {
				t.Fatalf("lane %d received %s args %#v, expected handle %d", lane, request.op, request.args, handle)
			}
		}
	}
	assertLaneHandles(0, lane0.snapshot(), handle0)
	assertLaneHandles(1, lane1.snapshot(), handle1)

	before := len(lane0.snapshot()) + len(lane1.snapshot())
	if _, err := pool.requestForHandle(handle0, "read", 1, int64(0)); err == nil {
		t.Fatal("request after successful release unexpectedly succeeded")
	} else if ipc, ok := err.(*ipcError); !ok || ipc.Code != "EBADF" {
		t.Fatalf("request after release returned %v, want EBADF", err)
	}
	after := len(lane0.snapshot()) + len(lane1.snapshot())
	if after != before {
		t.Fatal("request for an unbound handle reached a transport lane")
	}
}

func TestIPCClientPoolLetsIndependentLanesProgress(t *testing.T) {
	entered := make(chan struct{})
	unblock := make(chan struct{})
	lane0 := &fakeIPCLane{requestFn: func(op string, _ ...interface{}) (interface{}, error) {
		if op == "slow" {
			close(entered)
			<-unblock
		}
		return "slow-done", nil
	}}
	lane1 := &fakeIPCLane{requestFn: func(string, ...interface{}) (interface{}, error) {
		return "fast-done", nil
	}}
	pool := mustTestIPCClientPool(t, lane0, lane1)
	defer pool.close()

	slowDone := make(chan error, 1)
	go func() {
		_, err := pool.request("slow")
		slowDone <- err
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("slow lane was not entered")
	}
	fastDone := make(chan error, 1)
	go func() {
		result, err := pool.request("fast")
		if err == nil && result != "fast-done" {
			err = fmt.Errorf("fast result = %v", result)
		}
		fastDone <- err
	}()
	select {
	case err := <-fastDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("independent lane was blocked behind a different lane")
	}
	close(unblock)
	if err := <-slowDone; err != nil {
		t.Fatal(err)
	}
}

func TestIPCClientPoolRetainsAffinityAfterReleaseError(t *testing.T) {
	var releases atomic.Uint64
	ownerLane := &fakeIPCLane{requestFn: func(op string, _ ...interface{}) (interface{}, error) {
		switch op {
		case "open":
			return float64(41), nil
		case "release":
			if releases.Add(1) == 1 {
				return nil, &ipcError{Code: "EIO", Message: "injected release failure"}
			}
		}
		return float64(1), nil
	}}
	otherLane := &fakeIPCLane{requestFn: func(op string, _ ...interface{}) (interface{}, error) {
		return nil, fmt.Errorf("operation %s was rerouted to the non-owner lane", op)
	}}
	pool := mustTestIPCClientPool(t, ownerLane, otherLane)
	defer pool.close()
	handle, err := pool.open("/retry", 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := pool.release(handle); err == nil {
		t.Fatal("first release unexpectedly succeeded")
	}
	if _, err := pool.requestForHandle(handle, "write", []byte("still-bound"), int64(0)); err != nil {
		t.Fatalf("failed release dropped handle affinity: %v", err)
	}
	if requests := otherLane.snapshot(); len(requests) != 0 {
		t.Fatalf("failed release rerouted requests to another lane: %#v", requests)
	}
	if err := pool.release(handle); err != nil {
		t.Fatalf("explicit release retry failed: %v", err)
	}
	if _, err := pool.requestForHandle(handle, "flush"); err == nil {
		t.Fatal("successful release did not retire handle affinity")
	}
}

func TestIPCClientPoolNeverReplaysAcrossLanes(t *testing.T) {
	ambiguous := errors.New("response lost after dispatch")
	var lane0Calls atomic.Uint64
	var lane1Calls atomic.Uint64
	lane0 := &fakeIPCLane{requestFn: func(string, ...interface{}) (interface{}, error) {
		lane0Calls.Add(1)
		return nil, ambiguous
	}}
	lane1 := &fakeIPCLane{requestFn: func(string, ...interface{}) (interface{}, error) {
		lane1Calls.Add(1)
		return "explicit-retry", nil
	}}
	pool := mustTestIPCClientPool(t, lane0, lane1)
	defer pool.close()

	if _, err := pool.request("mkdir", "/ambiguous"); !errors.Is(err, ambiguous) {
		t.Fatalf("first request returned %v, want ambiguous transport error", err)
	}
	if lane0Calls.Load() != 1 || lane1Calls.Load() != 0 {
		t.Fatalf("failed request was replayed: lane0=%d lane1=%d", lane0Calls.Load(), lane1Calls.Load())
	}
	if result, err := pool.request("mkdir", "/explicit-retry"); err != nil || result != "explicit-retry" {
		t.Fatalf("explicit retry = (%v, %v)", result, err)
	}
	if lane0Calls.Load() != 1 || lane1Calls.Load() != 1 {
		t.Fatalf("unexpected request counts after explicit retry: lane0=%d lane1=%d", lane0Calls.Load(), lane1Calls.Load())
	}
}

func TestIPCClientPoolCloseInterruptsEveryLaneAndDoesNotHoldPoolLock(t *testing.T) {
	requestEntered := make(chan struct{})
	requestClosed := make(chan struct{})
	closeEntered := make(chan struct{})
	allowClose := make(chan struct{})
	var laneCloseOnce sync.Once
	lane0 := &fakeIPCLane{
		requestFn: func(string, ...interface{}) (interface{}, error) {
			close(requestEntered)
			<-requestClosed
			return nil, net.ErrClosed
		},
		closeFn: func() {
			laneCloseOnce.Do(func() {
				close(requestClosed)
				close(closeEntered)
			})
			<-allowClose
		},
	}
	lane1 := &fakeIPCLane{}
	pool := mustTestIPCClientPool(t, lane0, lane1)

	requestDone := make(chan error, 1)
	go func() {
		_, err := pool.request("blocked")
		requestDone <- err
	}()
	select {
	case <-requestEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("request did not enter first lane")
	}
	closeDone := make(chan struct{})
	go func() {
		pool.close()
		close(closeDone)
	}()
	select {
	case <-closeEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("pool did not begin closing first lane")
	}

	// The first lane's close is deliberately stalled. A pool mutex held across
	// that I/O would make this post-close request hang instead of failing fast.
	postCloseDone := make(chan error, 1)
	go func() {
		_, err := pool.request("after-close")
		postCloseDone <- err
	}()
	select {
	case err := <-postCloseDone:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("post-close request returned %v, want net.ErrClosed", err)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("pool lock was held while a lane close blocked")
	}
	close(allowClose)
	select {
	case <-closeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("pool close did not finish")
	}
	if err := <-requestDone; !errors.Is(err, net.ErrClosed) {
		t.Fatalf("blocked request returned %v, want net.ErrClosed", err)
	}
	pool.close()
	if lane0.closes.Load() != 1 || lane1.closes.Load() != 1 {
		t.Fatalf("lanes closed %d and %d times, want once each", lane0.closes.Load(), lane1.closes.Load())
	}
}

func TestIPCClientPoolConcurrentHandleAffinity(t *testing.T) {
	const width = 8
	var nextHandle atomic.Uint64
	var mismatches atomic.Uint64
	owners := sync.Map{}
	lanes := make([]ipcLane, width)
	for laneIndex := range lanes {
		index := laneIndex
		lanes[index] = &fakeIPCLane{requestFn: func(op string, args ...interface{}) (interface{}, error) {
			if op == "open" {
				handle := nextHandle.Add(1)
				owners.Store(handle, index)
				return handle, nil
			}
			if len(args) > 0 {
				if handle, ok := args[0].(uint64); ok {
					owner, exists := owners.Load(handle)
					if !exists || owner.(int) != index {
						mismatches.Add(1)
					}
				}
			}
			return float64(1), nil
		}}
	}
	pool := mustTestIPCClientPool(t, lanes...)
	defer pool.close()

	const callers = 128
	errorsSeen := make(chan error, callers)
	var callersWG sync.WaitGroup
	callersWG.Add(callers)
	for caller := 0; caller < callers; caller++ {
		go func(caller int) {
			defer callersWG.Done()
			handle, err := pool.open(fmt.Sprintf("/%d", caller), 2)
			if err != nil {
				errorsSeen <- err
				return
			}
			for _, op := range []string{"read", "write", "flush", "fsync", "truncate"} {
				if _, err := pool.requestForHandle(handle, op); err != nil {
					errorsSeen <- err
					return
				}
			}
			if err := pool.release(handle); err != nil {
				errorsSeen <- err
			}
		}(caller)
	}
	callersWG.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Fatal(err)
	}
	if got := mismatches.Load(); got != 0 {
		t.Fatalf("observed %d cross-lane handle operations", got)
	}
	pool.mu.Lock()
	remaining := len(pool.handleLanes)
	pool.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("%d handle bindings remained after successful releases", remaining)
	}
}
