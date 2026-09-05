package main

import (
	"fmt"
	"testing"
)

func benchmarkIPCClient(
	b *testing.B,
	op string,
	args []interface{},
	result func(ipcRequest) interface{},
	bytesPerOperation int64,
) {
	b.Helper()
	server := startIPCEchoServer(b, result)
	client := newIPCClient("tcp://" + server.listener.Addr().String())
	b.Cleanup(client.close)
	if bytesPerOperation > 0 {
		b.SetBytes(bytesPerOperation)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := client.request(op, args...); err != nil {
			b.Fatal(err)
		}
	}
	b.StopTimer()
	b.ReportMetric(float64(server.accepted.Load())/float64(b.N), "connections/op")
	if got := server.accepted.Load(); got != 1 {
		b.Fatalf("benchmark opened %d connections, want one", got)
	}
}

func BenchmarkIPCClientRoundTrip(b *testing.B) {
	b.Run("getattr", func(b *testing.B) {
		benchmarkIPCClient(
			b,
			"getattr",
			[]interface{}{"/bench"},
			func(ipcRequest) interface{} {
				return map[string]interface{}{
					"path":    "/bench",
					"kind":    "file",
					"size":    float64(4096),
					"mode":    float64(0o100644),
					"mtimeMs": float64(1),
					"ctimeMs": float64(1),
					"nlink":   float64(1),
				}
			},
			0,
		)
	})

	for _, size := range []int{4 << 10, 64 << 10, 1 << 20} {
		b.Run(fmt.Sprintf("write-%d", size), func(b *testing.B) {
			payload := make([]byte, size)
			benchmarkIPCClient(
				b,
				"write",
				[]interface{}{uint64(1), payload, 0},
				func(request ipcRequest) interface{} {
					return float64(len(request.Args[1].([]byte)))
				},
				int64(size),
			)
		})
		b.Run(fmt.Sprintf("read-%d", size), func(b *testing.B) {
			payload := make([]byte, size)
			benchmarkIPCClient(
				b,
				"read",
				[]interface{}{uint64(1), size, 0},
				func(ipcRequest) interface{} { return payload },
				int64(size),
			)
		})
	}
}
