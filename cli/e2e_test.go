package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

const e2eVersion = "9.9.9-e2e"

// buildWisp builds the CLI as scripts/stage-release.sh does, its version
// stamped, into dir.
func buildWisp(t *testing.T, dir, version string) string {
	t.Helper()
	bin := filepath.Join(dir, "wisp")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", "-X main.version="+version, "-o", bin, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

// e2eWisp is a stand-in Wisp for the built binary: the version route, the
// containers list for one token, and the version check.
type e2eWisp struct {
	*httptest.Server
	version  string
	token    string
	requests atomic.Int32
	binary   []byte
}

func newE2EWisp(t *testing.T, version, token string) *e2eWisp {
	w := &e2eWisp{version: version, token: token}
	w.Server = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		w.requests.Add(1)
		reply := func(status int, body any) {
			rw.Header().Set("Content-Type", "application/json")
			rw.WriteHeader(status)
			json.NewEncoder(rw).Encode(body)
		}
		platform := runtime.GOOS + "-" + runtime.GOARCH
		switch r.URL.Path {
		case "/api/cli":
			reply(200, map[string]any{"version": w.version, "platforms": []string{platform}})
			return
		case "/api/cli/wisp-" + platform:
			if w.binary == nil {
				reply(404, map[string]string{"error": "CLI_NOT_AVAILABLE", "detail": "none"})
				return
			}
			rw.Header().Set("Content-Type", "application/octet-stream")
			rw.Write(w.binary)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+w.token {
			reply(401, map[string]string{"error": "AUTH_INVALID", "detail": "Invalid API token"})
			return
		}
		if v := r.Header.Get("Wisp-Cli-Version"); v != w.version {
			reply(409, map[string]string{"error": "CLI_VERSION_MISMATCH", "detail": "This wisp CLI is " + v + " and this Wisp is " + w.version})
			return
		}
		switch r.URL.Path {
		case "/api/containers":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`[{"name":"web","image":"nginx:1.27","state":"running","updateAvailable":false,"scheduledRestart":null,"pendingRestart":null}]`))
		case "/api/jobs":
			reply(200, map[string]any{"jobs": []any{}})
		default:
			reply(404, map[string]string{"error": "ROUTE_NOT_FOUND", "detail": r.URL.Path})
		}
	}))
	t.Cleanup(w.Close)
	return w
}

type result struct {
	stdout, stderr string
	code           int
}

// runWisp runs the binary with only the environment given (and a home of
// the test's own), stdin as given.
func runWisp(t *testing.T, bin string, env []string, stdin string, args ...string) result {
	t.Helper()
	c := exec.Command(bin, args...)
	c.Env = env
	c.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	err := c.Run()
	code := 0
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
	} else if err != nil {
		t.Fatalf("run %v: %v", args, err)
	}
	return result{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

func homeEnv(home string) []string {
	return []string{"HOME=" + home, "APPDATA=" + home, "PATH=" + os.Getenv("PATH")}
}

func TestBuiltBinaryAgainstAStandInWisp(t *testing.T) {
	dir := t.TempDir()
	bin := buildWisp(t, dir, e2eVersion)
	wisp := newE2EWisp(t, e2eVersion, "wisp_read_e2e")
	home := t.TempDir()
	withEnv := append(homeEnv(home), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_read_e2e")

	got := runWisp(t, bin, withEnv, "", "containers", "list")
	if got.code != 0 || !strings.HasPrefix(got.stdout, "NAME") || !strings.Contains(got.stdout, "web") {
		t.Fatalf("containers list: %+v", got)
	}
	got = runWisp(t, bin, withEnv, "", "containers", "list", "--json")
	if got.code != 0 || !strings.HasPrefix(got.stdout, `[{"name":"web"`) {
		t.Fatalf("containers list --json: %+v", got)
	}
	got = runWisp(t, bin, withEnv, "", "version")
	if got.code != 0 || !strings.Contains(got.stdout, "wisp CLI  "+e2eVersion) || !strings.Contains(got.stdout, "Wisp      "+e2eVersion) {
		t.Fatalf("version: %+v", got)
	}

	got = runWisp(t, bin, homeEnv(home), "", "containers", "list")
	if got.code != 1 || !strings.Contains(got.stderr, "wisp login") {
		t.Fatalf("not signed in: %+v", got)
	}
	before := wisp.requests.Load()
	got = runWisp(t, bin, withEnv, "", "containers", "frob")
	if got.code != 2 || wisp.requests.Load() != before {
		t.Fatalf("unknown command: %+v, %d requests", got, wisp.requests.Load()-before)
	}
}

func TestTheBuiltBinaryUpdatesItself(t *testing.T) {
	newBin := buildWisp(t, t.TempDir(), e2eVersion)
	newBytes, err := os.ReadFile(newBin)
	if err != nil {
		t.Fatal(err)
	}
	oldBin := buildWisp(t, t.TempDir(), "9.9.8-old")
	wisp := newE2EWisp(t, e2eVersion, "wisp_read_e2e")
	wisp.binary = newBytes
	env := append(homeEnv(t.TempDir()), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_read_e2e")

	got := runWisp(t, oldBin, env, "", "containers", "list")
	if got.code != 1 || !strings.Contains(got.stderr, "9.9.8-old") || !strings.Contains(got.stderr, e2eVersion) || !strings.Contains(got.stderr, "wisp update") {
		t.Fatalf("across versions: %+v", got)
	}
	// A download that fails leaves the old binary, which still runs.
	wisp.binary = nil
	got = runWisp(t, oldBin, env, "", "update")
	if got.code != 1 || !strings.Contains(got.stderr, "stays as it was") {
		t.Fatalf("failed update: %+v", got)
	}
	got = runWisp(t, oldBin, env, "", "version")
	if !strings.Contains(got.stdout, "wisp CLI  9.9.8-old") {
		t.Fatalf("after the failed update: %+v", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(oldBin))
	if len(entries) != 1 {
		t.Fatalf("the failed update left %d files beside the binary", len(entries))
	}

	// A 200 that is not the CLI (a portal's page) leaves it too.
	wisp.binary = []byte("<html>Sign in to the Wi-Fi</html>")
	got = runWisp(t, oldBin, env, "", "update")
	if got.code != 1 || !strings.Contains(got.stderr, "stays as it was") {
		t.Fatalf("update from a portal: %+v", got)
	}
	if got = runWisp(t, oldBin, env, "", "version"); !strings.Contains(got.stdout, "wisp CLI  9.9.8-old") {
		t.Fatalf("after the portal: %+v", got)
	}

	wisp.binary = newBytes
	got = runWisp(t, oldBin, env, "", "update")
	if got.code != 0 {
		t.Fatalf("update: %+v", got)
	}
	got = runWisp(t, oldBin, env, "", "containers", "list")
	if got.code != 0 || !strings.Contains(got.stdout, "web") {
		t.Fatalf("after the update: %+v", got)
	}
	got = runWisp(t, oldBin, env, "", "version")
	if !strings.Contains(got.stdout, "wisp CLI  "+e2eVersion) {
		t.Fatalf("version after the update: %+v", got)
	}
}
