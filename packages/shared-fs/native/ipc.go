package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const defaultIPCMaxFrameBytes = 64 * 1024 * 1024

var errIPCFrameTooLarge = errors.New("IPC frame exceeds configured byte limit")

type ipcClientOptions struct {
	maxRequestFrameBytes  int
	maxResponseFrameBytes int
	profile               *mountProfiler
}

type ipcClient struct {
	endpoint              string
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
	protocol    ipcWireProtocol
	v2Limits    ipcV2Limits
	closed      bool
	requestJSON bytes.Buffer
	profile     *mountProfiler
}

type ipcRequest struct {
	ID   uint64        `json:"id"`
	Op   string        `json:"op"`
	Args []interface{} `json:"args"`
}

type ipcResponse struct {
	ID     uint64          `json:"id"`
	OK     bool            `json:"ok"`
	Result interface{}     `json:"result"`
	Error  *ipcErrorObject `json:"error"`
}

type ipcErrorObject struct {
	Code    string `json:"code"`
	Message string `json:"message"`
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
		options.profile = provided[0].profile
	}
	return &ipcClient{
		endpoint:              endpoint,
		maxRequestFrameBytes:  options.maxRequestFrameBytes,
		maxResponseFrameBytes: options.maxResponseFrameBytes,
		profile:               options.profile,
	}
}

func (c *ipcClient) request(op string, args ...interface{}) (result interface{}, requestErr error) {
	var queuedAt time.Time
	if c.profile != nil {
		queuedAt = time.Now()
	}
	c.requestMu.Lock()
	defer c.requestMu.Unlock()
	var acquiredAt time.Time
	if c.profile != nil {
		acquiredAt = time.Now()
	}
	id := c.nextRequestID()
	if c.profile != nil {
		detail := map[string]interface{}{"requestId": id}
		c.profile.observe("native-adapter", "ipc.queue", op, acquiredAt.Sub(queuedAt), true, detail)
		started := time.Now()
		defer func() {
			c.profile.observe("native-adapter", "ipc.roundTrip", op, time.Since(started), requestErr == nil, detail)
		}()
	}

	conn, reader, protocol, v2Limits, err := c.connect()
	if err != nil {
		return nil, err
	}

	request := ipcRequest{ID: id, Op: op, Args: args}
	if protocol == ipcWireProtocolV2 {
		frame, err := encodeIPCV2Request(request, args, v2Limits.maxRequestFrameBytes, v2Limits.maxMetadataBytes)
		if err != nil {
			return nil, err
		}
		if err := writeIPCV2Frame(conn, frame); err != nil {
			c.discard(conn)
			return nil, err
		}
		responseFrame, err := readIPCV2Frame(reader, ipcV2ResponseKind, v2Limits.maxResponseFrameBytes, v2Limits.maxMetadataBytes)
		if err != nil {
			c.discard(conn)
			return nil, err
		}
		result, err := parseIPCV2Response(responseFrame, id, op)
		if err != nil {
			if _, backendError := err.(*ipcError); !backendError {
				c.discard(conn)
			}
			return nil, err
		}
		return result, nil
	}

	request.Args = encodeValue(args).([]interface{})
	c.requestJSON.Reset()
	if err := json.NewEncoder(&c.requestJSON).Encode(request); err != nil {
		return nil, err
	}
	frame := c.requestJSON.Bytes()
	if len(frame) == 0 || frame[len(frame)-1] != '\n' {
		return nil, errors.New("IPC encoder did not terminate its request frame")
	}
	payloadBytes := len(frame) - 1
	if payloadBytes > c.maxRequestFrameBytes {
		return nil, fmt.Errorf("%w: request is %d bytes, limit is %d", errIPCFrameTooLarge, payloadBytes, c.maxRequestFrameBytes)
	}
	frames := net.Buffers{frame}
	if _, err := frames.WriteTo(conn); err != nil {
		c.discard(conn)
		return nil, err
	}
	line, err := readBoundedJSONLine(reader, c.maxResponseFrameBytes)
	if err != nil {
		c.discard(conn)
		return nil, err
	}
	var response ipcResponse
	if err := json.Unmarshal(line, &response); err != nil {
		c.discard(conn)
		return nil, err
	}
	if response.ID != id {
		c.discard(conn)
		return nil, fmt.Errorf("unexpected response id %d for request %d", response.ID, id)
	}
	if !response.OK {
		if response.Error == nil {
			return nil, errors.New("IPC request failed")
		}
		return nil, &ipcError{Code: response.Error.Code, Message: response.Error.Message}
	}
	return decodeValue(response.Result), nil
}

