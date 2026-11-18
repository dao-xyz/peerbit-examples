package main

import (
	"bufio"
	"io"
	"testing"
	"time"
)

// giveUpAfter bounds a wait that should end at once, so a hang fails the
// test instead of stalling the run. It is not a timing assertion.
const giveUpAfter = 30 * time.Second

func receiveWithin[T any](t *testing.T, channel <-chan T, what string) T {
	t.Helper()
	timer := time.NewTimer(giveUpAfter)
	defer timer.Stop()
	select {
	case value := <-channel:
		return value
	case <-timer.C:
		t.Fatalf("gave up after %v waiting for %s", giveUpAfter, what)
		panic("unreachable")
	}
}

// readLines delivers each line of reader, then closes the channel.
func readLines(reader io.Reader) <-chan string {
	lines := make(chan string, 16)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	return lines
}
