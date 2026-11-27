package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/acdtrx/wisp/cli/internal/term"
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

func TestARedirectIsNeverFollowed(t *testing.T) {
	var reached atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		fmt.Fprint(w, `{"version":"1","platforms":[]}`)
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirector.Close()
	c := New(redirector.URL, "wisp_agent_secret", "v")
	var notWisp *NotWispError
	if _, err := c.Get(context.Background(), "/api/cli", nil); !errors.As(err, &notWisp) || notWisp.Status != 302 || !strings.Contains(err.Error(), "redirects") {
		t.Fatalf("get: %v", err)
	}
	if err := c.Stream(context.Background(), "/s", nil, func([]byte) (bool, error) { return true, nil }); !errors.As(err, &notWisp) {
		t.Fatalf("stream: %v", err)
	}
	if _, err := c.Download(context.Background(), "/bin", &bytes.Buffer{}); !errors.As(err, &notWisp) {
		t.Fatalf("download: %v", err)
	}
	if reached.Load() != 0 {
		t.Fatalf("the redirect was followed %d times", reached.Load())
	}
}

func TestUploadStreamsOneFilePart(t *testing.T) {
	var name, content string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		file, header, err := r.FormFile("file")
		if err != nil {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"UPLOAD_NO_FILE","detail":"no file"}`)
			return
		}
		b, _ := io.ReadAll(file)
		name, content = header.Filename, string(b)
		w.WriteHeader(202)
		fmt.Fprint(w, `{"jobId":"j"}`)
	}))
	defer srv.Close()
	body, err := New(srv.URL, "t", "v").Upload(context.Background(), "/up", "site.zip", func(_ context.Context, w io.Writer) error {
		for i := 0; i < 100; i++ {
			if _, err := w.Write(bytes.Repeat([]byte{byte('a' + i%26)}, 10_000)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil || string(body) != `{"jobId":"j"}` || name != "site.zip" || len(content) != 1_000_000 || content[999_999] != 'v' {
		t.Fatalf("body %q err %v name %q len %d", body, err, name, len(content))
	}
}

func TestAnUploadThatStopsMovingEndsAndASourceErrorIsItsOwn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := New(srv.URL, "t", "v")
	c.uploadIdle = 100 * time.Millisecond
	block := make(chan struct{})
	defer close(block)
	_, err := c.Upload(context.Background(), "/up", "f", func(_ context.Context, w io.Writer) error {
		w.Write([]byte("start"))
		select {
		case <-block:
		case <-time.After(500 * time.Millisecond): // a source slower than the bound
		}
		return nil
	})
	var stalledErr *StalledError
	if !errors.As(err, &stalledErr) {
		t.Fatalf("got %v", err)
	}
	gone := errors.New("read site/index.html: gone")
	if _, err := c.Upload(context.Background(), "/up", "f", func(context.Context, io.Writer) error { return gone }); !errors.Is(err, gone) {
		t.Fatalf("got %v", err)
	}
}

func TestAnUploadRefusedIsTheRefusal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(409)
		fmt.Fprint(w, `{"error":"CONTAINER_BUSY","detail":"busy"}`)
	}))
	defer srv.Close()
	_, err := New(srv.URL, "t", "v").Upload(context.Background(), "/up", "f", func(_ context.Context, w io.Writer) error {
		_, err := w.Write(bytes.Repeat([]byte("x"), 1<<20))
		return err
	})
	var refused *Error
	if !errors.As(err, &refused) || refused.Code != "CONTAINER_BUSY" {
		t.Fatalf("got %v", err)
	}
}

func TestAnUploadWhoseSourceNeverSendsEndsAtTheBound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(204)
	}))
	defer srv.Close()
	pr, pw, err := os.Pipe() // a source nothing is ever written to
	if err != nil {
		t.Fatal(err)
	}
	defer pw.Close()
	defer pr.Close()
	c := New(srv.URL, "t", "v").WithUploadIdle(100 * time.Millisecond)
	start := time.Now()
	_, err = c.Upload(context.Background(), "/up", "f", func(ctx context.Context, w io.Writer) error {
		// The source's own bound is longer than the upload's: the upload's ends it.
		_, err := io.Copy(w, term.SourceWithin(ctx, "the pipe", func() (io.ReadCloser, error) { return pr, nil }, time.Hour))
		return err
	})
	var stalledErr *StalledError
	if !errors.As(err, &stalledErr) || time.Since(start) > 5*time.Second {
		t.Fatalf("got %v after %s", err, time.Since(start))
	}
}
