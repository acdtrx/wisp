//go:build unix

package cmd

import (
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A FIFO no one writes to blocks its open itself: the push still ends at its
// bound, the open left behind.
func TestAPushOfAFIFOThatNoOneWritesEndsAtTheBound(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["POST /api/containers/images/upload"] = func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body) // ends when the CLI gives up
	}
	fifo := filepath.Join(t.TempDir(), "image.tar")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	r.uploadIdle = 200 * time.Millisecond
	start := time.Now()
	r.do("images", "push", fifo).wantCode(1)
	if !strings.Contains(r.stderr.String(), "no progress for 200ms") || time.Since(start) > 5*time.Second {
		t.Fatalf("stderr %q after %s", r.stderr.String(), time.Since(start))
	}
}
