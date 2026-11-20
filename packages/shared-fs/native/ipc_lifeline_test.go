package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// The lifeline ends when the server closes it, over TCP and Unix sockets.
func TestIPCLifelineEndsWhenTheServerClosesIt(t *testing.T) {
	runOnIPCNetworks(t, func(t *testing.T, listener net.Listener, endpoint string) {
		accepted := make(chan net.Conn, 1)
		go func() {
			conn, err := listener.Accept()
			if err != nil {
				close(accepted)
				return
			}
			if _, _, err := acknowledgeTestIPCV2(conn); err != nil {
				conn.Close()
				close(accepted)
				return
			}
			accepted <- conn
		}()
		lifeline, err := openIPCLifeline(endpoint, "token")
		if err != nil {
			t.Fatal(err)
		}
		defer lifeline.close()
		conn := receiveWithin(t, accepted, "the server to acknowledge")
		if conn == nil {
			t.Fatal("the server did not acknowledge the lifeline")
		}
		select {
		case err := <-lifeline.ended():
			t.Fatalf("lifeline ended while the server held it open: %v", err)
		default:
		}
		conn.Close()
		if err := receiveWithin(t, lifeline.ended(), "the lifeline to end"); err == nil {
			t.Fatal("a lifeline the server closed reported a local close")
		}
	})
}

// A lifeline the adapter closes itself reports no reason, so it never stops
// a mount on its own.
func TestIPCLifelineClosedLocallyReportsNoReason(t *testing.T) {
	server := startIPCEchoServer(t, func(ipcRequest) interface{} { return nil })
	lifeline, err := openIPCLifeline("tcp://"+server.listener.Addr().String(), "token")
	if err != nil {
		t.Fatal(err)
	}
	lifeline.close()
	if err := receiveWithin(t, lifeline.ended(), "the lifeline to end"); err != nil {
		t.Fatalf("locally closed lifeline reported %v", err)
	}
}

// The lifeline is an ordinary negotiated connection: it presents the token,
// and a server that rejects it fails the open.
func TestIPCLifelinePresentsTheToken(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	presented := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		var request ipcNegotiationRequest
		if err != nil || json.Unmarshal(line, &request) != nil || len(request.Args) != 1 {
			presented <- ""
			return
		}
		presented <- request.Args[0].Token
		_ = json.NewEncoder(conn).Encode(ipcResponse{
			ID: request.ID, OK: false,
			Error: &ipcErrorObject{Code: "EACCES", Message: "IPC authentication failed"},
		})
	}()
	if _, err := openIPCLifeline("tcp://"+listener.Addr().String(), "lifeline-token"); err == nil || !strings.Contains(err.Error(), "rejected this adapter's token") {
		t.Fatalf("rejected lifeline returned %v", err)
	}
	if token := receiveWithin(t, presented, "the offer"); token != "lifeline-token" {
		t.Fatalf("lifeline presented token %q", token)
	}
}

// When the process serving IPC is killed, its operating system closes the
// connection, and the lifeline ends: this is how an adapter learns that
// peerbit-fs died, on every OS.
func TestIPCLifelineEndsWhenTheServerProcessIsKilled(t *testing.T) {
	server := exec.Command(os.Args[0], "-test.run=^TestIPCLifelineHelperServer$")
	server.Env = append(os.Environ(), "PBFS_LIFELINE_HELPER=server")
	stdout, err := server.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	server.Stderr = os.Stderr
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = server.Process.Kill()
		_ = server.Wait()
	}()
	lines := readLines(stdout)
	line := receiveWithin(t, lines, "the helper server to listen")
	endpoint, listening := strings.CutPrefix(line, "endpoint ")
	if !listening {
		t.Fatalf("helper server said %q", line)
	}
	lifeline, err := openIPCLifeline(endpoint, "token")
	if err != nil {
		t.Fatal(err)
	}
	defer lifeline.close()
	if line := receiveWithin(t, lines, "the helper server to acknowledge"); line != "acknowledged" {
		t.Fatalf("helper server said %q", line)
	}
	select {
	case err := <-lifeline.ended():
		t.Fatalf("lifeline ended while the server process was alive: %v", err)
	default:
	}
	if err := server.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := receiveWithin(t, lifeline.ended(), "the lifeline to end after the kill"); err == nil {
		t.Fatal("lifeline of a killed server reported a local close")
	}
}

// TestIPCLifelineHelperServer is the process killed above: it acknowledges one
// lifeline and holds it, giving up after a minute.
func TestIPCLifelineHelperServer(t *testing.T) {
	if os.Getenv("PBFS_LIFELINE_HELPER") != "server" {
		t.Skip("helper process for TestIPCLifelineEndsWhenTheServerProcessIsKilled")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("endpoint tcp://%s\n", listener.Addr())
	conn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := acknowledgeTestIPCV2(conn); err != nil {
		t.Fatal(err)
	}
	fmt.Println("acknowledged")
	time.Sleep(time.Minute)
}
