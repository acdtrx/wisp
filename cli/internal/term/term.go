// Package term reads standard input: a secret from the terminal with the
// typing hidden, through the system's own terminal calls (one file per
// platform), and a line or a stream with a bound on the wait.
package term

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"
)

const maxLine = 4096

// ReadLine reads one line from r, up to maxLine bytes, without the line end.
// It reads byte by byte, so nothing past the line is taken from r.
func ReadLine(r io.Reader) (string, error) {
	var b strings.Builder
	buf := make([]byte, 1)
	for {
		n, err := r.Read(buf)
		if n == 1 {
			if buf[0] == '\n' {
				break
			}
			if b.Len() >= maxLine {
				return "", fmt.Errorf("the line is over %d bytes", maxLine)
			}
			b.WriteByte(buf[0])
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("read the line: %w", err)
		}
	}
	return strings.TrimRight(b.String(), "\r"), nil
}

// ErrNoLine is a line that did not come within the bound.
var ErrNoLine = errors.New("no line came")

// ReadLineWithin is ReadLine, given up after d: a standard input left open
// with nothing written to it must not hold the program forever.
//
// A blocked read of standard input cannot be stopped on every platform the
// CLI ships for (a pipe takes no deadline on Windows), so on the bound the
// read is left behind, and the program, which has nothing more to read,
// ends with the error: its exit ends the read. This, and SourceWithin's, are
// the CLI's only goroutines without an owner that waits for them.
func ReadLineWithin(r io.Reader, d time.Duration) (string, error) {
	type read struct {
		line string
		err  error
	}
	done := make(chan read, 1) // buffered: a read that ends after the bound never blocks
	go func() {
		line, err := ReadLine(r)
		done <- read{line, err}
	}()
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case got := <-done:
		return got.line, got.err
	case <-timer.C:
		return "", ErrNoLine
	}
}

// readLineRestoring reads a line with the terminal changed, and puts it back
// as it was, on an interrupt too: an interrupt ends the program with the
// terminal restored, rather than leave it without echo.
func readLineRestoring(r io.Reader, restore func()) (string, error) {
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		select {
		case <-interrupt:
			restore()
			fmt.Fprintln(os.Stderr)
			os.Exit(1)
		case <-done:
		}
	}()
	line, err := ReadLine(r)
	close(done)
	wg.Wait()
	signal.Stop(interrupt)
	restore()
	return line, err
}
