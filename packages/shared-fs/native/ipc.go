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
)

const defaultIPCMaxFrameBytes = 64 * 1024 * 1024

var errIPCFrameTooLarge = errors.New("IPC frame exceeds configured byte limit")

type ipcClientOptions struct {
	maxRequestFrameBytes  int
	maxResponseFrameBytes int
}

type ipcClient struct {
	endpoint              string
	nextID                uint64
	maxRequestFrameBytes  int
	maxResponseFrameBytes int

	// cgofuse currently invokes this client from a serialized mount, but keep
	// requests serialized so a future concurrent mount cannot interleave JSON
	// frames. Transport state has a separate lock: close must be able to close
	// the socket and interrupt a request blocked waiting for its response.
	requestMu   sync.Mutex
	transportMu sync.Mutex
	conn        net.Conn
	reader      *bufio.Reader
	closed      bool
	requestJSON bytes.Buffer
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
	}
	return &ipcClient{
		endpoint:              endpoint,
		maxRequestFrameBytes:  options.maxRequestFrameBytes,
		maxResponseFrameBytes: options.maxResponseFrameBytes,
	}
}

func (c *ipcClient) request(op string, args ...interface{}) (interface{}, error) {
	c.requestMu.Lock()
	defer c.requestMu.Unlock()

	id := atomic.AddUint64(&c.nextID, 1)
	request := ipcRequest{
		ID:   id,
		Op:   op,
		Args: encodeValue(args).([]interface{}),
	}
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
	conn, reader, err := c.connect()
	if err != nil {
		return nil, err
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

func (c *ipcClient) connect() (net.Conn, *bufio.Reader, error) {
	c.transportMu.Lock()
	if c.closed {
		c.transportMu.Unlock()
		return nil, nil, net.ErrClosed
	}
	if c.conn != nil {
		conn, reader := c.conn, c.reader
		c.transportMu.Unlock()
		return conn, reader, nil
	}
	c.transportMu.Unlock()

	conn, err := dialEndpoint(c.endpoint)
	if err != nil {
		return nil, nil, err
	}
	reader := bufio.NewReader(conn)

	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	if c.closed {
		_ = conn.Close()
		return nil, nil, net.ErrClosed
	}
	// Requests are serialized, so another connection is not expected here.
	// Retain the defensive branch in case that invariant changes later.
	if c.conn != nil {
		_ = conn.Close()
		return c.conn, c.reader, nil
	}
	c.conn = conn
	c.reader = reader
	return conn, reader, nil
}

func (c *ipcClient) discard(conn net.Conn) {
	c.transportMu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.reader = nil
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