func (c *ipcClient) nextRequestID() uint64 {
	if atomic.LoadUint64(&c.nextID) >= maxIPCJSONSafeInteger {
		atomic.StoreUint64(&c.nextID, 0)
	}
	return atomic.AddUint64(&c.nextID, 1)
}

func (c *ipcClient) connect() (net.Conn, *bufio.Reader, ipcWireProtocol, ipcV2Limits, error) {
	c.transportMu.Lock()
	if c.closed {
		c.transportMu.Unlock()
		return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, net.ErrClosed
	}
	if c.conn != nil {
		conn, reader, protocol, limits := c.conn, c.reader, c.protocol, c.v2Limits
		c.transportMu.Unlock()
		return conn, reader, protocol, limits, nil
	}
	c.transportMu.Unlock()

	conn, err := dialEndpoint(c.endpoint)
	if err != nil {
		return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
	}
	reader := bufio.NewReader(conn)
	if err := c.installConnection(conn, reader); err != nil {
		return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
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
	protocol, negotiated, fallback, negotiationErr := negotiateIPCV2(conn, reader, offerLimits)
	if fallback {
		c.discard(conn)
		if c.isClosed() {
			return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, net.ErrClosed
		}
		fallbackConn, err := dialEndpoint(c.endpoint)
		if err != nil {
			return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
		}
		fallbackReader := bufio.NewReader(fallbackConn)
		if err := c.installConnection(fallbackConn, fallbackReader); err != nil {
			return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
		}
		if err := c.setConnectionProtocol(fallbackConn, ipcWireProtocolV1, ipcV2Limits{}); err != nil {
			c.discard(fallbackConn)
			return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
		}
		return fallbackConn, fallbackReader, ipcWireProtocolV1, ipcV2Limits{}, nil
	}
	if negotiationErr != nil {
		c.discard(conn)
		return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, negotiationErr
	}
	if err := c.setConnectionProtocol(conn, protocol, negotiated); err != nil {
		c.discard(conn)
		return nil, nil, ipcWireProtocolUnset, ipcV2Limits{}, err
	}
	return conn, reader, protocol, negotiated, nil
}

func (c *ipcClient) isClosed() bool {
	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	return c.closed
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
	c.protocol = ipcWireProtocolUnset
	c.v2Limits = ipcV2Limits{}
	return nil
}

func (c *ipcClient) setConnectionProtocol(conn net.Conn, protocol ipcWireProtocol, limits ipcV2Limits) error {
	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	if c.conn != conn {
		return errors.New("IPC connection changed during negotiation")
	}
	c.protocol = protocol
	c.v2Limits = limits
	return nil
}

func (c *ipcClient) discard(conn net.Conn) {
	c.transportMu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.reader = nil
		c.protocol = ipcWireProtocolUnset
		c.v2Limits = ipcV2Limits{}
	}
	c.transportMu.Unlock()
	_ = conn.Close()
}

func (c *ipcClient) close() {
	c.transportMu.Lock()
	c.closed = true
	conn := c.conn
	c.conn = nil
	c.reader = nil
	c.protocol = ipcWireProtocolUnset
	c.v2Limits = ipcV2Limits{}
	c.transportMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// readBoundedJSONLine reads one JSONL frame without allowing bufio.Reader to
// accumulate an unbounded unterminated response. The byte limit excludes the
// trailing newline, matching the TypeScript server.
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
	if strings.HasPrefix(endpoint, "tcp://") {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return nil, err
		}
		return net.Dial("tcp", parsed.Host)
	}
	if strings.HasPrefix(endpoint, "unix://") {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return nil, err
		}
		return net.Dial("unix", parsed.Path)
	}
	return net.Dial("unix", endpoint)
}

func encodeValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case []byte:
		return map[string]interface{}{
			"$bytes": base64.StdEncoding.EncodeToString(typed),
		}
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, entry := range typed {
			out[i] = encodeValue(entry)
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, entry := range typed {
			out[key] = encodeValue(entry)
		}
		return out
	default:
		return value
	}
}

func decodeValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case []interface{}:
		out := make([]interface{}, len(typed))
		for i, entry := range typed {
			out[i] = decodeValue(entry)
		}
		return out
	case map[string]interface{}:
		if encoded, ok := typed["$bytes"].(string); ok {
			bytes, err := base64.StdEncoding.DecodeString(encoded)
			if err == nil {
				return bytes
			}
		}
		out := make(map[string]interface{}, len(typed))
		for key, entry := range typed {
			out[key] = decodeValue(entry)
		}
		return out
	default:
		return value
	}
}
