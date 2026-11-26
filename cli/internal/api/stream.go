package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strconv"
)

// ErrStreamEnded is a stream the Wisp closed before the caller had what it
// waited for.
var ErrStreamEnded = errors.New("the Wisp ended the stream")

// Stream reads a Server-Sent Events route: onEvent gets each event's data,
// and returns true when the caller has what it waited for, which ends the
// stream. An error frame (the error body as an event) is an *Error. A stream
// the Wisp ends first is ErrStreamEnded; one that sends nothing, not even its
// keepalive, for a minute is a *StalledError.
func (c *Client) Stream(ctx context.Context, path string, query url.Values, onEvent func(data []byte) (bool, error)) error {
	u := c.url(path, query)
	ctx, watch, stop := watchIdle(ctx, c.streamIdle)
	defer stop()
	res, err := c.do(ctx, path, query, "text/event-stream")
	if err != nil {
		return stalled(ctx, u, c.streamIdle, err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes)) // a refusal's body: whatever arrived is what there is to show
		return refusal(u, res, body)
	}
	reader := bufio.NewReader(idleReader{r: res.Body, w: watch})
	var data bytes.Buffer
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, io.EOF) {
				return ErrStreamEnded
			}
			return stalled(ctx, u, c.streamIdle, fmt.Errorf("read the stream %s: %w", u, err))
		}
		line = bytes.TrimRight(line, "\r\n")
		switch {
		case len(line) == 0:
			if data.Len() == 0 {
				continue
			}
			event := bytes.Clone(data.Bytes())
			data.Reset()
			if frame := errorFrame(event); frame != nil {
				return frame
			}
			done, err := onEvent(event)
			if err != nil || done {
				return err
			}
		case line[0] == ':':
			// A comment: the keepalive, which only proves the stream alive.
		case bytes.HasPrefix(line, []byte("data:")):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.Write(bytes.TrimPrefix(bytes.TrimPrefix(line, []byte("data:")), []byte(" ")))
		}
	}
}

// errorFrame is the *Error an event carries when it is the error body
// (`{ error, detail }`, docs/specs/ERROR-HANDLING.md), else nil. A job's error
// event, which has a `step`, is the job's own end, not this.
func errorFrame(event []byte) error {
	var frame struct {
		Error  *string         `json:"error"`
		Detail string          `json:"detail"`
		Step   json.RawMessage `json:"step"`
	}
	if json.Unmarshal(event, &frame) != nil || frame.Error == nil || frame.Step != nil {
		return nil
	}
	return &Error{Code: *frame.Error, Message: frame.Detail, Body: event}
}

// Download copies a binary route's body to dst and answers its size. An
// answer shorter than its Content-Length is an error, so a download cut off
// is never taken for the file.
func (c *Client) Download(ctx context.Context, path string, dst io.Writer) (int64, error) {
	u := c.url(path, nil)
	ctx, watch, stop := watchIdle(ctx, c.downloadIdle)
	defer stop()
	res, err := c.do(ctx, path, nil, "application/octet-stream")
	if err != nil {
		return 0, stalled(ctx, u, c.downloadIdle, err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes)) // a refusal's body: whatever arrived is what there is to show
		return 0, refusal(u, res, body)
	}
	n, err := io.Copy(dst, idleReader{r: res.Body, w: watch})
	if err != nil {
		return n, stalled(ctx, u, c.downloadIdle, fmt.Errorf("download %s: %w", u, err))
	}
	if res.ContentLength >= 0 && n != res.ContentLength {
		return n, fmt.Errorf("download %s: got %d of %s bytes", u, n, strconv.FormatInt(res.ContentLength, 10))
	}
	return n, nil
}
