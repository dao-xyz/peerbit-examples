package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"
)

const (
	nodeGoIPCEndpointEnv = "PEERBIT_SHARED_FS_NODE_GO_IPC_ENDPOINT"
	nodeGoIPCOutputEnv   = "PEERBIT_SHARED_FS_NODE_GO_IPC_OUTPUT"
	nodeGoIPCSamplesEnv  = "PEERBIT_SHARED_FS_NODE_GO_IPC_SAMPLES"
	nodeGoIPCWarmupsEnv  = "PEERBIT_SHARED_FS_NODE_GO_IPC_WARMUPS"
	nodeGoIPCCorpus      = "linear-v1:(index*131+size*17+29)%256"
)

var nodeGoIPCSizes = []int{4 << 10, 1 << 20}

type nodeGoIPCPlan struct {
	Name, Operation, Direction string
	LogicalBytes               int
}

type nodeGoIPCSample struct {
	DurationNs   int64  `json:"durationNs"`
	GoAllocBytes uint64 `json:"goAllocBytes"`
	GoMallocs    uint64 `json:"goMallocs"`
}

type nodeGoIPCSummary struct {
	Count                  int     `json:"count"`
	MinNs                  int64   `json:"minNs"`
	P50Ns                  int64   `json:"p50Ns"`
	P95Ns                  int64   `json:"p95Ns"`
	MaxNs                  int64   `json:"maxNs"`
	MeanNs                 float64 `json:"meanNs"`
	MeanGoAllocBytes       float64 `json:"meanGoAllocBytes"`
	MeanGoMallocs          float64 `json:"meanGoMallocs"`
	P50LogicalMiBPerSecond float64 `json:"p50LogicalMiBPerSecond,omitempty"`
}

type nodeGoIPCScenario struct {
	Name         string            `json:"name"`
	Operation    string            `json:"operation"`
	Direction    string            `json:"direction"`
	LogicalBytes int               `json:"logicalBytes,omitempty"`
	Samples      []nodeGoIPCSample `json:"samples"`
	Summary      nodeGoIPCSummary  `json:"summary"`
}

type nodeGoIPCScope struct {
	Boundary     string   `json:"boundary"`
	Transport    string   `json:"transport"`
	Backend      string   `json:"backend"`
	Measurement  string   `json:"measurement"`
	Verification string   `json:"verification"`
	Excludes     []string `json:"excludes"`
}

type nodeGoIPCRun struct {
	Warmups     int    `json:"warmupsPerScenario"`
	Samples     int    `json:"samplesPerScenario"`
	Concurrency int    `json:"concurrency"`
	Clock       string `json:"clock"`
	Percentiles string `json:"percentiles"`
}

type nodeGoIPCRuntime struct {
	GoVersion    string `json:"goVersion"`
	GoOS         string `json:"goOs"`
	GoArch       string `json:"goArch"`
	NodeVersion  string `json:"nodeVersion"`
	NodePlatform string `json:"nodePlatform"`
	NodeArch     string `json:"nodeArch"`
	CPUModel     string `json:"cpuModel"`
}

type nodeGoIPCReport struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Benchmark     string              `json:"benchmark"`
	Protocol      string              `json:"protocol"`
	Corpus        string              `json:"corpus"`
	Scope         nodeGoIPCScope      `json:"scope"`
	Run           nodeGoIPCRun        `json:"run"`
	Runtime       nodeGoIPCRuntime    `json:"runtime"`
	Scenarios     []nodeGoIPCScenario `json:"scenarios"`
}

func nodeGoIPCPlans() []nodeGoIPCPlan {
	plans := []nodeGoIPCPlan{{Name: "getattr", Operation: "getattr", Direction: "metadata-response"}}
	for _, size := range nodeGoIPCSizes {
		plans = append(plans,
			nodeGoIPCPlan{Name: fmt.Sprintf("read-%d", size), Operation: "read", Direction: "node-to-go", LogicalBytes: size},
			nodeGoIPCPlan{Name: fmt.Sprintf("write-%d", size), Operation: "write", Direction: "go-to-node", LogicalBytes: size},
		)
	}
	return plans
}

func nodeGoIPCExpectedByte(size, index int) byte {
	return byte((index*131 + size*17 + 29) % 256)
}

