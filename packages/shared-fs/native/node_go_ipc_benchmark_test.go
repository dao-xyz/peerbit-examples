package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	nodeGoIPCEndpointEnv = "PEERBIT_SHARED_FS_NODE_GO_IPC_ENDPOINT"
	nodeGoIPCOutputEnv   = "PEERBIT_SHARED_FS_NODE_GO_IPC_OUTPUT"
	nodeGoIPCSamplesEnv  = "PEERBIT_SHARED_FS_NODE_GO_IPC_SAMPLES"
	nodeGoIPCWarmupsEnv  = "PEERBIT_SHARED_FS_NODE_GO_IPC_WARMUPS"
	nodeGoIPCWidthsEnv   = "PEERBIT_SHARED_FS_NODE_GO_IPC_ADAPTER_WIDTHS"
	nodeGoIPCParallelEnv = "PEERBIT_SHARED_FS_NODE_GO_IPC_PARALLELISM"
	nodeGoIPCMaxWidth    = 16
	nodeGoIPCMaxParallel = 64
	nodeGoIPCCorpus      = "linear-handle-v2:(index*131+size*17+handle*31+29)%256"
)

var nodeGoIPCSizes = []int{4 << 10, 1 << 20}

type nodeGoIPCPlan struct {
	Name, Operation, Direction string
	LogicalBytesPerItem        int
}

type nodeGoIPCSample struct {
	DurationNs   int64  `json:"durationNs"`
	GoAllocBytes uint64 `json:"goAllocBytes"`
	GoMallocs    uint64 `json:"goMallocs"`
}

type nodeGoIPCSummary struct {
	Count                           int     `json:"count"`
	MinNs                           int64   `json:"minNs"`
	P50Ns                           int64   `json:"p50Ns"`
	P95Ns                           int64   `json:"p95Ns"`
	MaxNs                           int64   `json:"maxNs"`
	MeanNs                          float64 `json:"meanNs"`
	MeanGoAllocBytes                float64 `json:"meanGoAllocBytes"`
	MeanGoMallocs                   float64 `json:"meanGoMallocs"`
	P50AggregateItemsPerSecond      float64 `json:"p50AggregateItemsPerSecond"`
	P50AggregateLogicalMiBPerSecond float64 `json:"p50AggregateLogicalMiBPerSecond,omitempty"`
}

type nodeGoIPCScenario struct {
	Name                string            `json:"name"`
	Operation           string            `json:"operation"`
	Direction           string            `json:"direction"`
	LogicalBytesPerItem int               `json:"logicalBytesPerItem,omitempty"`
	BatchItems          int               `json:"batchItems"`
	BatchLogicalBytes   int               `json:"batchLogicalBytes,omitempty"`
	Samples             []nodeGoIPCSample `json:"samples"`
	Summary             nodeGoIPCSummary  `json:"summary"`
}

type nodeGoIPCWidthReport struct {
	AdapterWidth        int                 `json:"adapterWidth"`
	WorkloadParallelism int                 `json:"workloadParallelism"`
	Scenarios           []nodeGoIPCScenario `json:"scenarios"`
}

type nodeGoIPCScope struct {
	Boundary     string   `json:"boundary"`
	Transport    string   `json:"transport"`
	Backend      string   `json:"backend"`
	Measurement  string   `json:"measurement"`
	Verification string   `json:"verification"`
	Scheduling   string   `json:"scheduling"`
	Excludes     []string `json:"excludes"`
}

type nodeGoIPCRun struct {
	Warmups             int    `json:"warmupsPerScenario"`
	Samples             int    `json:"samplesPerScenario"`
	AdapterWidths       []int  `json:"adapterWidths"`
	WorkloadParallelism int    `json:"workloadParallelism"`
	Clock               string `json:"clock"`
	Percentiles         string `json:"percentiles"`
}

type nodeGoIPCRuntime struct {
	GoVersion        string `json:"goVersion"`
	GoOS             string `json:"goOs"`
	GoArch           string `json:"goArch"`
	GoMaxProcs       int    `json:"goMaxProcs"`
	GoLogicalCPUs    int    `json:"goLogicalCpus"`
	NodeVersion      string `json:"nodeVersion"`
	NodePlatform     string `json:"nodePlatform"`
	NodeArch         string `json:"nodeArch"`
	NodeUvThreadpool string `json:"nodeUvThreadpoolSize"`
	CPUModel         string `json:"cpuModel"`
}

