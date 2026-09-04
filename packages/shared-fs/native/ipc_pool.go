package main

import (
	"fmt"
	"math"
	"net"
	"sync"
)

const (
	defaultIPCConcurrency = 1
	maxIPCConcurrency     = 16
)

type ipcLane interface {
	request(op string, args ...interface{}) (interface{}, error)
	close()
}

// ipcClientPool provides bounded concurrency without multiplexing one byte
// stream. Each lane remains a serialized ipcClient, so frames cannot
// interleave and a transport failure still fails exactly one explicit request.
// File handles stay on the lane that opened them to preserve operation order.
type ipcClientPool struct {
	mu          sync.Mutex
	lanes       []ipcLane
	handleLanes map[uint64]int
	nextLane    uint64
	closed      bool
}

func validateIPCConcurrency(width int) error {
	if width < defaultIPCConcurrency || width > maxIPCConcurrency {
		return fmt.Errorf("IPC concurrency must be between %d and %d", defaultIPCConcurrency, maxIPCConcurrency)
	}
	return nil
}

func newIPCClientPool(endpoint string, width int) (*ipcClientPool, error) {
	if err := validateIPCConcurrency(width); err != nil {
		return nil, err
	}
	lanes := make([]ipcLane, width)
	for index := range lanes {
		lanes[index] = newIPCClient(endpoint)
	}
	return newIPCClientPoolWithLanes(lanes)
}

func newIPCClientPoolWithLanes(lanes []ipcLane) (*ipcClientPool, error) {
	if err := validateIPCConcurrency(len(lanes)); err != nil {
		return nil, err
	}
	for index, lane := range lanes {
		if lane == nil {
			return nil, fmt.Errorf("IPC lane %d is nil", index)
		}
	}
	return &ipcClientPool{
		lanes:       append([]ipcLane(nil), lanes...),
		handleLanes: make(map[uint64]int),
	}, nil
}

func (p *ipcClientPool) next() (int, ipcLane, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, nil, net.ErrClosed
	}
	index := int(p.nextLane % uint64(len(p.lanes)))
	p.nextLane++
	return index, p.lanes[index], nil
}

func (p *ipcClientPool) request(op string, args ...interface{}) (interface{}, error) {
	_, lane, err := p.next()
	if err != nil {
		return nil, err
	}
	return lane.request(op, args...)
}

func (p *ipcClientPool) open(path string, flags interface{}) (uint64, error) {
	index, lane, err := p.next()
	if err != nil {
		return 0, err
	}
	result, err := lane.request("open", path, flags)
	if err != nil {
		return 0, err
	}
	handle, err := ipcHandleFromResult(result)
	if err != nil {
		return 0, err
	}
	if err := p.bind(handle, index); err != nil {
		return 0, err
	}
	return handle, nil
}

func ipcHandleFromResult(value interface{}) (uint64, error) {
	var handle uint64
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed < 0 || math.Trunc(typed) != typed || typed > float64(maxIPCJSONSafeInteger) {
			return 0, fmt.Errorf("IPC open returned invalid handle %v", typed)
		}
		handle = uint64(typed)
	case int:
		if typed < 0 {
			return 0, fmt.Errorf("IPC open returned invalid handle %v", typed)
		}
		handle = uint64(typed)
	case int64:
		if typed < 0 {
			return 0, fmt.Errorf("IPC open returned invalid handle %v", typed)
		}
		handle = uint64(typed)
	case uint64:
		handle = typed
	default:
		return 0, fmt.Errorf("IPC open returned invalid handle type %T", value)
	}
	if handle > maxIPCJSONSafeInteger {
		return 0, fmt.Errorf("IPC open returned handle %d above the JSON safe-integer limit", handle)
	}
	return handle, nil
}

func (p *ipcClientPool) bind(handle uint64, lane int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return net.ErrClosed
	}
	if _, exists := p.handleLanes[handle]; exists {
		return fmt.Errorf("IPC open returned duplicate live handle %d", handle)
	}
	p.handleLanes[handle] = lane
	return nil
}

func (p *ipcClientPool) bound(handle uint64) (int, ipcLane, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return 0, nil, net.ErrClosed
	}
	index, exists := p.handleLanes[handle]
	if !exists {
		return 0, nil, &ipcError{Code: "EBADF", Message: fmt.Sprintf("file handle %d is not open", handle)}
	}
	return index, p.lanes[index], nil
}

func (p *ipcClientPool) requestForHandle(handle uint64, op string, args ...interface{}) (interface{}, error) {
	_, lane, err := p.bound(handle)
	if err != nil {
		return nil, err
	}
	// All current handle operations have at most two arguments after the
	// handle. Avoid building an extra argument slice on their hot path while
	// making it impossible to route on one handle and put another on the wire.
	switch len(args) {
	case 0:
		return lane.request(op, handle)
	case 1:
		return lane.request(op, handle, args[0])
	case 2:
		return lane.request(op, handle, args[0], args[1])
	default:
		requestArgs := make([]interface{}, len(args)+1)
		requestArgs[0] = handle
		copy(requestArgs[1:], args)
		return lane.request(op, requestArgs...)
	}
}

// requestForOptionalHandle uses affinity when cgofuse supplies a live handle,
// and otherwise treats the request as an ordinary path operation.
func (p *ipcClientPool) requestForOptionalHandle(handle uint64, op string, args ...interface{}) (interface{}, error) {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil, net.ErrClosed
	}
	if index, exists := p.handleLanes[handle]; exists {
		lane := p.lanes[index]
		p.mu.Unlock()
		return lane.request(op, args...)
	}
	index := int(p.nextLane % uint64(len(p.lanes)))
	p.nextLane++
	lane := p.lanes[index]
	p.mu.Unlock()
	return lane.request(op, args...)
}

func (p *ipcClientPool) release(handle uint64) error {
	index, lane, err := p.bound(handle)
	if err != nil {
		return err
	}
	if _, err := lane.request("release", handle); err != nil {
		// A failed or response-lost release is ambiguous. Keep the affinity so
		// only a later explicit Release can retire this binding.
		return err
	}
	p.mu.Lock()
	if bound, exists := p.handleLanes[handle]; exists && bound == index {
		delete(p.handleLanes, handle)
	}
	p.mu.Unlock()
	return nil
}

func (p *ipcClientPool) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.handleLanes = nil
	lanes := append([]ipcLane(nil), p.lanes...)
	p.mu.Unlock()

	// ipcClient.close closes its socket to interrupt blocked I/O. Never hold
	// the pool lock while doing that, so concurrent callers can observe closed.
	for _, lane := range lanes {
		lane.close()
	}
}
