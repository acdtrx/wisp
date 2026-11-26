package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeWisp stands in for a Wisp: GET /api/cli and the downloads for anyone,
// every other route for a known token and a CLI of its version, as the real
// one checks them (the token first, then the version).
type fakeWisp struct {
	*httptest.Server
	version   string
	platforms []string
	tokens    map[string]bool
	routes    map[string]http.HandlerFunc

	mu       sync.Mutex
	requests []*http.Request
}

func newFakeWisp(t *testing.T, version string) *fakeWisp {
	t.Helper()
	f := &fakeWisp{version: version, tokens: map[string]bool{}, routes: map[string]http.HandlerFunc{}}
	// The route a login checks its token on.
	f.routes["GET /api/jobs"] = func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"jobs": []any{}}) }
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func refuse(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]string{"error": code, "detail": detail})
}

func (f *fakeWisp) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.requests = append(f.requests, r.Clone(context.Background()))
	f.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	if r.URL.Path == "/api/cli" {
		writeJSON(w, 200, map[string]any{"version": f.version, "platforms": append([]string{}, f.platforms...)})
		return
	}
	if h, ok := f.routes[key]; ok && strings.HasPrefix(r.URL.Path, "/api/cli/") {
		h(w, r)
		return
	}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !f.tokens[token] {
		refuse(w, 401, "AUTH_INVALID", "Invalid API token")
		return
	}
	if sent := r.Header.Get("Wisp-Cli-Version"); sent != "" && sent != f.version {
		refuse(w, 409, "CLI_VERSION_MISMATCH", fmt.Sprintf("This wisp CLI is %s and this Wisp is %s: the two must be the same version", sent, f.version))
		return
	}
	if h, ok := f.routes[key]; ok {
		h(w, r)
		return
	}
	refuse(w, 404, "ROUTE_NOT_FOUND", "No route for "+key)
}

func (f *fakeWisp) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func (f *fakeWisp) lastRequest() *http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.requests[len(f.requests)-1]
}

// run is one command line against an Env of buffers and a home of its own.
type run struct {
	t      *testing.T
	home   string
	env    map[string]string
	stdin  string
	tty    bool
	typed  string
	exe    string
	stdout bytes.Buffer
	stderr bytes.Buffer
	code   int
}

func newRun(t *testing.T) *run {
	home := t.TempDir()
	return &run{t: t, home: home, env: map[string]string{"HOME": home}}
}

func (r *run) do(args ...string) *run {
	r.stdout.Reset()
	r.stderr.Reset()
	env := &Env{
		Version:         "1.0.0",
		Platform:        "linux-amd64",
		Stdin:           strings.NewReader(r.stdin),
		Stdout:          &r.stdout,
		Stderr:          &r.stderr,
		Getenv:          func(k string) string { return r.env[k] },
		StdinIsTerminal: r.tty,
		ReadHidden:      func() (string, error) { return r.typed, nil },
		Executable: func() (string, error) {
			if r.exe == "" {
				return filepath.Join(r.home, "bin", "wisp"), nil
			}
			return r.exe, nil
		},
	}
	r.code = Main(context.Background(), env, args)
	return r
}

func (r *run) wantCode(code int) *run {
	r.t.Helper()
	if r.code != code {
		r.t.Fatalf("exit %d, want %d\nstdout: %s\nstderr: %s", r.code, code, r.stdout.String(), r.stderr.String())
	}
	return r
}
