package cmd

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// otherVersionWisp is a Wisp of 2.0.0, with the 1.0.0 run's CLI signed in to
// it through the environment, serving newBinary for linux-amd64.
func otherVersionWisp(t *testing.T, newBinary []byte) (*fakeWisp, *run) {
	f := newFakeWisp(t, "2.0.0")
	f.tokens["wisp_agent_t"] = true
	f.platforms = []string{"linux-amd64"}
	containersRoute(f)
	f.routes["GET /api/cli/wisp-linux-amd64"] = func(w http.ResponseWriter, r *http.Request) {
		if newBinary == nil {
			refuse(w, 404, "CLI_NOT_AVAILABLE", "none")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(newBinary)
	}
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_agent_t"
	r.exe = filepath.Join(t.TempDir(), "wisp")
	if err := os.WriteFile(r.exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f, r
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestAnotherVersionSaysBothAndToUpdate(t *testing.T) {
	_, r := otherVersionWisp(t, nil)
	r.do("containers", "list").wantCode(1)
	line := r.stderr.String()
	if strings.Count(line, "\n") != 1 || !strings.Contains(line, "1.0.0") || !strings.Contains(line, "2.0.0") || !strings.Contains(line, `"wisp update"`) {
		t.Fatalf("stderr %q", line)
	}
}

func TestUpdateReplacesTheBinary(t *testing.T) {
	_, r := otherVersionWisp(t, []byte("new binary 2.0.0"))
	r.do("update").wantCode(0)
	if got := readFile(t, r.exe); got != "new binary 2.0.0" {
		t.Fatalf("binary now %q", got)
	}
	if runtime.GOOS != "windows" {
		if st, _ := os.Stat(r.exe); st.Mode().Perm() != 0o755 {
			t.Fatalf("mode %v", st.Mode().Perm())
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(r.exe))
	if len(entries) != 1 {
		t.Fatalf("the folder holds %d files", len(entries))
	}
	if !strings.Contains(r.stdout.String(), "1.0.0 → 2.0.0") {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func TestAFailedDownloadLeavesTheOldBinary(t *testing.T) {
	_, r := otherVersionWisp(t, nil)
	r.do("update").wantCode(1)
	if got := readFile(t, r.exe); got != "old binary" {
		t.Fatalf("binary now %q", got)
	}
	entries, _ := os.ReadDir(filepath.Dir(r.exe))
	if len(entries) != 1 {
		t.Fatalf("a download was left beside the binary: %d files", len(entries))
	}
	if !strings.Contains(r.stderr.String(), "stays as it was") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestAWispWithoutThisPlatformIsSaid(t *testing.T) {
	f, r := otherVersionWisp(t, []byte("x"))
	f.platforms = []string{"darwin-arm64"}
	r.do("update").wantCode(1)
	if !strings.Contains(r.stderr.String(), "no CLI for linux-amd64") || readFile(t, r.exe) != "old binary" {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestUpdateAtTheSameVersionDownloadsNothing(t *testing.T) {
	f, r := otherVersionWisp(t, []byte("x"))
	f.version = "1.0.0"
	r.do("update").wantCode(0)
	if readFile(t, r.exe) != "old binary" || f.requestCount() != 1 {
		t.Fatalf("binary %q, %d requests", readFile(t, r.exe), f.requestCount())
	}
}

func TestVersionPrintsBoth(t *testing.T) {
	_, r := otherVersionWisp(t, nil)
	r.do("version").wantCode(0)
	out := r.stdout.String()
	if !strings.Contains(out, "wisp CLI  1.0.0") || !strings.Contains(out, "Wisp      2.0.0") || !strings.Contains(r.stderr.String(), "wisp update") {
		t.Fatalf("stdout %q stderr %q", out, r.stderr.String())
	}
}
