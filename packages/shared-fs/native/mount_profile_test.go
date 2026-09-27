package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

type decodedProfileRecord struct {
	Schema        string                 `json:"schema"`
	SchemaVersion int                    `json:"schemaVersion"`
	Source        string                 `json:"source"`
	Phase         string                 `json:"phase"`
	Operation     string                 `json:"operation"`
	StartUnixNs   string                 `json:"startUnixNs"`
	DurationNs    int64                  `json:"durationNs"`
	OK            bool                   `json:"ok"`
	Detail        map[string]interface{} `json:"detail"`
}

var unixNsPattern = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)

const testStartUnixNs = int64(1_790_000_000_000_000_000)

func decodeMountProfileRecords(t *testing.T, output string) []decodedProfileRecord {
	t.Helper()
	if !strings.HasSuffix(output, "\n") {
		t.Fatalf("profile output does not end with a complete line: %q", output)
	}
	lines := strings.Split(strings.TrimSuffix(output, "\n"), "\n")
	records := make([]decodedProfileRecord, 0, len(lines))
	for _, line := range lines {
		var record decodedProfileRecord
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode profile record %q: %v", line, err)
		}
		if record.Schema != mountProfileSchema || record.SchemaVersion != mountProfileSchemaVersion || record.Source != "native-adapter" {
			t.Fatalf("unexpected record envelope: %#v", record)
		}
		if !unixNsPattern.MatchString(record.StartUnixNs) || record.DurationNs < 0 {
			t.Fatalf("record has invalid time anchors: %#v", record)
		}
		records = append(records, record)
	}
	return records
}

// splitProfile returns the operational records between the start and summary
// meta records, failing unless both meta records are present exactly once.
func splitProfile(t *testing.T, records []decodedProfileRecord) ([]decodedProfileRecord, decodedProfileRecord) {
	t.Helper()
	if len(records) < 2 || records[0].Phase != "profile.start" || records[len(records)-1].Phase != "profile.summary" {
		t.Fatalf("profile is not framed by start and summary records: %#v", records)
	}
	return records[1 : len(records)-1], records[len(records)-1]
}

func detailNumber(t *testing.T, record decodedProfileRecord, key string) int64 {
	t.Helper()
	value, ok := record.Detail[key].(float64)
	if !ok {
		t.Fatalf("record detail %q is missing or not numeric: %#v", key, record.Detail)
	}
	return int64(value)
}

func TestMountProfilerWritesRecordAndSummary(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output, 4)
	profile.emit(mountProfileRecord{
		phase:       "native.callback",
		operation:   "write",
		startUnixNs: 1_790_000_000_123_456_789,
		durationNs:  17,
		ok:          false,
		fields:      profileBytes | profileOffset | profileErrno | profileCode,
		bytes:       4,
		offset:      8192,
		errno:       -2,
		code:        "ENOENT",
	})
	profile.close()
	profile.emit(mountProfileRecord{phase: "native.callback", operation: "after-close"})

	records, summary := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 1 {
		t.Fatalf("got %d records, want one", len(records))
	}
	record := records[0]
	if record.Phase != "native.callback" || record.Operation != "write" || record.OK {
		t.Fatalf("unexpected record identity: %#v", record)
	}
	if record.StartUnixNs != "1790000000123456789" || record.DurationNs != 17 {
		t.Fatalf("unexpected record timing: %#v", record)
	}
	if detailNumber(t, record, "bytes") != 4 || detailNumber(t, record, "offset") != 8192 ||
		detailNumber(t, record, "errno") != -2 || record.Detail["code"] != "ENOENT" {
		t.Fatalf("unexpected detail: %#v", record.Detail)
	}
	if detailNumber(t, summary, "emitted") != 1 || detailNumber(t, summary, "written") != 1 ||
		detailNumber(t, summary, "dropped") != 0 || detailNumber(t, summary, "writeErrors") != 0 ||
		detailNumber(t, summary, "queueCapacity") != 4 || !summary.OK {
		t.Fatalf("unexpected summary: %#v", summary)
	}
}

func TestMountProfilerKeepsConcurrentRecordsWhole(t *testing.T) {
	var output bytes.Buffer
	const count = 128
	profile := newMountProfiler(&output, count)
	var group sync.WaitGroup
	group.Add(count)
	for index := 0; index < count; index++ {
		index := index
		go func() {
			defer group.Done()
			profile.emit(mountProfileRecord{
				phase:       "native.callback",
				operation:   "getattr",
				startUnixNs: testStartUnixNs + int64(index),
				ok:          true,
				fields:      profileRequestID,
				requestID:   uint64(index + 1),
			})
		}()
	}
	group.Wait()
	profile.close()

	records, summary := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != count {
		t.Fatalf("got %d records, want %d", len(records), count)
	}
	seen := make(map[int64]bool, count)
	for _, record := range records {
		id := detailNumber(t, record, "requestId")
		if id < 1 || id > count || seen[id] {
			t.Fatalf("unexpected concurrent record id %d", id)
		}
		seen[id] = true
	}
	if detailNumber(t, summary, "emitted") != count || detailNumber(t, summary, "dropped") != 0 {
		t.Fatalf("unexpected summary: %#v", summary)
	}
}

