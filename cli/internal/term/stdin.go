package term

import (
	"context"
	"fmt"
	"io"
	"time"
)

// StalledError is a source that sent nothing for its bound.
type StalledError struct {
	What  string // what was read: "standard input", a file's path
	After time.Duration
}

func (e *StalledError) Error() string {
	return fmt.Sprintf("nothing came from %s for %s: gave up", e.What, e.After)
}

// ReaderWithin is SourceWithin for r, standard input.
func ReaderWithin(ctx context.Context, r io.Reader, d time.Duration) io.Reader {
	return SourceWithin(ctx, "standard input", func() (io.ReadCloser, error) { return io.NopCloser(r), nil }, d)
}

// SourceWithin reads what open opens — standard input, or a file the user
// named — through a goroutine of its own, the open included, and gives up
// once nothing came for d, or once ctx is done: a Read then answers a
// *StalledError, or ctx's error. A read that never returns cannot be stopped
// on every platform the CLI ships for (a pipe, a FIFO, a stalled network
// share), so it is left behind, as for ReadLineWithin, and the program, which
// has nothing more to read, ends with the error: its exit ends the read.
func SourceWithin(ctx context.Context, what string, open func() (io.ReadCloser, error), d time.Duration) io.Reader {
	b := &boundedReader{ctx: ctx, what: what, chunks: make(chan chunk, 1), d: d}
	go func() {
		src, err := open()
		if err != nil {
			b.chunks <- chunk{nil, err}
			return
		}
		defer src.Close()
		for {
			buf := make([]byte, 64<<10)
			n, err := src.Read(buf)
			b.chunks <- chunk{buf[:n], err}
			if err != nil {
				return
			}
		}
	}()
	return b
}

type chunk struct {
	data []byte
	err  error
}

type boundedReader struct {
	ctx     context.Context
	what    string
	chunks  chan chunk
	d       time.Duration
	pending []byte
	err     error
}

func (b *boundedReader) Read(p []byte) (int, error) {
	for len(b.pending) == 0 {
		if b.err != nil {
			return 0, b.err
		}
		timer := time.NewTimer(b.d)
		select {
		case c := <-b.chunks:
			timer.Stop()
			b.pending, b.err = c.data, c.err
		case <-timer.C:
			b.err = &StalledError{What: b.what, After: b.d}
		case <-b.ctx.Done():
			timer.Stop()
			b.err = b.ctx.Err()
		}
	}
	n := copy(p, b.pending)
	b.pending = b.pending[n:]
	return n, nil
}
