package api

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"sync"
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
	if errors.Is(context.Cause(ctx), errIdle) {
		if res != nil {
			res.Body.Close()
		}
		return nil, &StalledError{URL: u, After: c.uploadIdle, Upload: true}
	}
	if ownErr != nil {
		if res != nil {
			res.Body.Close()
		}
		return nil, ownErr
	}
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return readAnswer(u, res)
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
