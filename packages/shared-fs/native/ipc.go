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
	"sync/atomic"
)

type ipcClient struct {
	endpoint string
	nextID   uint64
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
	id := atomic.AddUint64(&c.nextID, 1)
	conn, err := dialEndpoint(c.endpoint)
	if err != nil {
		return nil, err
	}
	defer conn.Close()

	request := ipcRequest{
		ID:   id,
		Op:   op,
		Args: encodeValue(args).([]interface{}),
	}
	if err := json.NewEncoder(conn).Encode(request); err != nil {
		return nil, err
	}

	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var response ipcResponse
	if err := json.Unmarshal(line, &response); err != nil {
		return nil, err
	}
	if response.ID != id {
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
