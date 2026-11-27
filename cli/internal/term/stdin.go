package term

import (
	"context"
	"fmt"
	"io"
	"time"
)

// StalledError is a standard input that sent nothing for its bound.
type StalledError struct{ After time.Duration }

func (e *StalledError) Error() string {
	return fmt.Sprintf("nothing came on standard input for %s: gave up", e.After)
}

// ReaderWithin reads r, standard input, through a goroutine of its own, and
// gives up once nothing came for d, or once ctx is done: a Read then answers
// a *StalledError, or ctx's error. As for ReadLineWithin, the blocked read is
// left behind, and the program, which has nothing more to read, ends with the
// error: its exit ends the read.
func ReaderWithin(ctx context.Context, r io.Reader, d time.Duration) io.Reader {
	b := &boundedReader{ctx: ctx, chunks: make(chan chunk, 1), d: d}
	go func() {
		for {
			buf := make([]byte, 64<<10)
			n, err := r.Read(buf)
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
			b.err = &StalledError{After: b.d}
		case <-b.ctx.Done():
			timer.Stop()
			b.err = b.ctx.Err()
		}
	}
	n := copy(p, b.pending)
	b.pending = b.pending[n:]
	return n, nil
}
