// Package api is the CLI's client of a Wisp's REST API: one request per call,
// the token as a bearer header, the CLI's version in the header the Wisp checks
// (docs/specs/CLI.md, Version check), and a bound on every wait.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// VersionHeader carries the CLI's version on every request.
const VersionHeader = "Wisp-Cli-Version"

// The bounds (CODING-RULES §6): a short request has a fixed total, since a Wisp
// answers every one within 45 s; a stream, a download or an upload has a bound
// on the time without data, since it shows progress. A stream's Wisp writes a
// keepalive every 25 s; a Wisp drops an upload whose body sends nothing for
// 60 s.
const (
	connectTimeout   = 10 * time.Second
	headerTimeout    = 30 * time.Second
	requestTimeout   = 60 * time.Second
	streamIdle       = 60 * time.Second
	downloadIdle     = 30 * time.Second
	uploadIdle       = 60 * time.Second
	maxResponseBytes = 64 << 20
)

// Error is a refusal from the Wisp, as it sent it: the code and the message of
// its error body, and the body itself.
type Error struct {
	Status  int
	Code    string
	Message string
	Body    []byte
}

func (e *Error) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

// NotWispError is an answer that is not a Wisp's: a status without the error
// body, or a body that is not what the route sends (a proxy's page, another
// server).
type NotWispError struct {
	URL    string
	Status int
	Reason string
}

func (e *NotWispError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("%s answered HTTP %d, not as a Wisp: %s", e.URL, e.Status, e.Reason)
	}
	return fmt.Sprintf("%s did not answer as a Wisp: %s", e.URL, e.Reason)
}

// StalledError ends a stream, a download or an upload that stopped moving.
type StalledError struct {
	URL    string
	After  time.Duration
	Upload bool // what stopped is what the CLI sends, not what the Wisp does
}

func (e *StalledError) Error() string {
	if e.Upload {
		return fmt.Sprintf("the upload to %s made no progress for %s: gave up", e.URL, e.After)
	}
	return fmt.Sprintf("%s sent nothing for %s: gave up", e.URL, e.After)
}

// Client talks to one Wisp.
type Client struct {
	base    string
	token   string
	version string
	http    *http.Client
	// The bounds on a short request, and on a stream's, a download's and an
	// upload's time without data.
	requestTimeout, streamIdle, downloadIdle, uploadIdle time.Duration
}

// New is a client of the Wisp at base (scheme, host and port), sending token
// as its bearer when it is not empty. An https address is checked against the
// system's certificate authorities.
func New(base, token, version string) *Client {
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   connectTimeout,
		ResponseHeaderTimeout: headerTimeout,
		IdleConnTimeout:       90 * time.Second,
		ForceAttemptHTTP2:     true,
	}
	return &Client{
		base: strings.TrimRight(base, "/"), token: token, version: version,
		// Wisp's API never redirects: a redirect is answered as it came, and
		// refused as not a Wisp's, so neither the token nor the address check
		// ever follows one to another server, scheme or port.
		http:           &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		requestTimeout: requestTimeout, streamIdle: streamIdle, downloadIdle: downloadIdle, uploadIdle: uploadIdle,
	}
}

// WithUploadIdle sets the bound on an upload's time without progress.
func (c *Client) WithUploadIdle(d time.Duration) *Client {
	c.uploadIdle = d
	return c
}

// Base is the Wisp's address.
func (c *Client) Base() string { return c.base }

func (c *Client) url(path string, query url.Values) string {
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	return u
}

func (c *Client) do(ctx context.Context, path string, query url.Values, accept string) (*http.Response, error) {
	return c.send(ctx, http.MethodGet, path, query, accept, nil, "")
}

// send sends one request: body, when not nil, as contentType.
func (c *Client) send(ctx context.Context, method, path string, query url.Values, accept string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.url(path, query), body)
	if err != nil {
		return nil, fmt.Errorf("build the request for %s: %w", path, err)
	}
	req.Header.Set("Accept", accept)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set(VersionHeader, c.version)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reach %s: %w", c.base, unwrapURLError(err))
	}
	return res, nil
}

