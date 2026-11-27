package api

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
	"time"
)

// errAnswered ends an upload's writing once the request has ended: the
// Wisp answered (a refusal before the whole body, often) or the request
// failed.
var errAnswered = errors.New("the request ended")

// Upload sends one multipart POST whose one file part, named fileName, is
// what write writes, streamed to the Wisp as it is written, and answers the
// 2xx body. An upload that stops moving, and an answer that does not come,
// end after the bound on the time without progress, whatever write waits
// on: write gets a context that ends at that bound, and as soon as the Wisp
// answers (an early refusal, most often), and it reads its source so that it
// returns then (term.SourceWithin). An answer that came wins over the bound,
// and an error of write's own (a file that cannot be read) is answered as it
// is.
func (c *Client) Upload(ctx context.Context, path, fileName string, write func(ctx context.Context, w io.Writer) error) ([]byte, error) {
	u := c.url(path, nil)
	ctx, watch, stop := watchIdle(ctx, c.uploadIdle)
	defer stop()
	writing, endWriting := context.WithCancelCause(ctx)
	defer endWriting(nil)
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	var ownErr error // write's failure while the request still ran: its source's, not the request's end
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		err := func() error {
			part, err := mw.CreateFormFile("file", fileName)
			if err != nil {
				return err
			}
			if err := write(writing, idleWriter{w: part, watch: watch}); err != nil {
				return err
			}
			return mw.Close()
		}()
		if err != nil && context.Cause(writing) == nil {
			ownErr = err
		}
		pw.CloseWithError(err) // nil: the body ends here
	}()
	res, err := c.send(ctx, http.MethodPost, path, nil, "application/json", pr, mw.FormDataContentType())
	endWriting(errAnswered) // the writer ends now, whatever it waits on
	pr.CloseWithError(errAnswered)
	wg.Wait()
	return uploadOutcome(u, c.uploadIdle, func() bool { return errors.Is(context.Cause(ctx), errIdle) }, res, ownErr, err)
}

// uploadOutcome is what an upload answers, first match: the Wisp's answer,
// when one came, even as the bound ran out (unless its body was cut by
// it); else the bound on its time without progress; its source's own
// error; the request's.
func uploadOutcome(u string, idle time.Duration, stalled func() bool, res *http.Response, ownErr, sendErr error) ([]byte, error) {
	if res != nil {
		defer res.Body.Close()
		body, err := readAnswer(u, res)
		var refused *Error
		var notWisp *NotWispError
		if err != nil && !errors.As(err, &refused) && !errors.As(err, &notWisp) && stalled() {
			return nil, &StalledError{URL: u, After: idle, Upload: true} // the answer's body was cut by the bound
		}
		return body, err
	}
	switch {
	case stalled():
		return nil, &StalledError{URL: u, After: idle, Upload: true}
	case ownErr != nil:
		return nil, ownErr
	default:
		return nil, sendErr
	}
}

// idleWriter touches the watch on every write that went through.
type idleWriter struct {
	w     io.Writer
	watch *idleWatch
}

func (w idleWriter) Write(p []byte) (int, error) {
	n, err := w.w.Write(p)
	if n > 0 {
		w.watch.touch()
	}
	return n, err
}