type nodeGoIPCReport struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Benchmark     string                 `json:"benchmark"`
	Protocol      string                 `json:"protocol"`
	Corpus        string                 `json:"corpus"`
	Scope         nodeGoIPCScope         `json:"scope"`
	Run           nodeGoIPCRun           `json:"run"`
	Runtime       nodeGoIPCRuntime       `json:"runtime"`
	Widths        []nodeGoIPCWidthReport `json:"widths"`
}

func nodeGoIPCPlans() []nodeGoIPCPlan {
	plans := []nodeGoIPCPlan{{Name: "getattr", Operation: "getattr", Direction: "metadata-response"}}
	for _, size := range nodeGoIPCSizes {
		plans = append(plans,
			nodeGoIPCPlan{Name: fmt.Sprintf("read-%d", size), Operation: "read", Direction: "node-to-go", LogicalBytesPerItem: size},
			nodeGoIPCPlan{Name: fmt.Sprintf("write-%d", size), Operation: "write", Direction: "go-to-node", LogicalBytesPerItem: size},
		)
	}
	return plans
}

func nodeGoIPCPath(item int) string {
	return fmt.Sprintf("/bench/file-%d.bin", item+1)
}

func nodeGoIPCExpectedByte(size, item, index int) byte {
	handle := item + 1
	return byte((index*131 + size*17 + handle*31 + 29) % 256)
}

func nodeGoIPCPayload(size, item int) []byte {
	payload := make([]byte, size)
	for index := range payload {
		payload[index] = nodeGoIPCExpectedByte(size, item, index)
	}
	return payload
}

func nodeGoIPCEnvInt(t *testing.T, name string, fallback, maximum int) int {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 || parsed > maximum {
		t.Fatalf("%s must be an integer from 0 through %d, got %q", name, maximum, value)
	}
	return parsed
}

func nodeGoIPCParseAdapterWidths(value string) ([]int, error) {
	if value == "" {
		return []int{1}, nil
	}
	parts := strings.Split(value, ",")
	if len(parts) > nodeGoIPCMaxWidth {
		return nil, fmt.Errorf("adapter width list has %d entries, limit is %d", len(parts), nodeGoIPCMaxWidth)
	}
	widths := make([]int, len(parts))
	seen := make(map[int]struct{}, len(parts))
	for index, part := range parts {
		parsed, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || parsed < 1 || parsed > nodeGoIPCMaxWidth {
			return nil, fmt.Errorf("adapter width %q must be an integer from 1 through %d", part, nodeGoIPCMaxWidth)
		}
		if _, duplicate := seen[parsed]; duplicate {
			return nil, fmt.Errorf("adapter width %d is duplicated", parsed)
		}
		seen[parsed] = struct{}{}
		widths[index] = parsed
	}
	return widths, nil
}

func nodeGoIPCInteger(value interface{}) (int, bool) {
	number, ok := value.(float64)
	if !ok || math.Trunc(number) != number || number > float64(math.MaxInt) || number < float64(math.MinInt) {
		return 0, false
	}
	return int(number), true
}

func nodeGoIPCValidateGetattr(value interface{}, item int) error {
	path := nodeGoIPCPath(item)
	stat, ok := value.(map[string]interface{})
	if !ok || stat["path"] != path || stat["kind"] != "file" {
		return fmt.Errorf("unexpected getattr result for %s: %v", path, value)
	}
	for field, want := range map[string]int{"size": 1 << 20, "mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1} {
		got, ok := nodeGoIPCInteger(stat[field])
		if !ok || got != want {
			return fmt.Errorf("getattr %s %s = %v, want %d", path, field, stat[field], want)
		}
	}
	return nil
}

func nodeGoIPCValidateRead(value interface{}, size, item int) error {
	payload, ok := value.([]byte)
	if !ok {
		return fmt.Errorf("read handle %d returned %T, want []byte", item+1, value)
	}
	if len(payload) != size {
		return fmt.Errorf("read handle %d returned %d bytes, want %d", item+1, len(payload), size)
	}
	for index, actual := range payload {
		if want := nodeGoIPCExpectedByte(size, item, index); actual != want {
			return fmt.Errorf("read handle %d byte %d = %d, want %d", item+1, index, actual, want)
		}
	}
	return nil
}

type nodeGoIPCBatchResult struct {
	value interface{}
	err   error
}

