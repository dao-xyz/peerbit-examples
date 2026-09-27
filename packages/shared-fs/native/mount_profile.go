package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const (
	mountProfileSchema        = "peerbit.shared-fs.mount-profile"
	mountProfileSchemaVersion = 1
	mountProfileSource        = "native-adapter"
	// nativeProfileFileEnv names the NDJSON file the adapter appends profile
	// records to. An environment variable (rather than a flag) lets a newer
	// CLI enable profiling without making an older adapter reject its argv.
	nativeProfileFileEnv          = "PEERBIT_SHARED_FS_NATIVE_PROFILE_FILE"
	defaultMountProfileQueue      = 16384
	defaultMountProfileCloseLimit = 5 * time.Second
)

type mountProfileField uint16

const (
	profileRequestID mountProfileField = 1 << iota
	profileLocalPort
	profileConnected
	profileBytes
	profileOffset
	profileErrno
	profileCode
	profileTransport
)

// mountProfileRecord is copied by value into the bounded queue. It carries no
// maps or pointers, so an enabled emit does not allocate on the caller's path.
type mountProfileRecord struct {
	phase       string
	operation   string
	startUnixNs int64
	durationNs  int64
	ok          bool
	fields      mountProfileField
	requestID   uint64
	localPort   int
	bytes       int64
	offset      int64
	errno       int
	code        string
}

// mountProfiler is an opt-in, report-only NDJSON sink. Emitters never block:
// a record is either copied into a bounded channel or counted as dropped. One
// writer goroutine encodes and writes records, flushing whenever the queue is
// momentarily empty, and writes a final summary with the drop count on close.
// Write errors stop output but never change filesystem behavior.
type mountProfiler struct {
	records    chan mountProfileRecord
	mu         sync.RWMutex
	closed     bool
	emitted    atomic.Uint64
	dropped    atomic.Uint64
	done       chan struct{}
	closeOnce  sync.Once
	closeLimit time.Duration
	output     io.Writer
	closer     io.Closer
	startedAt  time.Time
	capacity   int
	pid        int

	// Owned by the writer goroutine until done is closed.
	written     uint64
	writeErrors uint64
}

func newMountProfiler(output io.Writer, capacity int) *mountProfiler {
	if capacity <= 0 {
		capacity = defaultMountProfileQueue
	}
	profiler := &mountProfiler{
		records:    make(chan mountProfileRecord, capacity),
		done:       make(chan struct{}),
		closeLimit: defaultMountProfileCloseLimit,
		output:     output,
		startedAt:  time.Now(),
		capacity:   capacity,
		pid:        os.Getpid(),
	}
	if closer, ok := output.(io.Closer); ok {
		profiler.closer = closer
	}
	go profiler.run()
	return profiler
}

// openMountProfilerFromEnv returns nil when profiling was not requested. A
// profile file that cannot be created is reported on stderr and the adapter
// continues unprofiled: diagnostics must never prevent a mount.
func openMountProfilerFromEnv(lookup func(string) string, diagnostics io.Writer) *mountProfiler {
	path := lookup(nativeProfileFileEnv)
	if path == "" {
		return nil
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		fmt.Fprintf(diagnostics, "peerbit-shared-fs-native: mount profiling disabled: %v\n", err)
		return nil
	}
	return newMountProfiler(file, defaultMountProfileQueue)
}

func (p *mountProfiler) emit(record mountProfileRecord) {
	if p == nil {
		return
	}
	p.mu.RLock()
	if p.closed {
		p.mu.RUnlock()
		return
	}
	p.emitted.Add(1)
	select {
	case p.records <- record:
	default:
		p.dropped.Add(1)
	}
	p.mu.RUnlock()
}

// close stops admission, drains the queue, writes the summary record, and
// closes the output. It waits at most closeLimit for a stalled writer so a
// wedged profile file cannot keep an unmounted adapter alive.
func (p *mountProfiler) close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closed = true
		close(p.records)
		p.mu.Unlock()
		timer := time.NewTimer(p.closeLimit)
		defer timer.Stop()
		select {
		case <-p.done:
		case <-timer.C:
		}
	})
}

