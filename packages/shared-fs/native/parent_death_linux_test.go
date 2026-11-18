//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// Killing the process that started the adapter (as kill -9 of peerbit-fs
// does) sends the adapter SIGHUP, on which it unmounts. A stand-in parent starts a
// stand-in adapter, the test binary itself, whose init arms the signal as the
// adapter's does; the stand-in reports on a pipe the test reads.
func TestParentDeathSignalReachesTheAdapter(t *testing.T) {
	reports, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reports.Close()
	parent := exec.Command(os.Args[0], "-test.run=^TestParentDeathHelper$")
	parent.Env = append(os.Environ(), "PBFS_PARENT_DEATH_HELPER=parent")
	parent.ExtraFiles = []*os.File{writer}
	parent.Stderr = os.Stderr
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	defer func() {
		_ = parent.Process.Kill()
		_ = parent.Wait()
	}()
	lines := readLines(reports)
	if line := receiveWithin(t, lines, "the stand-in adapter to arm"); line != "armed" {
		t.Fatalf("stand-in adapter said %q", line)
	}
	if err := parent.Process.Signal(syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	_ = parent.Wait()
	if line := receiveWithin(t, lines, "the stand-in adapter's SIGHUP"); line != "hung up" {
		t.Fatalf("stand-in adapter said %q after its parent was killed, want hung up", line)
	}
}

// An adapter whose parent exited before the signal was armed has already been
// handed to another parent: it finds that out and refuses to start.
func TestParentDeathCheckRefusesAnAdapterWhoseParentIsGone(t *testing.T) {
	reports, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reports.Close()
	adapter := exec.Command(os.Args[0], "-test.run=^TestParentDeathHelper$")
	// This test's own parent stands in for the parent that is gone.
	adapter.Env = append(os.Environ(), "PBFS_PARENT_DEATH_HELPER=child", parentPIDEnv+"="+strconv.Itoa(os.Getppid()))
	adapter.ExtraFiles = []*os.File{writer}
	adapter.Stderr = os.Stderr
	if err := adapter.Start(); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	defer func() {
		_ = adapter.Process.Kill()
		_ = adapter.Wait()
	}()
	want := "refused: " + errParentGone.Error()
	if line := receiveWithin(t, readLines(reports), "the stand-in adapter's check"); line != want {
		t.Fatalf("stand-in adapter said %q, want %q", line, want)
	}
}

// TestParentDeathHelper is the stand-in parent and adapter. Each gives up
// after a minute, so none outlives a failed test for long.
func TestParentDeathHelper(t *testing.T) {
	role := os.Getenv("PBFS_PARENT_DEATH_HELPER")
	if role != "parent" && role != "child" {
		t.Skip("helper process for the parent-death tests")
	}
	// Only the helpers are started with the report pipe as fd 3.
	report := os.NewFile(3, "report")
	switch role {
	case "parent":
		adapter := exec.Command(os.Args[0], "-test.run=^TestParentDeathHelper$")
		adapter.Env = append(os.Environ(), "PBFS_PARENT_DEATH_HELPER=child", parentPIDEnv+"="+strconv.Itoa(os.Getpid()))
		adapter.ExtraFiles = []*os.File{report}
		adapter.Stderr = os.Stderr
		if err := adapter.Start(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Minute)
	case "child":
		// init has run armParentDeath, as in the adapter.
		if parentDeathErr != nil {
			fmt.Fprintf(report, "refused: %v\n", parentDeathErr)
			return
		}
		hangup := make(chan os.Signal, 1)
		signal.Notify(hangup, syscall.SIGHUP)
		fmt.Fprintln(report, "armed")
		select {
		case <-hangup:
			fmt.Fprintln(report, "hung up")
		case <-time.After(time.Minute):
		}
	}
}
