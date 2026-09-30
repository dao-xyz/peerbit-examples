package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type ipcV2GoldenVectors struct {
	Constants struct {
		HeaderBytes      int `json:"headerBytes"`
		MaxFrameBytes    int `json:"maxFrameBytes"`
		MaxMetadataBytes int `json:"maxMetadataBytes"`
	} `json:"constants"`
	Negotiation []struct {
		Name         string `json:"name"`
		JSONLineUTF8 string `json:"jsonLineUtf8"`
		JSONLineHex  string `json:"jsonLineHex"`
	} `json:"negotiation"`
	Frames []struct {
		Name         string `json:"name"`
		KindCode     uint8  `json:"kindCode"`
		MetadataUTF8 string `json:"metadataUtf8"`
		BodyHex      string `json:"bodyHex"`
		FrameHex     string `json:"frameHex"`
	} `json:"frames"`
}

func loadIPCV2GoldenVectors(t *testing.T) ipcV2GoldenVectors {
	t.Helper()
	encoded, err := os.ReadFile("../protocol/ipc-v2-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors ipcV2GoldenVectors
	if err := json.Unmarshal(encoded, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

func TestIPCV2GoldenVectors(t *testing.T) {
	vectors := loadIPCV2GoldenVectors(t)
	if vectors.Constants.HeaderBytes != ipcV2HeaderBytes {
		t.Fatalf("golden header size is %d, implementation uses %d", vectors.Constants.HeaderBytes, ipcV2HeaderBytes)
	}
	for _, vector := range vectors.Negotiation {
		decoded, err := hex.DecodeString(vector.JSONLineHex)
		if err != nil {
			t.Fatal(err)
		}
		if string(decoded) != vector.JSONLineUTF8 {
			t.Fatal("golden negotiation UTF-8 and hex disagree")
		}
		if vector.Name == "version-offer" {
			// The adapter's own offer is byte-identical to the golden line:
			// it offers exactly [2] with the default limits and the token.
			offer, err := ipcNegotiationOfferLine(1, "AAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", ipcV2Limits{
				maxRequestFrameBytes: vectors.Constants.MaxFrameBytes, maxResponseFrameBytes: vectors.Constants.MaxFrameBytes,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(offer, decoded) {
				t.Fatalf("adapter offer %q differs from golden %q", offer, decoded)
			}
		}
	}
	for _, vector := range vectors.Frames {
		t.Run(vector.Name, func(t *testing.T) {
			encoded, err := hex.DecodeString(vector.FrameHex)
			if err != nil {
				t.Fatal(err)
			}
			frame, err := readIPCV2Frame(
				bufio.NewReader(bytes.NewReader(encoded)), vector.KindCode,
				vectors.Constants.MaxFrameBytes, vectors.Constants.MaxMetadataBytes,
			)
			if err != nil {
				t.Fatal(err)
			}
			if string(frame.metadata) != vector.MetadataUTF8 || hex.EncodeToString(frame.body) != vector.BodyHex {
				t.Fatalf("decoded frame = metadata %q body %x", frame.metadata, frame.body)
			}
		})
	}
}

type oneByteReader struct{ source io.Reader }

func (r oneByteReader) Read(destination []byte) (int, error) {
	if len(destination) > 1 {
		destination = destination[:1]
	}
	return r.source.Read(destination)
}

func TestIPCV2FramesHandleFragmentationAndCoalescing(t *testing.T) {
	first, err := encodeIPCV2Frame(
		ipcV2ResponseKind,
		map[string]interface{}{"id": 1, "ok": true, "result": map[string]interface{}{"$bytes": nil}},
		[]byte{0, 10, 255}, 1024, 512,
	)
	if err != nil {
		t.Fatal(err)
	}
	second, err := encodeIPCV2Frame(
		ipcV2ResponseKind,
		map[string]interface{}{"id": 2, "ok": true, "result": 7},
		nil, 1024, 512,
	)
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	for _, part := range [][]byte{first.header[:], first.metadata, first.body, second.header[:], second.metadata} {
		wire.Write(part)
	}
	reader := bufio.NewReaderSize(oneByteReader{source: bytes.NewReader(wire.Bytes())}, 1)
	decodedFirst, err := readIPCV2Frame(reader, ipcV2ResponseKind, 1024, 512)
	if err != nil || !bytes.Equal(decodedFirst.body, first.body) {
		t.Fatalf("fragmented first frame = (%x, %v)", decodedFirst.body, err)
	}
	decodedSecond, err := readIPCV2Frame(reader, ipcV2ResponseKind, 1024, 512)
	if err != nil || !bytes.Equal(decodedSecond.metadata, second.metadata) {
		t.Fatalf("coalesced second frame = (%q, %v)", decodedSecond.metadata, err)
	}
}

func TestIPCV2RejectsMalformedAndOversizedHeadersBeforeBodies(t *testing.T) {
	valid, err := encodeIPCV2Frame(
		ipcV2ResponseKind, map[string]interface{}{"id": 1, "ok": true, "result": nil}, nil, 1024, 512,
	)
	if err != nil {
		t.Fatal(err)
	}
	tests := map[string]func([]byte){
		"magic":   func(header []byte) { header[0] = 'X' },
		"version": func(header []byte) { header[4] = 3 },
		"kind":    func(header []byte) { header[5] = ipcV2RequestKind },
		"flags":   func(header []byte) { header[7] = 1 },
		"metadata limit": func(header []byte) {
			header[8], header[9], header[10], header[11] = 0, 0, 2, 1
		},
		"frame limit": func(header []byte) {
			header[8], header[9], header[10], header[11] = 0, 0, 1, 0
			header[12], header[13], header[14], header[15] = 0, 0, 3, 1
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			header := append([]byte(nil), valid.header[:]...)
			mutate(header)
			_, err := readIPCV2Frame(bufio.NewReader(bytes.NewReader(header)), ipcV2ResponseKind, 1024, 512)
			if err == nil {
				t.Fatal("malformed header was accepted")
			}
		})
	}
}

func TestIPCV2ResponseSentinelAndBodyValidation(t *testing.T) {
	tests := []struct {
		name      string
		operation string
		metadata  interface{}
		body      []byte
	}{
		{
			name: "read without sentinel", operation: "read",
			metadata: map[string]interface{}{"id": 1, "ok": true, "result": map[string]interface{}{"$bytes": "YQ=="}},
			body:     []byte("a"),
		},
		{
			name: "non-read with sentinel", operation: "getattr",
			metadata: map[string]interface{}{"id": 1, "ok": true, "result": map[string]interface{}{"nested": map[string]interface{}{"$bytes": nil}}},
		},
		{
			name: "non-read with body", operation: "getattr",
			metadata: map[string]interface{}{"id": 1, "ok": true, "result": nil}, body: []byte("unexpected"),
		},
		{
			name: "error with body", operation: "mkdir",
			metadata: map[string]interface{}{"id": 1, "ok": false, "error": map[string]interface{}{"message": "failed"}},
			body:     []byte("unexpected"),
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metadata, err := json.Marshal(test.metadata)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := parseIPCV2Response(ipcV2Frame{metadata: metadata, body: test.body}, 1, test.operation); err == nil {
				t.Fatal("invalid v2 response was accepted")
			}
		})
	}
}

// expectNoFurtherConnection proves the client did not reconnect: IPC v1 is
// retired, so a failed negotiation never falls back to another connection.
func expectNoFurtherConnection(t *testing.T, listener net.Listener) {
	t.Helper()
	_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(50 * time.Millisecond))
	if conn, err := listener.Accept(); err == nil {
		_ = conn.Close()
		t.Fatal("client opened another connection after a failed negotiation")
	} else if !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("unexpected accept result: %v", err)
	}
}

func TestIPCClientFailsClosedWhenServerRejectsNegotiation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err == nil {
			var request ipcRequest
			err = json.Unmarshal(line, &request)
			if err == nil && request.Op != ipcNegotiateOperation {
				err = errors.New("first line was not a negotiation")
			}
			if err == nil {
				err = json.NewEncoder(conn).Encode(ipcResponse{
					ID: request.ID, OK: false,
					Error: &ipcErrorObject{Code: "ENOSYS", Message: "unknown operation"},
				})
			}
		}
		serverDone <- err
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	_, err = client.request("mkdir", "/must-not-run")
	if !errors.Is(err, errIPCV2Unsupported) || !strings.Contains(err.Error(), "ENOSYS: unknown operation") {
		t.Fatalf("rejected negotiation returned %v", err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientPresentsTokenAndFailsClosedWhenServerRejectsIt(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		var request ipcNegotiationRequest
		if err == nil {
			err = json.Unmarshal(line, &request)
		}
		if err == nil && (len(request.Args) != 1 || request.Args[0].Token != "presented-token") {
			err = fmt.Errorf("offer %q did not present the token", line)
		}
		if err == nil {
			err = json.NewEncoder(conn).Encode(ipcResponse{
				ID: request.ID, OK: false,
				Error: &ipcErrorObject{Code: "EACCES", Message: "IPC authentication failed"},
			})
		}
		serverDone <- err
	}()

	client := newIPCClient("tcp://"+listener.Addr().String(), ipcClientOptions{token: "presented-token"})
	defer client.close()
	err = client.negotiate()
	if err == nil || errors.Is(err, errIPCV2Unsupported) || !strings.Contains(err.Error(), "rejected this adapter's token (EACCES: IPC authentication failed)") {
		t.Fatalf("rejected token returned %v", err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientFailsClosedWhenOldServerClosesNegotiation(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		// A pre-v2 server drops a connection whose first operation it does
		// not know.
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err == nil && !bytes.Contains(line, []byte(ipcNegotiateOperation)) {
			err = errors.New("old server did not receive negotiation")
		}
		_ = conn.Close()
		serverDone <- err
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	if err := client.negotiate(); !errors.Is(err, errIPCV2Unsupported) || !strings.Contains(err.Error(), "closed the connection") {
		t.Fatalf("closed negotiation returned %v", err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientNegotiatesEagerlyAndReusesThatConnection(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return float64(1)
	})
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	defer client.close()
	if err := client.negotiate(); err != nil {
		t.Fatal(err)
	}
	if err := client.negotiate(); err != nil {
		t.Fatal(err)
	}
	if result, err := client.request("getattr", "/"); err != nil || result != float64(1) {
		t.Fatalf("request after eager negotiation = (%v, %v), want (1, nil)", result, err)
	}
	if got := server.accepted.Load(); got != 1 {
		t.Fatalf("eager negotiation and request used %d connections, want one", got)
	}
}

func TestIPCClientRejectsAcknowledgementSelectingVersionOne(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			serverDone <- err
			return
		}
		var request ipcNegotiationRequest
		if err := json.Unmarshal(line, &request); err != nil || len(request.Args) != 1 {
			serverDone <- errors.New("invalid negotiation offer")
			return
		}
		if len(request.Args[0].Versions) != 1 || request.Args[0].Versions[0] != 2 {
			serverDone <- errors.New("adapter offered a version other than exactly 2")
			return
		}
		serverDone <- json.NewEncoder(conn).Encode(map[string]interface{}{
			"id": request.ID, "ok": true,
			"result": map[string]interface{}{
				"protocol": ipcProtocolName, "version": 1, "nonce": request.Args[0].Nonce,
			},
		})
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	if _, err := client.request("mkdir", "/must-not-run"); err == nil || !strings.Contains(err.Error(), "unoffered version") {
		t.Fatalf("version 1 acknowledgement returned %v", err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientRejectsMalformedAcknowledgement(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err != nil {
			serverDone <- err
			return
		}
		var request ipcNegotiationRequest
		if err := json.Unmarshal(line, &request); err != nil || len(request.Args) != 1 {
			serverDone <- errors.New("invalid negotiation offer")
			return
		}
		serverDone <- json.NewEncoder(conn).Encode(map[string]interface{}{
			"id": request.ID, "ok": true,
			"result": map[string]interface{}{
				"protocol": ipcProtocolName, "version": 2, "nonce": "wrong",
				"maxRequestFrameBytes":  request.Args[0].MaxRequestFrameBytes,
				"maxResponseFrameBytes": request.Args[0].MaxResponseFrameBytes,
				"maxMetadataBytes":      defaultIPCMaxMetadataBytes,
			},
		})
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	if _, err := client.request("mkdir", "/must-not-run"); err == nil || !strings.Contains(err.Error(), "nonce mismatch") {
		t.Fatalf("malformed acknowledgement returned %v", err)
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientNeverReplaysMutationAfterV2Bytes(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var mutations atomic.Uint64
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		reader, limits, err := acknowledgeTestIPCV2(conn)
		if err == nil {
			var frame ipcV2Frame
			frame, err = readIPCV2Frame(reader, ipcV2RequestKind, limits.maxRequestFrameBytes, limits.maxMetadataBytes)
			if err == nil {
				var request ipcRequest
				err = json.Unmarshal(frame.metadata, &request)
				if err == nil && request.Op != "mkdir" {
					err = errors.New("expected mkdir mutation")
				}
				if err == nil {
					mutations.Add(1)
				}
			}
		}
		_ = conn.Close() // deliberately lose the response after dispatch
		serverDone <- err
	}()

	client := newIPCClient("tcp://" + listener.Addr().String())
	defer client.close()
	if _, err := client.request("mkdir", "/ambiguous"); err == nil {
		t.Fatal("mutation with a lost response unexpectedly succeeded")
	}
	if err := <-serverDone; err != nil {
		t.Fatal(err)
	}
	if mutations.Load() != 1 {
		t.Fatalf("mutation dispatched %d times, want once", mutations.Load())
	}
	// Once mutation bytes were sent, the lost outcome is never replayed.
	expectNoFurtherConnection(t, listener)
}

func TestIPCClientNodeV2Interop(t *testing.T) {
	endpoint := os.Getenv("PEERBIT_SHARED_FS_NODE_V2_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("run by the Node IPC v2 integration test")
	}
	client := newIPCClient(endpoint, ipcClientOptions{token: os.Getenv(ipcTokenEnv)})
	defer client.close()
	result, err := client.request("getattr", "/interop.bin")
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := result.(map[string]interface{})
	if !ok || stat["path"] != "/interop.bin" {
		t.Fatalf("unexpected getattr result: %#v", result)
	}
	read, err := client.request("read", uint64(1), 6, 0)
	if err != nil {
		t.Fatal(err)
	}
	if payload, ok := read.([]byte); !ok || !bytes.Equal(payload, []byte{0, 10, 255, 1, 2, 3}) {
		t.Fatalf("unexpected read result: %#v", read)
	}
	written, err := client.request("write", uint64(1), []byte{3, 2, 1, 255, 10, 0}, 0)
	if err != nil || written != float64(6) {
		t.Fatalf("write result = (%#v, %v), want (6, nil)", written, err)
	}
}
