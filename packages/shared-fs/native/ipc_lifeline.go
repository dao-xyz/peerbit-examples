package main

import (
	"bufio"
	"io"
	"net"
	"sync/atomic"
)

// ipcLifeline is a negotiated IPC connection that carries no requests. The
// server writes only responses, so a read on it returns only when the
// connection ends: when peerbit-fs closes its IPC server or exits, however it
// exits, since the operating system closes a dead process's sockets.
type ipcLifeline struct {
	conn   net.Conn
	done   chan error
	closed atomic.Bool
}

func openIPCLifeline(endpoint, token string) (*ipcLifeline, error) {
	conn, err := dialIPC(endpoint)
	if err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	offer := ipcV2Limits{
		maxRequestFrameBytes:  defaultIPCMaxFrameBytes,
		maxResponseFrameBytes: defaultIPCMaxFrameBytes,
		maxMetadataBytes:      defaultIPCMaxMetadataBytes,
	}
	if _, err := negotiateIPCV2(conn, reader, token, offer); err != nil {
		closeConn(conn)
		return nil, err
	}
	lifeline := &ipcLifeline{conn: conn, done: make(chan error, 1)}
	go func() {
		_, err := io.Copy(io.Discard, reader)
		if lifeline.closed.Load() {
			err = nil
		} else if err == nil {
			err = io.EOF
		}
		lifeline.done <- err
	}()
	return lifeline, nil
}

// ended delivers, once, why the connection ended: nil after close.
func (l *ipcLifeline) ended() <-chan error {
	return l.done
}

func (l *ipcLifeline) close() {
	l.closed.Store(true)
	closeConn(l.conn)
}
