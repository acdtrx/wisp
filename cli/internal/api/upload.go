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
// end after the bound on the time without progress. An error of write's own
// (a file that cannot be read) is answered as it is.
func (c *Client) Upload(ctx context.Context, path, fileName string, write func(w io.Writer) error) ([]byte, error) {
	u := c.url(path, nil)
	ctx, watch, stop := watchIdle(ctx, c.uploadIdle)
	defer stop()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	var writeErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		writeErr = func() error {
			part, err := mw.CreateFormFile("file", fileName)
			if err != nil {
				return err
			}
			if err := write(idleWriter{w: part, watch: watch}); err != nil {
				return err
			}
			return mw.Close()
		}()
		pw.CloseWithError(writeErr) // nil: the body ends here
	}()
	res, err := c.send(ctx, http.MethodPost, path, nil, "application/json", pr, mw.FormDataContentType())
	pr.CloseWithError(errAnswered) // a write still under way fails, and the writer ends
	wg.Wait()
	if writeErr != nil && !errors.Is(writeErr, errAnswered) {
		if res != nil {
			res.Body.Close()
		}
		return nil, writeErr
	}
	if err != nil {
		return nil, stalled(ctx, u, c.uploadIdle, err)
	}
	defer res.Body.Close()
	body, err := readAnswer(u, res)
	if err != nil {
		return nil, stalled(ctx, u, c.uploadIdle, err)
	}
	return body, nil
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
