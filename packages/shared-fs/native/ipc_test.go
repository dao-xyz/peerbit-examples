package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type ipcEchoServer struct {
	listener     net.Listener
	connections  sync.Map
	connectionWG sync.WaitGroup
	acceptDone   chan struct{}
	closeOnce    sync.Once
	accepted     atomic.Uint64
	response     func(ipcRequest) ipcResponse
}

func startIPCEchoServer(tb testing.TB, result func(ipcRequest) interface{}) *ipcEchoServer {
	tb.Helper()
	return startIPCResponseServer(tb, func(request ipcRequest) ipcResponse {
		return ipcResponse{ID: request.ID, OK: true, Result: result(request)}
	})
}

func startIPCResponseServer(tb testing.TB, response func(ipcRequest) ipcResponse) *ipcEchoServer {
	tb.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatal(err)
	}
	server := &ipcEchoServer{
		listener:   listener,
		acceptDone: make(chan struct{}),
		response:   response,
	}
	go server.serve()
	tb.Cleanup(server.close)
	return server
}

func (s *ipcEchoServer) serve() {
	defer close(s.acceptDone)
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.accepted.Add(1)
		s.connections.Store(conn, struct{}{})
		s.connectionWG.Add(1)
		go s.serveConnection(conn)
	}
}

func (s *ipcEchoServer) serveConnection(conn net.Conn) {
	defer s.connectionWG.Done()
	defer s.connections.Delete(conn)
	defer conn.Close()
	reader := bufio.NewReader(conn)
	encoder := json.NewEncoder(conn)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return
		}
		var request ipcRequest
		if err := json.Unmarshal(line, &request); err != nil {
			return
		}
		if err := encoder.Encode(s.response(request)); err != nil {
			return
		}
	}
}

func (s *ipcEchoServer) close() {
	s.closeOnce.Do(func() {
		_ = s.listener.Close()
		<-s.acceptDone
		s.connections.Range(func(key, _ interface{}) bool {
			_ = key.(net.Conn).Close()
			return true
		})
		s.connectionWG.Wait()
	})
}

func TestIPCClientRoundTrip(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			return
		}
		var request ipcRequest
		if err := json.Unmarshal(line, &request); err != nil {
			return
		}
		_ = json.NewEncoder(conn).Encode(ipcResponse{
			ID:     request.ID,
			OK:     true,
			Result: map[string]interface{}{"$bytes": "aGVsbG8="},
		})
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	result, err := client.request("read", uint64(1), 5, 0)
	if err != nil {
		t.Fatal(err)
	}
	bytes, ok := result.([]byte)
	if !ok {
		t.Fatalf("expected []byte, got %T", result)
	}
	if string(bytes) != "hello" {
		t.Fatalf("expected hello, got %q", string(bytes))
	}
}

func TestIPCClientPreservesRetryableErrorCode(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			return
		}
		var request ipcRequest
		if err := json.Unmarshal(line, &request); err != nil {
			return
		}
		_ = json.NewEncoder(conn).Encode(ipcResponse{
			ID: request.ID,
			OK: false,
			Error: &ipcErrorObject{
				Code:    "EAGAIN",
				Message: "initial view is still settling",
			},
		})
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	_, err = client.request("open", "/file.txt", 2)
	if err == nil {
		t.Fatal("expected IPC request to fail")
	}
	ipc, ok := err.(*ipcError)
	if !ok {
		t.Fatalf("expected *ipcError, got %T", err)
	}
	if ipc.Code != "EAGAIN" {
		t.Fatalf("expected EAGAIN, got %q", ipc.Code)
	}
}

func TestWindowsStatModeAllowsSharedWrites(t *testing.T) {
	if got := platformStatMode(statModeDirectory|0o755, "windows"); got != statModeDirectory|0o777 {
		t.Fatalf("expected writable Windows directory mode, got %#o", got)
	}
	if got := platformStatMode(statModeRegular|0o644, "windows"); got != statModeRegular|0o666 {
		t.Fatalf("expected writable Windows file mode, got %#o", got)
	}
	if got := platformStatMode(statModeDirectory|0o755, "linux"); got != statModeDirectory|0o755 {
		t.Fatalf("expected Linux directory mode to be preserved, got %#o", got)
	}
}