// The start barrier excludes goroutine construction from the wall-clock batch
// timer while retaining Go scheduling, encode/write/wait/decode, and Node work.
// Allocation counters likewise cover the timed Go process only.
func nodeGoIPCRunBatch(clients []*ipcClient, plan nodeGoIPCPlan, parallelism int, writePayloads [][]byte) (nodeGoIPCSample, error) {
	if len(clients) < 1 || parallelism < 1 {
		return nodeGoIPCSample{}, errors.New("IPC batch requires at least one client and work item")
	}
	if plan.Operation == "write" && len(writePayloads) != parallelism {
		return nodeGoIPCSample{}, fmt.Errorf("write payload count is %d, want %d", len(writePayloads), parallelism)
	}
	results := make([]nodeGoIPCBatchResult, parallelism)
	start := make(chan struct{})
	var ready, done sync.WaitGroup
	ready.Add(parallelism)
	done.Add(parallelism)
	for item := 0; item < parallelism; item++ {
		item := item
		client := clients[item%len(clients)]
		go func() {
			defer done.Done()
			ready.Done()
			<-start
			handle := uint64(item + 1)
			switch plan.Operation {
			case "getattr":
				results[item].value, results[item].err = client.request("getattr", nodeGoIPCPath(item))
			case "read":
				results[item].value, results[item].err = client.request("read", handle, plan.LogicalBytesPerItem, 0)
			case "write":
				payload := writePayloads[item]
				if len(payload) != plan.LogicalBytesPerItem {
					results[item].err = fmt.Errorf("write handle %d payload has %d bytes, want %d", handle, len(payload), plan.LogicalBytesPerItem)
					return
				}
				results[item].value, results[item].err = client.request("write", handle, payload, 0)
			default:
				results[item].err = fmt.Errorf("unsupported operation %q", plan.Operation)
			}
		}()
	}
	ready.Wait()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	close(start)
	done.Wait()
	duration := time.Since(started)
	runtime.ReadMemStats(&after)
	sample := nodeGoIPCSample{
		DurationNs:   duration.Nanoseconds(),
		GoAllocBytes: after.TotalAlloc - before.TotalAlloc,
		GoMallocs:    after.Mallocs - before.Mallocs,
	}
	for item, result := range results {
		if result.err != nil {
			return sample, fmt.Errorf("item %d: %w", item+1, result.err)
		}
		var err error
		switch plan.Operation {
		case "getattr":
			err = nodeGoIPCValidateGetattr(result.value, item)
		case "read":
			err = nodeGoIPCValidateRead(result.value, plan.LogicalBytesPerItem, item)
		case "write":
			written, ok := nodeGoIPCInteger(result.value)
			if !ok || written != plan.LogicalBytesPerItem {
				err = fmt.Errorf("write handle %d returned %v, want %d", item+1, result.value, plan.LogicalBytesPerItem)
			}
		}
		if err != nil {
			return sample, err
		}
	}
	if plan.Operation == "write" {
		// The shared Node backend verifies and clears each handle independently.
		// Keep this proof outside the transport timer but issue it concurrently so
		// verification cannot accidentally rely on one global pending-write slot.
		verificationErrors := make([]error, parallelism)
		var verified sync.WaitGroup
		verified.Add(parallelism)
		for item := 0; item < parallelism; item++ {
			item := item
			client := clients[item%len(clients)]
			go func() {
				defer verified.Done()
				_, verificationErrors[item] = client.request("fsync", uint64(item+1))
			}()
		}
		verified.Wait()
		for item, err := range verificationErrors {
			if err != nil {
				return sample, fmt.Errorf("write handle %d verification: %w", item+1, err)
			}
		}
	}
	return sample, nil
}

func nodeGoIPCSummarize(samples []nodeGoIPCSample, batchItems, batchLogicalBytes int) nodeGoIPCSummary {
	durations := make([]int64, len(samples))
	var durationTotal int64
	var bytesTotal, mallocsTotal uint64
	for index, sample := range samples {
		durations[index] = sample.DurationNs
		durationTotal += sample.DurationNs
		bytesTotal += sample.GoAllocBytes
		mallocsTotal += sample.GoMallocs
	}
	sort.Slice(durations, func(i, j int) bool { return durations[i] < durations[j] })
	nearestRank := func(percentile float64) int64 {
		index := int(math.Ceil(percentile*float64(len(durations)))) - 1
		if index < 0 {
			index = 0
		}
		return durations[index]
	}
	p50 := nearestRank(0.50)
	summary := nodeGoIPCSummary{
		Count:                      len(samples),
		MinNs:                      durations[0],
		P50Ns:                      p50,
		P95Ns:                      nearestRank(0.95),
		MaxNs:                      durations[len(durations)-1],
		MeanNs:                     float64(durationTotal) / float64(len(samples)),
		MeanGoAllocBytes:           float64(bytesTotal) / float64(len(samples)),
		MeanGoMallocs:              float64(mallocsTotal) / float64(len(samples)),
		P50AggregateItemsPerSecond: float64(batchItems) / (float64(p50) / 1e9),
	}
	if batchLogicalBytes > 0 {
		summary.P50AggregateLogicalMiBPerSecond = (float64(batchLogicalBytes) / (1024 * 1024)) / (float64(p50) / 1e9)
	}
	return summary
}

