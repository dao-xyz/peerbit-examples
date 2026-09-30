package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const defaultIPCMaxFrameBytes = 64 * 1024 * 1024

// ipcTokenEnv carries the IPC server's token from the CLI that starts the
// adapter. The environment, unlike argv, is private to the user.
const ipcTokenEnv = "PEERBIT_SHARED_FS_IPC_TOKEN"

var errIPCFrameTooLarge = errors.New("IPC frame exceeds configured byte limit")

type ipcClientOptions struct {
	// token is the server's secret, presented in every negotiation.
	token                 string
	maxRequestFrameBytes  int
	maxResponseFrameBytes int
	profile               *mountProfiler
}

type ipcClient struct {
	endpoint              string
	token                 string
	nextID                uint64
	maxRequestFrameBytes  int
	maxResponseFrameBytes int

	// cgofuse currently invokes this client from a serialized mount, but keep
	// requests serialized so a future concurrent mount cannot interleave wire
	// frames. Transport state has a separate lock: close must be able to close
	// the socket and interrupt a request blocked waiting for its response.
	requestMu   sync.Mutex
	transportMu sync.Mutex
	conn        net.Conn
	reader      *bufio.Reader
	v2Limits    ipcV2Limits
	closed      bool
	profile     *mountProfiler
}

type ipcRequest struct {
	ID   uint64        `json:"id"`
	Op   string        `json:"op"`
	Args []interface{} `json:"args"`
}

type ipcError struct {
	Code    string
	Message string
}

func (e *ipcError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return e.Code + ": " + e.Message
}

func newIPCClient(endpoint string, provided ...ipcClientOptions) *ipcClient {
	if len(provided) > 1 {
		panic("newIPCClient accepts at most one options value")
	}
	options := ipcClientOptions{
		maxRequestFrameBytes:  defaultIPCMaxFrameBytes,
		maxResponseFrameBytes: defaultIPCMaxFrameBytes,
	}
	if len(provided) == 1 {
		if provided[0].maxRequestFrameBytes < 0 || provided[0].maxResponseFrameBytes < 0 {
			panic("IPC frame limits must not be negative")
		}
		if provided[0].maxRequestFrameBytes > 0 {
			options.maxRequestFrameBytes = provided[0].maxRequestFrameBytes
		}
		if provided[0].maxResponseFrameBytes > 0 {
			options.maxResponseFrameBytes = provided[0].maxResponseFrameBytes
		}
		options.token = provided[0].token
		options.profile = provided[0].profile
	}
	return &ipcClient{
		endpoint:              endpoint,
		token:                 options.token,
		maxRequestFrameBytes:  options.maxRequestFrameBytes,
		maxResponseFrameBytes: options.maxResponseFrameBytes,
		profile:               options.profile,
	}
}

// negotiate dials and negotiates the retained connection now instead of on the
// first filesystem operation, so an incompatible server fails the mount at
// startup rather than every later operation.
func (c *ipcClient) negotiate() error {
	c.requestMu.Lock()
	defer c.requestMu.Unlock()
	_, _, _, _, err := c.connect()
	return err
}

func (c *ipcClient) request(op string, args ...interface{}) (interface{}, error) {
	if c.profile != nil {
		return c.profiledRequest(op, args)
	}
	c.requestMu.Lock()
	defer c.requestMu.Unlock()
	result, _, err := c.requestLocked(op, args)
	return result, err
}

// ipcRequestTrace describes one request for profiling.
type ipcRequestTrace struct {
	// requestID is 0 when the request failed before it was assigned an id.
	requestID uint64
	localPort int
	// connected means the sample included dialing and protocol negotiation.
	connected bool
}

