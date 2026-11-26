package cmd

import (
	"net/http"
	"strings"
	"testing"
)

func containersRoute(f *fakeWisp) {
	f.routes["GET /api/containers"] = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"name":"web","uuid":"u1","type":"container","image":"docker.io/library/nginx:1.27","state":"running","iconId":null,"autoBackup":false,"updateAvailable":true,"scheduledRestart":null,"pendingRestart":null}]`))
	}
}

func TestWithTheEnvironmentAListIsATableOrTheAPIsJSON(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_env"] = true
	containersRoute(f)
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_read_env"

	r.do("containers", "list").wantCode(0)
	lines := strings.Split(strings.TrimSpace(r.stdout.String()), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "NAME") || !strings.Contains(lines[1], "web") ||
		!strings.Contains(lines[1], "running") || !strings.Contains(lines[1], "image update available") {
		t.Fatalf("table:\n%s", r.stdout.String())
	}
	if got := f.lastRequest().Header.Get("Wisp-Cli-Version"); got != "1.0.0" {
		t.Fatalf("version header %q", got)
	}

	r.do("containers", "list", "--json").wantCode(0)
	if !strings.HasPrefix(r.stdout.String(), `[{"name":"web","uuid":"u1"`) {
		t.Fatalf("json: %s", r.stdout.String())
	}
}

func TestWithNoWispItSaysToLogIn(t *testing.T) {
	r := newRun(t).do("containers", "list").wantCode(1)
	if !strings.Contains(r.stderr.String(), "wisp login") {
		t.Fatalf("stderr: %s", r.stderr.String())
	}
}

func TestAWrongCommandLineExits2AndSendsNothing(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_env"] = true
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_read_env"
	for _, args := range [][]string{
		{"frobnicate"},
		{},
		{"containers"},
		{"containers", "frob"},
		{"containers", "list", "--nope"},
		{"containers", "list", "extra"},
		{"containers", "show"},
		{"containers", "logs", "web", "--lines", "many"},
		{"containers", "logs", "web", "--lines"},
		{"--profile", "bad name", "containers", "list"},
		{"--frob", "containers", "list"},
		{"containers", "list", "--json=yes"},
	} {
		r.do(args...).wantCode(2)
		if !strings.HasPrefix(r.stderr.String(), "wisp: ") {
			t.Errorf("%v: stderr %q", args, r.stderr.String())
		}
	}
	if n := f.requestCount(); n != 0 {
		t.Fatalf("%d requests sent", n)
	}
}

func TestFlagsAndArgumentsInEitherOrder(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_env"] = true
	f.routes["GET /api/containers/web"] = func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"name":"web"}`))
	}
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_read_env"
	for _, args := range [][]string{{"containers", "show", "--json", "web"}, {"containers", "show", "web", "--json"}} {
		r.do(args...).wantCode(0)
		if strings.TrimSpace(r.stdout.String()) != `{"name":"web"}` {
			t.Fatalf("%v: %s", args, r.stdout.String())
		}
	}
}

func TestARefusalIsOneLineAndExit1(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_env"] = true
	f.routes["GET /api/containers/gone"] = func(w http.ResponseWriter, r *http.Request) {
		refuse(w, 404, "CONTAINER_NOT_FOUND", `Container "gone" not found`)
	}
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_read_env"
	r.do("containers", "show", "gone").wantCode(1)
	if r.stderr.String() != "CONTAINER_NOT_FOUND: Container \"gone\" not found\n" || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
	r.do("containers", "show", "gone", "--json").wantCode(1)
	// The error body as the Wisp sent it (the stand-in sorts its keys).
	if strings.TrimSpace(r.stderr.String()) != `{"detail":"Container \"gone\" not found","error":"CONTAINER_NOT_FOUND"}` {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestHalfTheEnvironmentIsAnError(t *testing.T) {
	r := newRun(t)
	r.env["WISP_URL"] = "http://wisp.local:8080"
	r.do("containers", "list").wantCode(1)
	if !strings.Contains(r.stderr.String(), "WISP_URL is set without WISP_TOKEN") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestHelpListsEveryCommandAndEachFlag(t *testing.T) {
	r := newRun(t).do("help").wantCode(0)
	overview := r.stdout.String()
	for _, c := range commandTable() {
		if !strings.Contains(overview, "  "+c.Path) {
			t.Errorf("the overview lacks %q", c.Path)
		}
		r.do(append([]string{"help"}, strings.Fields(c.Path)...)...).wantCode(0)
		full := r.stdout.String()
		if !strings.Contains(full, "Usage: wisp [--profile <name>] "+c.Path) || !strings.Contains(full, "Example:\n  wisp ") {
			t.Errorf("help %s:\n%s", c.Path, full)
		}
		for _, f := range c.Flags {
			if !strings.Contains(full, "--"+f.Name) {
				t.Errorf("help %s lacks --%s", c.Path, f.Name)
			}
		}
		r.do(append(strings.Fields(c.Path), "--help")...).wantCode(0)
		if r.stdout.String() != full {
			t.Errorf("%s --help differs from wisp help %s", c.Path, c.Path)
		}
	}
	for _, word := range []string{"script", "agent", "machine", "program"} {
		if strings.Contains(strings.ToLower(jsonFlag.Usage), word) {
			t.Errorf("--json's help says who it is for: %q", jsonFlag.Usage)
		}
	}
	if strings.Contains(strings.ToLower(overview), "for scripts") || strings.Contains(strings.ToLower(overview), "for agents") {
		t.Error("the overview says who --json is for")
	}
	r.do("--help").wantCode(0)
	if r.stdout.String() != overview {
		t.Error("wisp --help differs from wisp help")
	}
}
