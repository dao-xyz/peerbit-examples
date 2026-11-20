package main

import (
	"fmt"
	"os"
	"sync"
)

// mountStop ends a mount once, for the first reason given. Unmounting needs a
// mounted filesystem, so a request that comes before the mount is recorded and
// carried out when the filesystem reports it is mounted.
type mountStop struct {
	mu        sync.Mutex
	requested bool
	reason    error
	unmount   func()
}

// request asks for the mount to end, unmounting now if it is mounted. reason
// is nil for a stop the adapter was asked for (a hangup) and otherwise says
// why the mount ended on its own; runNativeMount returns it.
func (s *mountStop) request(reason error) {
	s.mu.Lock()
	if s.requested {
		s.mu.Unlock()
		return
	}
	s.requested = true
	s.reason = reason
	unmount := s.unmount
	s.mu.Unlock()
	if unmount != nil {
		unmount()
	}
}

// mounted records how to unmount. The filesystem's Init calls it, so a stop
// requested earlier unmounts on another goroutine, after Init returns.
func (s *mountStop) mounted(unmount func()) {
	s.mu.Lock()
	s.unmount = unmount
	requested := s.requested
	s.mu.Unlock()
	if requested {
		go unmount()
	}
}

// err is why the mount ended on its own, or nil.
func (s *mountStop) err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reason
}

// superviseMount stops the mount on a hangup or when the IPC lifeline ends.
// A lifeline the adapter closed itself delivers nil.
func superviseMount(stop *mountStop, hangups <-chan os.Signal, lifeline <-chan error) {
	select {
	case <-hangups:
		stop.request(nil)
	case err := <-lifeline:
		if err != nil {
			stop.request(fmt.Errorf("native adapter unmounted: its IPC connection to peerbit-fs ended (%v), so peerbit-fs exited or stopped serving the mount", err))
		}
	}
}
