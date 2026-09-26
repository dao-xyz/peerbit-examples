package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

func decodeMountProfileEvents(t *testing.T, output string) []mountProfileEvent {
	t.Helper()
	lines := strings.Split(strings.TrimSpace(output), "\n")
	events := make([]mountProfileEvent, 0, len(lines))
	for _, line := range lines {
		var event mountProfileEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("decode profile event %q: %v", line, err)
		}
		events = append(events, event)
	}
	return events
}

func TestMountProfilerWritesOneCompleteEvent(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output)
	profile.observe(
		"native-adapter",
		"native.callback",
		"write",
		17*time.Nanosecond,
		false,
		map[string]interface{}{"bytes": 4},
	)

	events := decodeMountProfileEvents(t, output.String())
	if len(events) != 1 {
		t.Fatalf("got %d events, want one", len(events))
	}
	event := events[0]
	if event.Schema != mountProfileSchema || event.Source != "native-adapter" || event.Phase != "native.callback" || event.Operation != "write" {
		t.Fatalf("unexpected event identity: %#v", event)
	}
	if event.DurationNS != 17 || event.OK {
		t.Fatalf("unexpected event result: %#v", event)
	}
	if event.Detail["bytes"] != float64(4) {
		t.Fatalf("unexpected detail: %#v", event.Detail)
	}
}

func TestMountProfilerSerializesConcurrentEvents(t *testing.T) {
	var output bytes.Buffer
	profile := newMountProfiler(&output)
	const count = 128
	var group sync.WaitGroup
	group.Add(count)
	for index := 0; index < count; index++ {
		index := index
		go func() {
			defer group.Done()
			profile.observe(
				"native-adapter",
				"native.callback",
				"getattr",
				time.Duration(index)*time.Nanosecond,
				true,
				map[string]interface{}{"index": index},
			)
		}()
	}
	group.Wait()

	events := decodeMountProfileEvents(t, output.String())
	if len(events) != count {
		t.Fatalf("got %d events, want %d", len(events), count)
	}
	seen := make(map[int]bool, count)
	for _, event := range events {
		index := int(event.Detail["index"].(float64))
		if index < 0 || index >= count || seen[index] {
			t.Fatalf("unexpected concurrent event index %d", index)
		}
		seen[index] = true
	}
}

func TestIPCClientProfilesQueueAndRoundTrip(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} {
		return map[string]interface{}{"kind": "directory"}
	})
	var output bytes.Buffer
	client := newIPCClient(
		"tcp://"+server.listener.Addr().String(),
		ipcClientOptions{profile: newMountProfiler(&output)},
	)
	t.Cleanup(client.close)

	if _, err := client.request("getattr", "/"); err != nil {
		t.Fatal(err)
	}
	events := decodeMountProfileEvents(t, output.String())
	if len(events) != 2 {
		t.Fatalf("got %d events, want queue and round trip", len(events))
	}
	for index, phase := range []string{"ipc.queue", "ipc.roundTrip"} {
		event := events[index]
		if event.Phase != phase || event.Operation != "getattr" || !event.OK || event.DurationNS < 0 {
			t.Fatalf("event %d = %#v", index, event)
		}
	}
}