func TestIPCClientReusesOneConnection(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return float64(1)
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()

	for i := 0; i < 2; i++ {
		if _, err := client.request("getattr", "/"); err != nil {
			t.Fatal(err)
		}
	}
	if got := server.accepted.Load(); got != 1 {
		t.Fatalf("expected one reused IPC connection, accepted %d", got)
	}
}

func TestIPCClientKeepsConnectionAfterBackendError(t *testing.T) {
	var requests atomic.Uint64
	server := startIPCResponseServer(t, func(request ipcRequest) ipcResponse {
		if requests.Add(1) == 1 {
			return ipcResponse{
				ID: request.ID,
				OK: false,
				Error: &ipcErrorObject{
					Code:    "EAGAIN",
					Message: "retry explicitly",
				},
			}
		}
		return ipcResponse{ID: request.ID, OK: true, Result: float64(2)}
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()

	if _, err := client.request("open", "/settling", 2); err == nil {
		t.Fatal("expected backend error")
	} else if ipc, ok := err.(*ipcError); !ok || ipc.Code != "EAGAIN" {
		t.Fatalf("expected EAGAIN IPC error, got %v", err)
	}
	if result, err := client.request("getattr", "/ready"); err != nil || result != float64(2) {
		t.Fatalf("request after backend error = (%v, %v), want (2, nil)", result, err)
	}
	if got := server.accepted.Load(); got != 1 {
		t.Fatalf("backend error discarded healthy connection; accepted %d", got)
	}
}

func TestIPCClientSerializesConcurrentRequests(t *testing.T) {
	server := startIPCEchoServer(t, func(request ipcRequest) interface{} {
		return float64(request.ID)
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()

	const callers = 16
	var callerWG sync.WaitGroup
	errors := make(chan error, callers)
	callerWG.Add(callers)
	for caller := 0; caller < callers; caller++ {
		go func() {
			defer callerWG.Done()
			if _, err := client.request("getattr", "/"); err != nil {
				errors <- err
			}
		}()
	}
	callerWG.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	if got := server.accepted.Load(); got != 1 {
		t.Fatalf("concurrent callers used %d connections, want one", got)
	}
}

func TestIPCClientCloseInterruptsStalledRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	connectionReady := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			connectionReady <- conn
		}
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	requestDone := make(chan error, 1)
	go func() {
		_, err := client.request("getattr", "/stalled")
		requestDone <- err
	}()

	var conn net.Conn
	select {
	case conn = <-connectionReady:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not accept stalled request connection")
	}
	defer conn.Close()
	requestReceived := make(chan struct{})
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		if _, err := bufio.NewReader(conn).ReadBytes('\n'); err != nil {
			return
		}
		close(requestReceived)
		_, _ = io.Copy(io.Discard, conn)
	}()

	select {
	case <-requestReceived:
	case <-time.After(2 * time.Second):
		t.Fatal("server did not receive stalled request")
	}
	closeDone := make(chan struct{})
	go func() {
		client.close()
		close(closeDone)
	}()
	select {
	case <-closeDone:
	case <-time.After(2 * time.Second):
		t.Fatal("client close did not interrupt stalled request")
	}
	select {
	case err := <-requestDone:
		if err == nil {
			t.Fatal("stalled request unexpectedly succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stalled request did not unblock after close")
	}
	select {
	case <-serverDone:
	case <-time.After(2 * time.Second):
		t.Fatal("server connection did not close")
	}
	if _, err := client.request("getattr", "/after-close"); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("request after close returned %v, want net.ErrClosed", err)
	}
}

func TestIPCClientReconnectsOnlyAfterFailedRequest(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	var accepted atomic.Uint64
	var handled atomic.Uint64
	firstClosed := make(chan struct{})
	serverDone := make(chan error, 1)
	go func() {
		for connectionIndex := 0; connectionIndex < 2; connectionIndex++ {
			conn, err := listener.Accept()
			if err != nil {
				serverDone <- err
				return
			}
			accepted.Add(1)
			line, err := bufio.NewReader(conn).ReadBytes('\n')
			if err != nil {
				_ = conn.Close()
				serverDone <- err
				return
			}
			var request ipcRequest
			if err := json.Unmarshal(line, &request); err != nil {
				_ = conn.Close()
				serverDone <- err
				return
			}
			handled.Add(1)
			if err := json.NewEncoder(conn).Encode(ipcResponse{
				ID:     request.ID,
				OK:     true,
				Result: float64(connectionIndex + 1),
			}); err != nil {
				_ = conn.Close()
				serverDone <- err
				return
			}
			if err := conn.Close(); err != nil {
				serverDone <- err
				return
			}
			if connectionIndex == 0 {
				close(firstClosed)
			}
		}
		serverDone <- nil
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	if result, err := client.request("getattr", "/first"); err != nil || result != float64(1) {
		t.Fatalf("first request = (%v, %v), want (1, nil)", result, err)
	}
	<-firstClosed

	// A lost transport has an ambiguous outcome for mutations. The client must
	// surface that failure instead of silently replaying the same operation.
	if _, err := client.request("mkdir", "/ambiguous"); err == nil {
		t.Fatal("expected the request on the closed connection to fail")
	}
	if result, err := client.request("getattr", "/after-reconnect"); err != nil || result != float64(2) {
		t.Fatalf("reconnected request = (%v, %v), want (2, nil)", result, err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(fmt.Errorf("IPC test server: %w", err))
	}
	if got := accepted.Load(); got != 2 {
		t.Fatalf("expected two connections after one transport failure, accepted %d", got)
	}
	if got := handled.Load(); got != 2 {
		t.Fatalf("expected no automatic replay, server handled %d requests", got)
	}
}

func TestIPCClientBoundsBase64ExpandedRequestsBeforeConnecting(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return float64(13)
	})
	data := []byte("bounded bytes")
	args := []interface{}{uint64(7), data, int64(0)}
	payload, err := json.Marshal(ipcRequest{
		ID:   1,
		Op:   "write",
		Args: encodeValue(args).([]interface{}),
	})
	if err != nil {
		t.Fatal(err)
	}

	exact := newIPCClient(
		"tcp://"+server.listener.Addr().String(),
		ipcClientOptions{maxRequestFrameBytes: len(payload)},
	)
	defer exact.close()
	if result, err := exact.request("write", args...); err != nil || result != float64(13) {
		t.Fatalf("exact-limit request = (%v, %v), want (13, nil)", result, err)
	}

	undersized := newIPCClient(
		"tcp://"+server.listener.Addr().String(),
		ipcClientOptions{maxRequestFrameBytes: len(payload) - 1},
	)
	defer undersized.close()
	if _, err := undersized.request("write", args...); !errors.Is(err, errIPCFrameTooLarge) {
		t.Fatalf("oversized request returned %v, want errIPCFrameTooLarge", err)
	}
	if got := server.accepted.Load(); got != 1 {
		t.Fatalf("oversized request reached the server; accepted %d connections", got)
	}
}

func TestIPCClientBoundsResponsesAndAcceptsExactLimit(t *testing.T) {
	// Stay above bufio.Reader's internal buffer so the exact boundary also
	// exercises multi-fragment accumulation.
	result := map[string]interface{}{"value": strings.Repeat("x", 16*1024)}
	responseBytes, err := json.Marshal(ipcResponse{
		ID:     1,
		OK:     true,
		Result: result,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return result
	})

	exact := newIPCClient(
		"tcp://"+server.listener.Addr().String(),
		ipcClientOptions{maxResponseFrameBytes: len(responseBytes)},
	)
	defer exact.close()
	if _, err := exact.request("getattr", "/exact"); err != nil {
		t.Fatalf("exact-limit response failed: %v", err)
	}

	undersized := newIPCClient(
		"tcp://"+server.listener.Addr().String(),
		ipcClientOptions{maxResponseFrameBytes: len(responseBytes) - 1},
	)
	defer undersized.close()
	if _, err := undersized.request("getattr", "/oversized"); !errors.Is(err, errIPCFrameTooLarge) {
		t.Fatalf("oversized response returned %v, want errIPCFrameTooLarge", err)
	}
}