func TestNodeGoIPCBenchmarkPlan(t *testing.T) {
	plans := nodeGoIPCPlans()
	if len(plans) != 5 || plans[3].Name != "read-1048576" || plans[4].Name != "write-1048576" {
		t.Fatalf("unexpected stable scenario plan: %+v", plans)
	}
	payload := nodeGoIPCPayload(4096, 0)
	if len(payload) != 4096 || payload[0] != nodeGoIPCExpectedByte(4096, 0, 0) || payload[4095] != nodeGoIPCExpectedByte(4096, 0, 4095) {
		t.Fatal("deterministic payload helper is inconsistent")
	}
	if string(payload) == string(nodeGoIPCPayload(4096, 1)) {
		t.Fatal("distinct handles must use distinct deterministic payloads")
	}
	widths, err := nodeGoIPCParseAdapterWidths("1,2,4,8")
	if err != nil || fmt.Sprint(widths) != "[1 2 4 8]" {
		t.Fatalf("unexpected width parse: %v, %v", widths, err)
	}
	for _, invalid := range []string{"0", "17", "1,1", "1,"} {
		if _, err := nodeGoIPCParseAdapterWidths(invalid); err == nil {
			t.Fatalf("expected adapter widths %q to fail", invalid)
		}
	}
	summary := nodeGoIPCSummarize([]nodeGoIPCSample{{DurationNs: 3}, {DurationNs: 1}, {DurationNs: 2}}, 8, 8192)
	if summary.MinNs != 1 || summary.P50Ns != 2 || summary.P95Ns != 3 || summary.MaxNs != 3 || math.Abs(summary.P50AggregateItemsPerSecond-4e9) > 1 {
		t.Fatalf("unexpected summary: %+v", summary)
	}
}

