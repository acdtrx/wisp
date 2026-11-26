package cmd

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/acdtrx/wisp/cli/internal/config"
)

func (r *run) configFile() string {
	return filepath.Join(r.home, ".config", "wisp", "config.json")
}

func (r *run) loadConfig() *config.File {
	r.t.Helper()
	f, err := config.Load(r.configFile())
	if err != nil {
		r.t.Fatal(err)
	}
	return f
}

// noToken fails when any output of the run holds a token.
func (r *run) noToken(tokens ...string) {
	r.t.Helper()
	for _, tok := range tokens {
		if strings.Contains(r.stdout.String()+r.stderr.String(), tok) {
			r.t.Fatalf("the output holds the token %s:\n%s%s", tok, r.stdout.String(), r.stderr.String())
		}
	}
}

func TestLoginFromStandardInputSavesTheDefaultProfile(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_agent_secret1"] = true
	r := newRun(t)
	r.stdin = "wisp_agent_secret1\n"
	r.do("login", f.URL+"/").wantCode(0)
	r.noToken("wisp_agent_secret1")
	if r.stderr.Len() != 0 {
		t.Fatalf("a prompt with stdin not a terminal: %q", r.stderr.String())
	}
	cfg := r.loadConfig()
	if cfg.Default != "default" || cfg.Profiles["default"].URL != f.URL || cfg.Profiles["default"].Token != "wisp_agent_secret1" {
		t.Fatalf("config %+v", cfg)
	}
	if !strings.Contains(r.stdout.String(), "agent token") {
		t.Fatalf("stdout %q", r.stdout.String())
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(r.configFile())
		dir, _ := os.Stat(filepath.Dir(r.configFile()))
		if st.Mode().Perm() != 0o600 || dir.Mode().Perm() != 0o700 {
			t.Fatalf("modes %v %v", st.Mode().Perm(), dir.Mode().Perm())
		}
	}
	// The address was checked with no token, then the token on a read route.
	if f.requests[0].URL.Path != "/api/cli" || f.requests[0].Header.Get("Authorization") != "" {
		t.Fatal("the token went out before the address was known to be a Wisp")
	}
}

func TestLoginAtATerminalPromptsWithTheTypingHidden(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_typed"] = true
	r := newRun(t)
	r.tty, r.typed = true, "wisp_read_typed"
	r.stdin = "never read\n"
	r.do("login", f.URL).wantCode(0)
	if !strings.HasPrefix(r.stderr.String(), "API token for "+f.URL) {
		t.Fatalf("prompt %q", r.stderr.String())
	}
	r.noToken("wisp_read_typed")
	if r.loadConfig().Profiles["default"].Token != "wisp_read_typed" {
		t.Fatal("not saved")
	}
}

func TestALoginThatFailsSavesNothingAndSaysWhy(t *testing.T) {
	f := newFakeWisp(t, "1.0.0")
	notWisp := newFakeWisp(t, "1.0.0")
	notWisp.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		w.Write([]byte("<html>not here</html>"))
	})
	cases := []struct {
		name, url, stdin, want string
	}{
		{"wrong token", f.URL, "wisp_agent_wrong\n", "refused the token: AUTH_INVALID"},
		{"not a Wisp", notWisp.URL, "wisp_agent_x\n", "not as a Wisp"},
		{"nobody there", "http://127.0.0.1:1", "wisp_agent_x\n", "reach http://127.0.0.1:1"},
		{"no token", f.URL, "\n", "no token given"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRun(t)
			r.stdin = tc.stdin
			r.do("login", tc.url).wantCode(1)
			if !strings.Contains(r.stderr.String(), tc.want) {
				t.Fatalf("stderr %q", r.stderr.String())
			}
			r.noToken("wisp_agent_wrong", "wisp_agent_x")
			if _, err := os.Stat(r.configFile()); err == nil {
				t.Fatal("a config was written")
			}
		})
	}
}

func TestLoginTakesOnlyAWispsAddress(t *testing.T) {
	for _, addr := range []string{"tini.local:8080", "ftp://x", "http://x/path", "http://u:p@x", "http://x?a=1", ""} {
		r := newRun(t)
		r.stdin = "wisp_agent_x\n"
		r.do("login", addr).wantCode(2)
	}
}