// unwrapURLError drops *url.Error's "Get <url>:" prefix, which the caller's
// context says better.
func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// Get sends one GET and answers the 2xx body. A refusal is an *Error.
func (c *Client) Get(ctx context.Context, path string, query url.Values) ([]byte, error) {
	return c.request(ctx, http.MethodGet, path, query, nil)
}

// Send sends one request with v as its JSON body (none when v is nil) and
// answers the 2xx body, empty for a 204. A refusal is an *Error.
func (c *Client) Send(ctx context.Context, method, path string, v any) ([]byte, error) {
	var body []byte
	if v != nil {
		var err error
		if body, err = json.Marshal(v); err != nil {
			return nil, fmt.Errorf("encode the request for %s: %w", path, err)
		}
	}
	return c.request(ctx, method, path, nil, body)
}

func (c *Client) request(ctx context.Context, method, path string, query url.Values, body []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	var reader io.Reader
	contentType := ""
	if body != nil {
		reader, contentType = bytes.NewReader(body), "application/json"
	}
	res, err := c.send(ctx, method, path, query, "application/json", reader, contentType)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("%s did not answer within %s", c.url(path, query), c.requestTimeout)
		}
		return nil, err
	}
	defer res.Body.Close()
	return readAnswer(c.url(path, query), res)
}

// readAnswer reads a short answer's body: the 2xx body, or the refusal.
func readAnswer(u string, res *http.Response) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read the answer of %s: %w", u, err)
	}
	if len(body) > maxResponseBytes {
		return nil, fmt.Errorf("the answer of %s is over %d bytes", u, maxResponseBytes)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, refusal(u, res, body)
	}
	return body, nil
}

// GetJSON is Get, decoded into v.
func (c *Client) GetJSON(ctx context.Context, path string, query url.Values, v any) ([]byte, error) {
	body, err := c.Get(ctx, path, query)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, v); err != nil {
		return nil, &NotWispError{URL: c.url(path, query), Reason: "its answer is not the JSON the route sends"}
	}
	return body, nil
}

// refusal turns a non-2xx answer into an *Error when it carries Wisp's error
// body, else a *NotWispError.
func refusal(u string, res *http.Response, body []byte) error {
	status := res.StatusCode
	if status >= 300 && status < 400 {
		return &NotWispError{URL: u, Status: status, Reason: fmt.Sprintf("it redirects to %q, and a Wisp's API never redirects", res.Header.Get("Location"))}
	}
	var parsed struct {
		Error  *string `json:"error"`
		Detail string  `json:"detail"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != nil && *parsed.Error != "" {
		return &Error{Status: status, Code: *parsed.Error, Message: parsed.Detail, Body: body}
	}
	return &NotWispError{URL: u, Status: status, Reason: "no error body"}
}

// idleWatch cancels ctx's request once nothing arrived for d: a stream or a
// download that stops moving ends rather than waits forever. The caller calls
// stop when done; touch on every chunk received.
type idleWatch struct {
	timer *time.Timer
	d     time.Duration
}

var errIdle = errors.New("idle")

func watchIdle(ctx context.Context, d time.Duration) (context.Context, *idleWatch, func()) {
	ctx, cancel := context.WithCancelCause(ctx)
	w := &idleWatch{d: d, timer: time.AfterFunc(d, func() { cancel(errIdle) })}
	return ctx, w, func() {
		w.timer.Stop()
		cancel(nil)
	}
}

func (w *idleWatch) touch() { w.timer.Reset(w.d) }

type idleReader struct {
	r io.Reader
	w *idleWatch
}

func (r idleReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.w.touch()
	}
	return n, err
}

// stalled says why a read under watchIdle failed: the bound, or err itself.
func stalled(ctx context.Context, u string, d time.Duration, err error) error {
	if errors.Is(context.Cause(ctx), errIdle) {
		return &StalledError{URL: u, After: d}
	}
	return err
}