// TestNodeGoIPCExternalBenchmark is manual and report-only. The Node
// orchestrator provides its endpoint; ordinary go test only compiles this path.
func TestNodeGoIPCExternalBenchmark(t *testing.T) {
	endpoint := os.Getenv(nodeGoIPCEndpointEnv)
	if endpoint == "" {
		t.Skipf("run through the Node orchestrator, which sets %s", nodeGoIPCEndpointEnv)
	}
	sampleCount := nodeGoIPCEnvInt(t, nodeGoIPCSamplesEnv, 30, 1000)
	if sampleCount < 1 {
		t.Fatal("sample count must be at least one")
	}
	warmups := nodeGoIPCEnvInt(t, nodeGoIPCWarmupsEnv, 2, 100)
	parallelism := nodeGoIPCEnvInt(t, nodeGoIPCParallelEnv, 1, nodeGoIPCMaxParallel)
	if parallelism < 1 {
		t.Fatal("workload parallelism must be at least one")
	}
	widths, err := nodeGoIPCParseAdapterWidths(os.Getenv(nodeGoIPCWidthsEnv))
	if err != nil {
		t.Fatalf("adapter widths: %v", err)
	}
	for _, width := range widths {
		if width > parallelism {
			t.Fatalf("adapter width %d exceeds workload parallelism %d", width, parallelism)
		}
	}

	report := nodeGoIPCReport{SchemaVersion: 2, Benchmark: "shared-fs-node-go-ipc-concurrency", Protocol: "binary-v2-raw-bytes", Corpus: nodeGoIPCCorpus}
	report.Scope.Boundary = "real Go ipcClient pool to real Node createSharedFsIpcServer"
	report.Scope.Transport = "serialized TCP loopback per retained client connection; concurrent across independent lanes"
	report.Scope.Backend = "deterministic immediate in-memory benchmark backend with per-handle write state"
	report.Scope.Measurement = "wall-clock concurrent batch: Go scheduling/encode/write/wait/decode plus Node decode/backend/encode/write"
	report.Scope.Verification = "distinct paths/handles and complete read/result checks after timers; per-handle write bytes checked by untimed fsync"
	report.Scope.Scheduling = "work item i uses retained adapter lane i modulo adapterWidth; all lanes negotiate before any warmup or sample"
	report.Scope.Excludes = []string{"FUSE/macFUSE/WinFsp", "Peerbit and network replication", "storage and persistence", "durable acknowledgements", "mount syscall overhead"}
	report.Run.Warmups, report.Run.Samples = warmups, sampleCount
	report.Run.AdapterWidths, report.Run.WorkloadParallelism = widths, parallelism
	report.Run.Clock, report.Run.Percentiles = "Go monotonic time.Now/time.Since", "nearest-rank"
	report.Runtime.GoVersion, report.Runtime.GoOS, report.Runtime.GoArch = runtime.Version(), runtime.GOOS, runtime.GOARCH
	report.Runtime.GoMaxProcs, report.Runtime.GoLogicalCPUs = runtime.GOMAXPROCS(0), runtime.NumCPU()
	report.Runtime.NodeVersion, report.Runtime.NodePlatform = os.Getenv("PEERBIT_SHARED_FS_NODE_VERSION"), os.Getenv("PEERBIT_SHARED_FS_NODE_PLATFORM")
	report.Runtime.NodeArch, report.Runtime.CPUModel = os.Getenv("PEERBIT_SHARED_FS_NODE_ARCH"), os.Getenv("PEERBIT_SHARED_FS_CPU_MODEL")
	report.Runtime.NodeUvThreadpool = os.Getenv("PEERBIT_SHARED_FS_NODE_UV_THREADPOOL_SIZE")

	for _, width := range widths {
		widthReport := func() nodeGoIPCWidthReport {
			clients := make([]*ipcClient, width)
			for index := range clients {
				clients[index] = newIPCClient(endpoint)
			}
			defer func() {
				for _, client := range clients {
					client.close()
				}
			}()
			// Keep negotiation outside every measured sample, including runs with
			// zero warmups, and prove every retained lane is v2 before timing.
			for lane, client := range clients {
				_, _, protocol, _, err := client.connect()
				if err != nil {
					t.Fatalf("adapter width %d lane %d negotiation: %v", width, lane+1, err)
				}
				if protocol != ipcWireProtocolV2 {
					t.Fatalf("adapter width %d lane %d negotiated protocol %d, want binary v2", width, lane+1, protocol)
				}
			}

			result := nodeGoIPCWidthReport{AdapterWidth: width, WorkloadParallelism: parallelism}
			for _, plan := range nodeGoIPCPlans() {
				var writePayloads [][]byte
				if plan.Operation == "write" {
					writePayloads = make([][]byte, parallelism)
					for item := range writePayloads {
						writePayloads[item] = nodeGoIPCPayload(plan.LogicalBytesPerItem, item)
					}
				}
				for index := 0; index < warmups; index++ {
					if _, err := nodeGoIPCRunBatch(clients, plan, parallelism, writePayloads); err != nil {
						t.Fatalf("width %d %s warmup: %v", width, plan.Name, err)
					}
				}
				samples := make([]nodeGoIPCSample, sampleCount)
				for index := range samples {
					var err error
					samples[index], err = nodeGoIPCRunBatch(clients, plan, parallelism, writePayloads)
					if err != nil || samples[index].DurationNs <= 0 {
						t.Fatalf("width %d %s sample %d: duration=%d error=%v", width, plan.Name, index+1, samples[index].DurationNs, err)
					}
				}
				batchLogicalBytes := plan.LogicalBytesPerItem * parallelism
				result.Scenarios = append(result.Scenarios, nodeGoIPCScenario{
					Name: plan.Name, Operation: plan.Operation, Direction: plan.Direction,
					LogicalBytesPerItem: plan.LogicalBytesPerItem, BatchItems: parallelism,
					BatchLogicalBytes: batchLogicalBytes, Samples: samples,
					Summary: nodeGoIPCSummarize(samples, parallelism, batchLogicalBytes),
				})
			}
			return result
		}()
		report.Widths = append(report.Widths, widthReport)
	}

	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if output := os.Getenv(nodeGoIPCOutputEnv); output != "" {
		if err := os.WriteFile(output, append(encoded, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	} else {
		fmt.Printf("PEERBIT_SHARED_FS_NODE_GO_IPC_REPORT=%s\n", encoded)
	}
}
