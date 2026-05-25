package main

import (
	"bufio"
	"encoding/json"
	"net"
	"testing"
)

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