// profiledRequest times the serialized-lane wait and the round trip, then
// emits both records only after requestMu is released. The profiler enqueue is
// non-blocking, so a slow profile file can neither hold the lane nor inflate
// the next request's queue time.
func (c *ipcClient) profiledRequest(op string, args []interface{}) (interface{}, error) {
	queuedAt := time.Now()
	var (
		acquiredAt time.Time
		finishedAt time.Time
		result     interface{}
		trace      ipcRequestTrace
		err        error
	)
	func() {
		c.requestMu.Lock()
		defer c.requestMu.Unlock()
		acquiredAt = time.Now()
		result, trace, err = c.requestLocked(op, args)
		finishedAt = time.Now()
	}()

	var fields mountProfileField
	if trace.requestID != 0 {
		fields |= profileRequestID
	}
	if trace.localPort > 0 {
		fields |= profileLocalPort
	}
	c.profile.emit(mountProfileRecord{
		phase:       "ipc.queue",
		operation:   op,
		startUnixNs: queuedAt.UnixNano(),
		durationNs:  acquiredAt.Sub(queuedAt).Nanoseconds(),
		ok:          true,
		fields:      fields,
		requestID:   trace.requestID,
		localPort:   trace.localPort,
	})
	roundTrip := mountProfileRecord{
		phase:       "ipc.roundTrip",
		operation:   op,
		startUnixNs: acquiredAt.UnixNano(),
		durationNs:  finishedAt.Sub(acquiredAt).Nanoseconds(),
		ok:          err == nil,
		fields:      fields,
		requestID:   trace.requestID,
		localPort:   trace.localPort,
	}
	if trace.connected {
		roundTrip.fields |= profileConnected
	}
	if err != nil {
		code, transport := ipcProfileErrorCode(err)
		roundTrip.fields |= profileCode
		roundTrip.code = code
		if transport {
			roundTrip.fields |= profileTransport
		}
	}
	c.profile.emit(roundTrip)
	return result, err
}

func tcpLocalPort(conn net.Conn) int {
	if conn == nil {
		return 0
	}
	if address, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		return address.Port
	}
	return 0
}

// requestLocked performs one request while the caller holds requestMu. A
// request id is allocated only after a connection is available, so a failed
// dial or negotiation never consumes one.
func (c *ipcClient) requestLocked(op string, args []interface{}) (interface{}, ipcRequestTrace, error) {
	var trace ipcRequestTrace
	conn, reader, v2Limits, dialed, err := c.connect()
	trace.connected = dialed
	if c.profile != nil {
		trace.localPort = tcpLocalPort(conn)
	}
	if err != nil {
		return nil, trace, err
	}

	id := c.nextRequestID()
	trace.requestID = id

	request := ipcRequest{ID: id, Op: op, Args: args}
	frame, err := encodeIPCV2Request(request, args, v2Limits.maxRequestFrameBytes, v2Limits.maxMetadataBytes)
	if err != nil {
		return nil, trace, err
	}
	if err := writeIPCV2Frame(conn, frame); err != nil {
		c.discard(conn)
		return nil, trace, err
	}
	responseFrame, err := readIPCV2Frame(reader, ipcV2ResponseKind, v2Limits.maxResponseFrameBytes, v2Limits.maxMetadataBytes)
	if err != nil {
		c.discard(conn)
		return nil, trace, err
	}
	result, err := parseIPCV2Response(responseFrame, id, op)
	if err != nil {
		if _, backendError := err.(*ipcError); !backendError {
			c.discard(conn)
		}
		return nil, trace, err
	}
	return result, trace, nil
}

func (c *ipcClient) nextRequestID() uint64 {
	if atomic.LoadUint64(&c.nextID) >= maxIPCJSONSafeInteger {
		atomic.StoreUint64(&c.nextID, 0)
	}
	return atomic.AddUint64(&c.nextID, 1)
}

// connect returns the retained connection, or dials and negotiates a new one.
// dialed reports that this call attempted connection setup, even if it failed.
// A failed negotiation discards its connection and is never retried here: the
// caller's operation fails, and nothing was sent that could be replayed.
func (c *ipcClient) connect() (conn net.Conn, reader *bufio.Reader, limits ipcV2Limits, dialed bool, err error) {
	c.transportMu.Lock()
	if c.closed {
		c.transportMu.Unlock()
		return nil, nil, ipcV2Limits{}, false, net.ErrClosed
	}
	if c.conn != nil {
		conn, reader, limits := c.conn, c.reader, c.v2Limits
		c.transportMu.Unlock()
		return conn, reader, limits, false, nil
	}
	c.transportMu.Unlock()

	conn, err = dialEndpoint(c.endpoint)
	if err != nil {
		return nil, nil, ipcV2Limits{}, true, err
	}
	reader = bufio.NewReader(conn)
	if err := c.installConnection(conn, reader); err != nil {
		return nil, nil, ipcV2Limits{}, true, err
	}
	offerLimits := ipcV2Limits{
		maxRequestFrameBytes: c.maxRequestFrameBytes, maxResponseFrameBytes: c.maxResponseFrameBytes,
		maxMetadataBytes: defaultIPCMaxMetadataBytes,
	}
	maxV2FrameBytes := uint64(^uint32(0))
	if uint64(offerLimits.maxRequestFrameBytes) > maxV2FrameBytes {
		offerLimits.maxRequestFrameBytes = int(maxV2FrameBytes)
	}
	if uint64(offerLimits.maxResponseFrameBytes) > maxV2FrameBytes {
		offerLimits.maxResponseFrameBytes = int(maxV2FrameBytes)
	}
	negotiated, err := negotiateIPCV2(conn, reader, c.token, offerLimits)
	if err != nil {
		c.discard(conn)
		return nil, nil, ipcV2Limits{}, true, err
	}
	if err := c.setConnectionLimits(conn, negotiated); err != nil {
		c.discard(conn)
		return nil, nil, ipcV2Limits{}, true, err
	}
	return conn, reader, negotiated, true, nil
}

