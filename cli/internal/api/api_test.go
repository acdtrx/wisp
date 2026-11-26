package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGetSendsTheVersionAndTheToken(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		fmt.Fprint(w, `[]`)
	}))
	defer srv.Close()
	if _, err := New(srv.URL, "wisp_read_x", "1.2.3").Get(context.Background(), "/api/containers", nil); err != nil {
		t.Fatal(err)
	}
	if got.Get(VersionHeader) != "1.2.3" || got.Get("Authorization") != "Bearer wisp_read_x" {
		t.Fatalf("headers %v", got)
	}

	if _, err := New(srv.URL, "", "1.2.3").Get(context.Background(), "/api/cli", nil); err != nil {
		t.Fatal(err)
	}
	if got.Get("Authorization") != "" {
		t.Fatal("a token sent with none given")
	}
}

func TestARefusalIsItsCodeAndMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/wisp":
			w.WriteHeader(409)
			fmt.Fprint(w, `{"error":"CONTAINER_BUSY","detail":"Stop web is running"}`)
		default:
			w.WriteHeader(502)
			fmt.Fprint(w, `<html>Bad gateway</html>`)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "t", "v")
	_, err := c.Get(context.Background(), "/wisp", nil)
	var refused *Error
	if !errors.As(err, &refused) || refused.Status != 409 || err.Error() != "CONTAINER_BUSY: Stop web is running" ||
		!bytes.Contains(refused.Body, []byte(`"CONTAINER_BUSY"`)) {
		t.Fatalf("got %v", err)
	}
	_, err = c.Get(context.Background(), "/proxy", nil)
	var notWisp *NotWispError
	if !errors.As(err, &notWisp) || notWisp.Status != 502 {
		t.Fatalf("got %v", err)
	}
}

func TestARequestThatGetsNoAnswerEnds(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(block)
	c := New(srv.URL, "t", "v")
	c.requestTimeout = 50 * time.Millisecond
	_, err := c.Get(context.Background(), "/api/jobs", nil)
	if err == nil || !strings.Contains(err.Error(), "did not answer within") {
		t.Fatalf("got %v", err)
	}
}

func sse(w http.ResponseWriter, frames ...string) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, f := range frames {
		fmt.Fprint(w, f)
	}
	w.(http.Flusher).Flush()
}

func TestStreamReadsEventsAndSkipsKeepalives(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sse(w, ": keepalive\n\n", "data: {\"n\":1}\n\n", ": keepalive\n\n", "data: {\"n\":2}\n\n", "data: {\"n\":3}\n\n")
	}))
	defer srv.Close()
	var got []string
	err := New(srv.URL, "t", "v").Stream(context.Background(), "/s", nil, func(data []byte) (bool, error) {
		got = append(got, string(data))
		return len(got) == 2, nil
	})
	if err != nil || strings.Join(got, "|") != `{"n":1}|{"n":2}` {
		t.Fatalf("got %v %v", got, err)
	}
}

func TestStreamErrorFrameAndEnd(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/err" {
			sse(w, "data: {\"error\":\"CONTAINER_NOT_FOUND\",\"detail\":\"gone\"}\n\n")
			return
		}
		sse(w, "data: {\"step\":\"error\",\"error\":\"X\",\"detail\":\"y\"}\n\n")
	}))
	defer srv.Close()
	c := New(srv.URL, "t", "v")
	err := c.Stream(context.Background(), "/err", nil, func([]byte) (bool, error) { return false, nil })
	var refused *Error
	if !errors.As(err, &refused) || refused.Code != "CONTAINER_NOT_FOUND" {
		t.Fatalf("got %v", err)
	}
	// A job's error event is the job's own end, given to the caller.
	var events int
	err = c.Stream(context.Background(), "/job", nil, func([]byte) (bool, error) { events++; return false, nil })
	if events != 1 || !errors.Is(err, ErrStreamEnded) {
		t.Fatalf("got %d events, %v", events, err)
	}
}

func TestAStreamThatStopsMovingEnds(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sse(w, "data: {}\n\n")
		select {
		case <-block:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(block)
	c := New(srv.URL, "t", "v")
	c.streamIdle = 100 * time.Millisecond
	err := c.Stream(context.Background(), "/s", nil, func([]byte) (bool, error) { return false, nil })
	var stalledErr *StalledError
	if !errors.As(err, &stalledErr) {
		t.Fatalf("got %v", err)
	}
}

func TestADownloadCutShortIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		fmt.Fprint(w, "only some")
		w.(http.Flusher).Flush()
		// The handler returns short: the server closes the connection.
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}))
	defer srv.Close()
	var dst bytes.Buffer
	if _, err := New(srv.URL, "", "v").Download(context.Background(), "/bin", &dst); err == nil {
		t.Fatal("a short download taken whole")
	}
}