func nodeGoIPCPayload(size int) []byte {
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = nodeGoIPCExpectedByte(size, i)
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

func nodeGoIPCInteger(value interface{}) (int, bool) {
	number, ok := value.(float64)
	if !ok || math.Trunc(number) != number || number > float64(math.MaxInt) || number < float64(math.MinInt) {
		return 0, false
	}
	return int(number), true
}

func nodeGoIPCValidateGetattr(value interface{}) error {
	stat, ok := value.(map[string]interface{})
	if !ok || stat["path"] != "/bench/file.bin" || stat["kind"] != "file" {
		return fmt.Errorf("unexpected getattr result: %v", value)
	}
	for field, want := range map[string]int{"size": 1 << 20, "mode": 0o100644, "mtimeMs": 1, "ctimeMs": 1, "nlink": 1} {
		got, ok := nodeGoIPCInteger(stat[field])
		if !ok || got != want {
			return fmt.Errorf("getattr %s = %v, want %d", field, stat[field], want)
		}
	}
	return nil
}

func nodeGoIPCValidateRead(value interface{}, size int) error {
	payload, ok := value.([]byte)
	if !ok {
		return fmt.Errorf("read returned %T, want []byte", value)
	}
	if len(payload) != size {
		return fmt.Errorf("read returned %d bytes, want %d", len(payload), size)
	}
	for i, actual := range payload {
		if want := nodeGoIPCExpectedByte(size, i); actual != want {
			return fmt.Errorf("read byte %d = %d, want %d", i, actual, want)
		}
	}
	return nil
}

// Allocation counters are read outside the timer. Their deltas cover the Go
// process only, not Node or the whole system.
func nodeGoIPCMeasure(call func() (interface{}, error)) (interface{}, nodeGoIPCSample, error) {
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	started := time.Now()
	result, err := call()
	duration := time.Since(started)
	runtime.ReadMemStats(&after)
	return result, nodeGoIPCSample{
		DurationNs:   duration.Nanoseconds(),
		GoAllocBytes: after.TotalAlloc - before.TotalAlloc,
		GoMallocs:    after.Mallocs - before.Mallocs,
	}, err
}

func nodeGoIPCRunOnce(client *ipcClient, plan nodeGoIPCPlan, writePayload []byte) (nodeGoIPCSample, error) {
	var call func() (interface{}, error)
	switch plan.Operation {
	case "getattr":
		call = func() (interface{}, error) { return client.request("getattr", "/bench/file.bin") }
	case "read":
		call = func() (interface{}, error) { return client.request("read", uint64(1), plan.LogicalBytes, 0) }
	case "write":
		if len(writePayload) != plan.LogicalBytes {
			return nodeGoIPCSample{}, fmt.Errorf("write payload has %d bytes, want %d", len(writePayload), plan.LogicalBytes)
		}
		call = func() (interface{}, error) { return client.request("write", uint64(1), writePayload, 0) }
	default:
		return nodeGoIPCSample{}, fmt.Errorf("unsupported operation %q", plan.Operation)
	}
	result, sample, err := nodeGoIPCMeasure(call)
	if err != nil {
		return sample, err
	}
	// Complete validation starts after the monotonic timer stops.
	switch plan.Operation {
	case "getattr":
		err = nodeGoIPCValidateGetattr(result)
	case "read":
		err = nodeGoIPCValidateRead(result, plan.LogicalBytes)
	case "write":
		written, ok := nodeGoIPCInteger(result)
		if !ok || written != plan.LogicalBytes {
			err = fmt.Errorf("write returned %v, want %d", result, plan.LogicalBytes)
		} else {
			// The Node backend checks every received byte via this untimed op.
			_, err = client.request("fsync", uint64(1))
		}
	}
	return sample, err
}

func nodeGoIPCSummarize(samples []nodeGoIPCSample, logicalBytes int) nodeGoIPCSummary {
	durations := make([]int64, len(samples))
	var durationTotal int64
	var bytesTotal, mallocsTotal uint64
	for i, sample := range samples {
		durations[i] = sample.DurationNs
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
		Count:            len(samples),
		MinNs:            durations[0],
		P50Ns:            p50,
		P95Ns:            nearestRank(0.95),
		MaxNs:            durations[len(durations)-1],
		MeanNs:           float64(durationTotal) / float64(len(samples)),
		MeanGoAllocBytes: float64(bytesTotal) / float64(len(samples)),
		MeanGoMallocs:    float64(mallocsTotal) / float64(len(samples)),
	}
	if logicalBytes > 0 {
		summary.P50LogicalMiBPerSecond = (float64(logicalBytes) / (1024 * 1024)) / (float64(p50) / 1e9)
	}
	return summary
}

func TestNodeGoIPCBenchmarkPlan(t *testing.T) {
	plans := nodeGoIPCPlans()
	if len(plans) != 5 || plans[3].Name != "read-1048576" || plans[4].Name != "write-1048576" {
		t.Fatalf("unexpected stable scenario plan: %+v", plans)
	}
	payload := nodeGoIPCPayload(4096)
	if len(payload) != 4096 || payload[0] != nodeGoIPCExpectedByte(4096, 0) || payload[4095] != nodeGoIPCExpectedByte(4096, 4095) {
		t.Fatal("deterministic payload helper is inconsistent")
	}
	summary := nodeGoIPCSummarize([]nodeGoIPCSample{{DurationNs: 3}, {DurationNs: 1}, {DurationNs: 2}}, 0)
	if summary.MinNs != 1 || summary.P50Ns != 2 || summary.P95Ns != 3 || summary.MaxNs != 3 {
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
	client := newIPCClient(endpoint)
	defer client.close()

	report := nodeGoIPCReport{SchemaVersion: 1, Benchmark: "shared-fs-node-go-ipc", Protocol: "jsonl-v1-base64", Corpus: nodeGoIPCCorpus}
	report.Scope.Boundary = "real Go ipcClient to real Node createSharedFsIpcServer"
	report.Scope.Transport = "serialized TCP loopback over one retained client connection"
	report.Scope.Backend = "deterministic immediate in-memory benchmark backend"
	report.Scope.Measurement = "Go encode/write/wait/decode plus Node decode/backend/encode/write"
	report.Scope.Verification = "results and read bytes checked after timers; write bytes checked by untimed fsync"
	report.Scope.Excludes = []string{"FUSE/macFUSE/WinFsp", "Peerbit and network replication", "storage and persistence", "durable acknowledgements", "mount syscall overhead"}
	report.Run.Warmups, report.Run.Samples, report.Run.Concurrency = warmups, sampleCount, 1
	report.Run.Clock, report.Run.Percentiles = "Go monotonic time.Now/time.Since", "nearest-rank"
	report.Runtime.GoVersion, report.Runtime.GoOS, report.Runtime.GoArch = runtime.Version(), runtime.GOOS, runtime.GOARCH
	report.Runtime.NodeVersion, report.Runtime.NodePlatform = os.Getenv("PEERBIT_SHARED_FS_NODE_VERSION"), os.Getenv("PEERBIT_SHARED_FS_NODE_PLATFORM")
	report.Runtime.NodeArch, report.Runtime.CPUModel = os.Getenv("PEERBIT_SHARED_FS_NODE_ARCH"), os.Getenv("PEERBIT_SHARED_FS_CPU_MODEL")

	for _, plan := range nodeGoIPCPlans() {
		var writePayload []byte
		if plan.Operation == "write" {
			// Allocate once before warmup so payload construction and its garbage
			// collection cannot vary from sample to sample.
			writePayload = nodeGoIPCPayload(plan.LogicalBytes)
		}
		for i := 0; i < warmups; i++ {
			if _, err := nodeGoIPCRunOnce(client, plan, writePayload); err != nil {
				t.Fatalf("%s warmup: %v", plan.Name, err)
			}
		}
		samples := make([]nodeGoIPCSample, sampleCount)
		for i := range samples {
			var err error
			samples[i], err = nodeGoIPCRunOnce(client, plan, writePayload)
			if err != nil || samples[i].DurationNs <= 0 {
				t.Fatalf("%s sample %d: duration=%d error=%v", plan.Name, i+1, samples[i].DurationNs, err)
			}
		}
		report.Scenarios = append(report.Scenarios, nodeGoIPCScenario{
			Name: plan.Name, Operation: plan.Operation, Direction: plan.Direction,
			LogicalBytes: plan.LogicalBytes, Samples: samples,
			Summary: nodeGoIPCSummarize(samples, plan.LogicalBytes),
		})
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