func TestMountProfileRecordEscapesUntrustedCodes(t *testing.T) {
	line := appendMountProfileRecord(nil, &mountProfileRecord{
		phase:       "ipc.roundTrip",
		operation:   "getattr",
		startUnixNs: testStartUnixNs,
		fields:      profileCode,
		code:        "E\"ODD\\\n",
	})
	records := decodeMountProfileRecords(t, string(line))
	if records[0].Detail["code"] != "E\"ODD\\\n" {
		t.Fatalf("code was not round-tripped: %#v", records[0].Detail)
	}
}

func TestIPCClientProfilesQueueRoundTripConnectionAndFailure(t *testing.T) {
	server := startIPCResponseServer(t, func(request ipcRequest) ipcResponse {
		if request.Args[0] == "/missing" {
			return ipcResponse{ID: request.ID, OK: false, Error: &ipcErrorObject{Code: "ENOENT", Message: "missing"}}
		}
		return ipcResponse{ID: request.ID, OK: true, Result: map[string]interface{}{"kind": "directory"}}
	})
	var output bytes.Buffer
	profile := newMountProfiler(&output, 16)
	client := newIPCClient("tcp://"+server.listener.Addr().String(), ipcClientOptions{profile: profile})
	t.Cleanup(client.close)

	if _, err := client.request("getattr", "/"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.request("getattr", "/missing"); err == nil {
		t.Fatal("missing path unexpectedly succeeded")
	}
	client.close()
	profile.close()

	records, summary := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 4 || detailNumber(t, summary, "dropped") != 0 {
		t.Fatalf("got %d records and summary %#v, want two queue/round-trip pairs", len(records), summary)
	}
	for index, want := range []struct {
		phase     string
		requestID int64
		ok        bool
		connected bool
	}{
		{"ipc.queue", 1, true, false},
		{"ipc.roundTrip", 1, true, true},
		{"ipc.queue", 2, true, false},
		{"ipc.roundTrip", 2, false, false},
	} {
		record := records[index]
		if record.Phase != want.phase || record.Operation != "getattr" || record.OK != want.ok {
			t.Fatalf("record %d = %#v, want %+v", index, record, want)
		}
		if detailNumber(t, record, "requestId") != want.requestID {
			t.Fatalf("record %d request id = %#v", index, record.Detail)
		}
		if connected, _ := record.Detail["connected"].(bool); connected != want.connected {
			t.Fatalf("record %d connected = %#v, want %v", index, record.Detail, want.connected)
		}
	}
	firstPort := detailNumber(t, records[1], "localPort")
	if firstPort <= 0 || detailNumber(t, records[0], "localPort") != firstPort || detailNumber(t, records[3], "localPort") != firstPort {
		t.Fatalf("records do not share one retained connection port: %#v", records)
	}
	if records[3].Detail["code"] != "ENOENT" || records[3].Detail["transport"] != nil {
		t.Fatalf("backend failure was not classified: %#v", records[3].Detail)
	}
	if records[1].Detail["code"] != nil {
		t.Fatalf("successful round trip carried a failure code: %#v", records[1].Detail)
	}
}

func TestIPCClientProfilesTransportFailure(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output, 4)
	client := newIPCClient("tcp://127.0.0.1:1", ipcClientOptions{profile: profile})
	client.close()
	if _, err := client.request("getattr", "/"); err == nil {
		t.Fatal("closed client unexpectedly succeeded")
	}
	profile.close()

	records, _ := splitProfile(t, decodeMountProfileRecords(t, output.String()))
	if len(records) != 2 || records[1].Phase != "ipc.roundTrip" || records[1].OK {
		t.Fatalf("unexpected records: %#v", records)
	}
	if records[1].Detail["code"] != "EIO" || records[1].Detail["transport"] != true || records[1].Detail["localPort"] != nil {
		t.Fatalf("transport failure was not classified: %#v", records[1].Detail)
	}
}

type blockingWriter struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	mu      sync.Mutex
	output  bytes.Buffer
}

func (w *blockingWriter) Write(value []byte) (int, error) {
	w.once.Do(func() { close(w.entered) })
	<-w.release
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.output.Write(value)
}

