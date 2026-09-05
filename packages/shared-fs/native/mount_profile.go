package main

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

const mountProfileSchema = "peerbit.shared-fs.mount-profile.v1"

type mountProfileEvent struct {
	Schema     string                 `json:"schema"`
	Source     string                 `json:"source"`
	Phase      string                 `json:"phase"`
	Operation  string                 `json:"operation"`
	DurationNS int64                  `json:"durationNs"`
	OK         bool                   `json:"ok"`
	Detail     map[string]interface{} `json:"detail,omitempty"`
}

// mountProfiler is an opt-in report-only sink. It serializes complete NDJSON
// records so concurrent callbacks cannot interleave their output. Write errors
// are ignored: observation must never change filesystem behavior.
type mountProfiler struct {
	mu     sync.Mutex
	writer io.Writer
}

func newMountProfiler(writer io.Writer) *mountProfiler {
	return &mountProfiler{writer: writer}
}

func (p *mountProfiler) observe(source string, phase string, operation string, duration time.Duration, ok bool, detail map[string]interface{}) {
	if p == nil {
		return
	}
	durationNS := duration.Nanoseconds()
	if durationNS < 0 {
		durationNS = 0
	}
	record, err := json.Marshal(mountProfileEvent{
		Schema:     mountProfileSchema,
		Source:     source,
		Phase:      phase,
		Operation:  operation,
		DurationNS: durationNS,
		OK:         ok,
		Detail:     detail,
	})
	if err != nil {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	_, _ = p.writer.Write(append(record, '\n'))
}
