package main

import (
	"bufio"
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

type ipcClient struct {
	endpoint string
	nextID   uint64

	// cgofuse currently invokes this client from a serialized mount, but keep
	// requests serialized so a future concurrent mount cannot interleave JSON
	// frames. Transport state has a separate lock: close must be able to close
	// the socket and interrupt a request blocked waiting for its response.
	requestMu   sync.Mutex
	transportMu sync.Mutex
	conn        net.Conn
	reader      *bufio.Reader
	encoder     *json.Encoder
	closed      bool
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

func newIPCClient(endpoint string) *ipcClient {
	return &ipcClient{endpoint: endpoint}
}

func (c *ipcClient) request(op string, args ...interface{}) (interface{}, error) {
	c.requestMu.Lock()
	defer c.requestMu.Unlock()

	id := atomic.AddUint64(&c.nextID, 1)
	conn, reader, encoder, err := c.connect()
	if err != nil {
		return nil, err
	}

	request := ipcRequest{
		ID:   id,
		Op:   op,
		Args: encodeValue(args).([]interface{}),
	}
	if err := encoder.Encode(request); err != nil {
		c.discard(conn)
		return nil, err
	}

	line, err := reader.ReadBytes('\n')
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

func (c *ipcClient) connect() (net.Conn, *bufio.Reader, *json.Encoder, error) {
	c.transportMu.Lock()
	if c.closed {
		c.transportMu.Unlock()
		return nil, nil, nil, net.ErrClosed
	}
	if c.conn != nil {
		conn, reader, encoder := c.conn, c.reader, c.encoder
		c.transportMu.Unlock()
		return conn, reader, encoder, nil
	}
	c.transportMu.Unlock()

	conn, err := dialEndpoint(c.endpoint)
	if err != nil {
		return nil, nil, nil, err
	}
	reader := bufio.NewReader(conn)
	encoder := json.NewEncoder(conn)

	c.transportMu.Lock()
	defer c.transportMu.Unlock()
	if c.closed {
		_ = conn.Close()
		return nil, nil, nil, net.ErrClosed
	}
	// Requests are serialized, so another connection is not expected here.
	// Retain the defensive branch in case that invariant changes later.
	if c.conn != nil {
		_ = conn.Close()
		return c.conn, c.reader, c.encoder, nil
	}
	c.conn = conn
	c.reader = reader
	c.encoder = encoder
	return conn, reader, encoder, nil
}

func (c *ipcClient) discard(conn net.Conn) {
	c.transportMu.Lock()
	if c.conn == conn {
		c.conn = nil
		c.reader = nil
		c.encoder = nil
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
	c.encoder = nil
	c.transportMu.Unlock()
	if conn != nil {
		_ = conn.Close()
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