func TestProfilesDefaultAndLogout(t *testing.T) {
	home := newFakeWisp(t, "1.0.0")
	home.tokens["wisp_agent_home"] = true
	tini := newFakeWisp(t, "1.0.0")
	tini.tokens["wisp_read_tini"] = true
	r := newRun(t)
	r.stdin = "wisp_agent_home\n"
	r.do("login", home.URL).wantCode(0)
	r.stdin = "wisp_read_tini\n"
	r.do("--profile", "tini", "login", tini.URL).wantCode(0)
	if r.loadConfig().Default != "default" {
		t.Fatal("a second login took the default")
	}

	r.do("profiles").wantCode(0)
	r.noToken("wisp_agent_home", "wisp_read_tini")
	lines := strings.Split(strings.TrimSpace(r.stdout.String()), "\n")
	if len(lines) != 3 || !strings.Contains(lines[1], "default") || !strings.HasSuffix(lines[1], "*") ||
		!strings.Contains(lines[1], "agent") || !strings.Contains(lines[2], "tini") || strings.HasSuffix(lines[2], "*") ||
		!strings.Contains(lines[2], "read") || !strings.Contains(lines[2], tini.URL) {
		t.Fatalf("profiles:\n%s", r.stdout.String())
	}

	r.do("--profile", "tini", "default").wantCode(0)
	if r.loadConfig().Default != "tini" {
		t.Fatal("default not changed")
	}
	r.do("default").wantCode(2)
	r.do("--profile", "nope", "default").wantCode(1)

	r.do("--profile", "tini", "logout").wantCode(0)
	cfg := r.loadConfig()
	if _, ok := cfg.Profiles["tini"]; ok || cfg.Default != "" || len(cfg.Profiles) != 1 {
		t.Fatalf("after logout %+v", cfg)
	}
	r.do("containers", "list").wantCode(1)
	if !strings.Contains(r.stderr.String(), "no default profile") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
	r.do("--profile", "default", "logout").wantCode(0)
	r.do("profiles").wantCode(0)
	if !strings.Contains(r.stdout.String(), "No profiles") {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func TestLogoutWithoutProfileRemovesTheDefaultOne(t *testing.T) {
	r := newRun(t)
	cfg := &config.File{Version: 1, Default: "home", Profiles: map[string]config.Profile{
		"home": {URL: "http://a", Token: "wisp_read_a"}, "lab": {URL: "http://b", Token: "wisp_read_b"},
	}}
	if err := cfg.Save(r.configFile()); err != nil {
		t.Fatal(err)
	}
	r.do("logout").wantCode(0)
	if got := r.loadConfig(); len(got.Profiles) != 1 || got.Profiles["lab"].URL != "http://b" {
		t.Fatalf("got %+v", got)
	}
}

func TestProfileBeatsTheEnvironmentWhichBeatsTheDefault(t *testing.T) {
	byProfile := newFakeWisp(t, "1.0.0")
	byEnv := newFakeWisp(t, "1.0.0")
	byDefault := newFakeWisp(t, "1.0.0")
	for _, f := range []*fakeWisp{byProfile, byEnv, byDefault} {
		f.tokens["wisp_read_p"], f.tokens["wisp_read_e"], f.tokens["wisp_read_d"] = true, true, true
		containersRoute(f)
	}
	r := newRun(t)
	cfg := &config.File{Version: 1, Default: "home", Profiles: map[string]config.Profile{
		"home": {URL: byDefault.URL, Token: "wisp_read_d"},
		"lab":  {URL: byProfile.URL, Token: "wisp_read_p"},
	}}
	if err := cfg.Save(r.configFile()); err != nil {
		t.Fatal(err)
	}
	counts := func() [3]int { return [3]int{byProfile.requestCount(), byEnv.requestCount(), byDefault.requestCount()} }

	r.do("containers", "list").wantCode(0)
	if counts() != [3]int{0, 0, 1} {
		t.Fatalf("default: %v", counts())
	}
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = byEnv.URL, "wisp_read_e"
	r.do("containers", "list").wantCode(0)
	if counts() != [3]int{0, 1, 1} || byEnv.lastRequest().Header.Get("Authorization") != "Bearer wisp_read_e" {
		t.Fatalf("env: %v", counts())
	}
	r.do("--profile", "lab", "containers", "list").wantCode(0)
	if counts() != [3]int{1, 1, 1} || byProfile.lastRequest().Header.Get("Authorization") != "Bearer wisp_read_p" {
		t.Fatalf("profile: %v", counts())
	}
	r.do("--profile", "nope", "containers", "list").wantCode(1)
	if !strings.Contains(r.stderr.String(), `no profile "nope"`) {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestALoginAcrossVersionsSavesAndSaysToUpdate(t *testing.T) {
	f := newFakeWisp(t, "2.0.0")
	f.tokens["wisp_agent_ok"] = true
	r := newRun(t)
	r.stdin = "wisp_agent_ok\n"
	r.do("--profile", "lab", "login", f.URL).wantCode(1)
	if r.loadConfig().Profiles["lab"].Token != "wisp_agent_ok" {
		t.Fatal("the profile was not saved, though the token was taken")
	}
	if !strings.Contains(r.stderr.String(), "CLI_VERSION_MISMATCH") || !strings.Contains(r.stderr.String(), `"wisp --profile lab update"`) {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}