// A profile writer that stops making progress must not hold the serialized
// IPC lane: later requests complete, and every record that cannot be queued is
// counted in the final summary instead of blocking or disappearing silently.
func TestBlockedProfileWriterDoesNotBlockRequestsAndCountsDrops(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return map[string]interface{}{"kind": "directory"}
	})
	writer := &blockingWriter{entered: make(chan struct{}), release: make(chan struct{})}
	profile := newMountProfiler(writer, 1)
	client := newIPCClient("tcp://"+server.listener.Addr().String(), ipcClientOptions{profile: profile})
	t.Cleanup(client.close)

	// The writer goroutine is now blocked writing the start record, so the
	// one-slot queue is the only remaining capacity.
	<-writer.entered
	for _, path := range []string{"/first", "/second"} {
		if _, err := client.request("getattr", path); err != nil {
			t.Fatalf("request %s while the profile writer is blocked: %v", path, err)
		}
	}
	if emitted, dropped := profile.emitted.Load(), profile.dropped.Load(); emitted != 4 || dropped != 3 {
		t.Fatalf("emitted=%d dropped=%d, want 4 emitted and 3 dropped", emitted, dropped)
	}

	close(writer.release)
	profile.close()
	writer.mu.Lock()
	output := writer.output.String()
	writer.mu.Unlock()
	records, summary := splitProfile(t, decodeMountProfileRecords(t, output))
	if len(records) != 1 || records[0].Phase != "ipc.queue" || detailNumber(t, records[0], "requestId") != 1 {
		t.Fatalf("unexpected surviving records: %#v", records)
	}
	if detailNumber(t, summary, "emitted") != 4 || detailNumber(t, summary, "written") != 1 || detailNumber(t, summary, "dropped") != 3 {
		t.Fatalf("summary does not account for drops: %#v", summary)
	}
}

func TestOpenMountProfilerFromEnv(t *testing.T) {
	var diagnostics bytes.Buffer
	if profile := openMountProfilerFromEnv(func(string) string { return "" }, &diagnostics); profile != nil {
		t.Fatal("profiling was enabled without the environment variable")
	}

	directory := t.TempDir()
	path := filepath.Join(directory, "native-adapter.ndjson")
	lookup := func(name string) string {
		if name != nativeProfileFileEnv {
			t.Fatalf("unexpected environment lookup %q", name)
		}
		return path
	}
	profile := openMountProfilerFromEnv(lookup, &diagnostics)
	if profile == nil {
		t.Fatalf("profiling was not enabled: %s", diagnostics.String())
	}
	profile.emit(mountProfileRecord{phase: "native.callback", operation: "statfs", startUnixNs: testStartUnixNs, ok: true})
	profile.close()
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	records, summary := splitProfile(t, decodeMountProfileRecords(t, string(written)))
	if len(records) != 1 || detailNumber(t, summary, "written") != 1 {
		t.Fatalf("unexpected file profile: %#v %#v", records, summary)
	}

	// An existing file is never truncated or appended to; the adapter keeps
	// running unprofiled and says why.
	if again := openMountProfilerFromEnv(lookup, &diagnostics); again != nil {
		again.close()
		t.Fatal("an existing profile file was reopened")
	}
	if !strings.Contains(diagnostics.String(), "mount profiling disabled") {
		t.Fatalf("missing diagnostic: %q", diagnostics.String())
	}
	unchanged, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(unchanged, written) {
		t.Fatalf("existing profile file changed: %v", err)
	}
}

// TestMountProfileNodeInterop is driven by the library's ipc.test.ts, which
// starts a real profiled Node IPC server and joins both processes' records.
func TestMountProfileNodeInterop(t *testing.T) {
	endpoint := os.Getenv("PEERBIT_SHARED_FS_NODE_PROFILE_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("set PEERBIT_SHARED_FS_NODE_PROFILE_TEST_ENDPOINT to run against a Node IPC server")
	}
	profile := openMountProfilerFromEnv(os.Getenv, os.Stderr)
	if profile == nil {
		t.Fatalf("%s did not enable profiling", nativeProfileFileEnv)
	}
	client := newIPCClient(endpoint, ipcClientOptions{profile: profile})
	if _, err := client.request("getattr", "/present"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.request("getattr", "/absent"); err == nil {
		t.Fatal("absent path unexpectedly succeeded")
	} else if typed, ok := err.(*ipcError); !ok || typed.Code != "ENOENT" {
		t.Fatalf("absent path returned %T %v", err, err)
	}
	if _, err := client.request("read", uint64(1), 3, 0); err != nil {
		t.Fatal(err)
	}
	client.close()
	profile.close()
}