func (p *mountProfiler) run() {
	defer close(p.done)
	writer := bufio.NewWriterSize(p.output, 64<<10)
	line := make([]byte, 0, 512)
	failed := false
	buffered := uint64(0)
	write := func(value []byte) bool {
		if failed {
			return false
		}
		if _, err := writer.Write(value); err != nil {
			failed = true
			p.writeErrors++
			return false
		}
		return true
	}
	flush := func() {
		if failed {
			return
		}
		if err := writer.Flush(); err != nil {
			failed = true
			p.writeErrors++
			return
		}
		p.written += buffered
		buffered = 0
	}

	line = p.appendMeta(line[:0], "profile.start", "open", 0, true)
	line = append(line, `,"detail":{"pid":`...)
	line = strconv.AppendInt(line, int64(p.pid), 10)
	line = append(line, `,"queueCapacity":`...)
	line = strconv.AppendInt(line, int64(p.capacity), 10)
	line = append(line, "}}\n"...)
	write(line)
	flush()

	for record := range p.records {
		line = appendMountProfileRecord(line[:0], &record)
		if write(line) {
			buffered++
		}
		if len(p.records) == 0 {
			flush()
		}
	}
	flush()

	dropped := p.dropped.Load()
	line = p.appendMeta(line[:0], "profile.summary", "close", time.Since(p.startedAt).Nanoseconds(), p.writeErrors == 0)
	line = append(line, `,"detail":{"pid":`...)
	line = strconv.AppendInt(line, int64(p.pid), 10)
	line = append(line, `,"queueCapacity":`...)
	line = strconv.AppendInt(line, int64(p.capacity), 10)
	line = append(line, `,"emitted":`...)
	line = strconv.AppendUint(line, p.emitted.Load(), 10)
	line = append(line, `,"written":`...)
	line = strconv.AppendUint(line, p.written, 10)
	line = append(line, `,"dropped":`...)
	line = strconv.AppendUint(line, dropped, 10)
	line = append(line, `,"writeErrors":`...)
	line = strconv.AppendUint(line, p.writeErrors, 10)
	line = append(line, "}}\n"...)
	write(line)
	flush()
	if p.closer != nil {
		_ = p.closer.Close()
	}
}

func (p *mountProfiler) appendMeta(line []byte, phase string, operation string, durationNs int64, ok bool) []byte {
	return appendMountProfileEnvelope(line, phase, operation, p.startedAt.UnixNano(), durationNs, ok)
}

func appendMountProfileEnvelope(line []byte, phase string, operation string, startUnixNs int64, durationNs int64, ok bool) []byte {
	line = append(line, `{"schema":"`+mountProfileSchema+`","schemaVersion":`...)
	line = strconv.AppendInt(line, mountProfileSchemaVersion, 10)
	line = append(line, `,"source":"`+mountProfileSource+`","phase":`...)
	line = appendJSONString(line, phase)
	line = append(line, `,"operation":`...)
	line = appendJSONString(line, operation)
	line = append(line, `,"startUnixNs":"`...)
	line = strconv.AppendInt(line, startUnixNs, 10)
	line = append(line, `","durationNs":`...)
	if durationNs < 0 {
		durationNs = 0
	}
	line = strconv.AppendInt(line, durationNs, 10)
	line = append(line, `,"ok":`...)
	line = strconv.AppendBool(line, ok)
	return line
}

func appendMountProfileRecord(line []byte, record *mountProfileRecord) []byte {
	line = appendMountProfileEnvelope(line, record.phase, record.operation, record.startUnixNs, record.durationNs, record.ok)
	if record.fields == 0 {
		return append(line, "}\n"...)
	}
	line = append(line, `,"detail":{`...)
	first := true
	key := func(name string) {
		if !first {
			line = append(line, ',')
		}
		first = false
		line = append(line, '"')
		line = append(line, name...)
		line = append(line, `":`...)
	}
	if record.fields&profileRequestID != 0 {
		key("requestId")
		line = strconv.AppendUint(line, record.requestID, 10)
	}
	if record.fields&profileLocalPort != 0 {
		key("localPort")
		line = strconv.AppendInt(line, int64(record.localPort), 10)
	}
	if record.fields&profileConnected != 0 {
		key("connected")
		line = append(line, "true"...)
	}
	if record.fields&profileBytes != 0 {
		key("bytes")
		line = strconv.AppendInt(line, record.bytes, 10)
	}
	if record.fields&profileOffset != 0 {
		key("offset")
		line = strconv.AppendInt(line, record.offset, 10)
	}
	if record.fields&profileErrno != 0 {
		key("errno")
		line = strconv.AppendInt(line, int64(record.errno), 10)
	}
	if record.fields&profileCode != 0 {
		key("code")
		line = appendJSONString(line, record.code)
	}
	if record.fields&profileTransport != 0 {
		key("transport")
		line = append(line, "true"...)
	}
	return append(line, "}}\n"...)
}

// appendJSONString writes identifiers directly and falls back to the standard
// encoder for anything that needs escaping (for example, a peer error code).
func appendJSONString(line []byte, value string) []byte {
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character < 0x20 || character > 0x7e || character == '"' || character == '\\' {
			encoded, err := json.Marshal(value)
			if err != nil {
				return append(line, `""`...)
			}
			return append(line, encoded...)
		}
	}
	line = append(line, '"')
	line = append(line, value...)
	return append(line, '"')
}

// ipcProfileErrorCode reports the Node backend code when the daemon returned
// one. Transport, framing, and decode failures surface to the kernel as EIO,
// so they are reported as EIO with transport=true.
func ipcProfileErrorCode(err error) (code string, transport bool) {
	if ipc, ok := err.(*ipcError); ok && ipc.Code != "" {
		return ipc.Code, false
	}
	if _, ok := err.(*ipcError); ok {
		return "EIO", false
	}
	return "EIO", true
}