func (c *ipcClient) installConnection(conn net.Conn, reader *bufio.Reader) error {
	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	if c.closed {
		_ = conn.Close()
		return net.ErrClosed
	}
	// Requests are serialized, so another connection is not expected here.
	// Retain the defensive branch in case that invariant changes later.
	if c.conn != nil {
		_ = conn.Close()
		return errors.New("IPC connection was installed concurrently")
	}
	c.conn = conn
	c.reader = reader
	c.v2Limits = ipcV2Limits{}
	return nil
}

func (c *ipcClient) setConnectionLimits(conn net.Conn, limits ipcV2Limits) error {
	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	if c.conn != conn {
		return errors.New("IPC connection changed during negotiation")
	}
	c.v2Limits = limits
	return nil
}

func (c *ipcClient) discard(conn net.Conn) {
	c.transportMu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.reader = nil
		c.v2Limits = ipcV2Limits{}
	}
	c.transportMu.Unlock()
	closeConn(conn)
}

func (c *ipcClient) close() {
	c.transportMu.Lock()
	c.closed = true
	conn := c.conn
	c.conn = nil
	c.reader = nil
	c.v2Limits = ipcV2Limits{}
	c.transportMu.Unlock()
	if conn != nil {
		closeConn(conn)
	}
}

// readBoundedJSONLine reads the JSONL handshake acknowledgement without
// allowing bufio.Reader to accumulate an unbounded unterminated line. The byte
// limit excludes the trailing newline, matching the TypeScript server.
func readBoundedJSONLine(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	var fragments [][]byte
	totalBytes := 0
	for {
		if totalBytes == maxBytes {
			delimiter, err := reader.ReadByte()
			if err != nil {
				return nil, err
			}
			if delimiter == '\n' {
				return bytes.Join(fragments, nil), nil
			}
			return nil, fmt.Errorf("%w: response exceeds %d bytes", errIPCFrameTooLarge, maxBytes)
		}
		fragment, err := reader.ReadSlice('\n')
		complete := err == nil && len(fragment) > 0 && fragment[len(fragment)-1] == '\n'
		if complete {
			fragment = fragment[:len(fragment)-1]
		}
		if len(fragment) > maxBytes-totalBytes {
			return nil, fmt.Errorf("%w: response exceeds %d bytes", errIPCFrameTooLarge, maxBytes)
		}
		if complete {
			if len(fragments) == 0 {
				return fragment, nil
			}
			fragments = append(fragments, fragment)
			return bytes.Join(fragments, nil), nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			fragments = append(fragments, bytes.Clone(fragment))
			totalBytes += len(fragment)
			continue
		}
		if err != nil {
			return nil, err
		}
	}
}

func dialEndpoint(endpoint string) (net.Conn, error) {
	network, address := "unix", endpoint
	if strings.HasPrefix(endpoint, "tcp://") || strings.HasPrefix(endpoint, "unix://") {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return nil, err
		}
		network, address = parsed.Scheme, parsed.Host+parsed.Path
	}
	conn, err := net.Dial(network, address)
	if err != nil {
		return nil, err
	}
	// Use blocking system calls, so a response wakes the FUSE callback's own
	// thread. cgo locks a callback to its thread, and a wait in Go's network
	// poller makes another thread take the wakeup and hand it over, a fifth of
	// a getattr round trip on macOS. Fd switches the duplicate, and with it the
	// shared socket, to blocking mode; Windows cannot duplicate a socket and
	// keeps the poller.
	if socket, ok := conn.(interface{ File() (*os.File, error) }); ok {
		if file, err := socket.File(); err == nil {
			file.Fd()
			_ = file.Close()
		}
	}
	return conn, nil
}

// closeConn shuts the socket down first, which wakes a read or write blocked
// in the kernel; Close alone would wait for it.
func closeConn(conn net.Conn) {
	if socket, ok := conn.(interface {
		CloseRead() error
		CloseWrite() error
	}); ok {
		_ = socket.CloseRead()
		_ = socket.CloseWrite()
	}
	_ = conn.Close()
}
