// Package api is the CLI's client of a Wisp's REST API: one request per call,
// the token as a bearer header, the CLI's version in the header the Wisp checks
// (docs/specs/CLI.md, Version check), and a bound on every wait.
package api

import (
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
// answers every one within 45 s; a stream or a download has a bound on the time
// without data, since it shows progress. A stream's Wisp writes a keepalive
// every 25 s.
const (
	connectTimeout   = 10 * time.Second
	headerTimeout    = 30 * time.Second
	requestTimeout   = 60 * time.Second
	streamIdle       = 60 * time.Second
	downloadIdle     = 30 * time.Second
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

// StalledError ends a stream or a download that stopped moving.
type StalledError struct {
	URL   string
	After time.Duration
}

func (e *StalledError) Error() string {
	return fmt.Sprintf("%s sent nothing for %s: gave up", e.URL, e.After)
}

// Client talks to one Wisp.
type Client struct {
	base    string
	token   string
	version string
	http    *http.Client
	// The bounds on a short request, and on a stream's and a download's time
	// without data.
	requestTimeout, streamIdle, downloadIdle time.Duration
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
		base: strings.TrimRight(base, "/"), token: token, version: version, http: &http.Client{Transport: transport},
		requestTimeout: requestTimeout, streamIdle: streamIdle, downloadIdle: downloadIdle,
	}
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.url(path, query), nil)
	if err != nil {
		return nil, fmt.Errorf("build the request for %s: %w", path, err)
	}
	req.Header.Set("Accept", accept)
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
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	res, err := c.do(ctx, path, query, "application/json")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("%s did not answer within %s", c.url(path, query), c.requestTimeout)
		}
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read the answer of %s: %w", c.url(path, query), err)
	}
	if len(body) > maxResponseBytes {
		return nil, fmt.Errorf("the answer of %s is over %d bytes", c.url(path, query), maxResponseBytes)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, refusal(c.url(path, query), res.StatusCode, body)
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
func refusal(u string, status int, body []byte) error {
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
