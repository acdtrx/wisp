package cmd

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// agentWisp is a stand-in Wisp for an agent token, with the job route j-1
// answering frames; routes the test adds record their bodies in bodies.
type agentWisp struct {
	*fakeWisp
	bodies map[string][]map[string]any
}

func newAgentWisp(t *testing.T) (*agentWisp, *run) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_agent_t"] = true
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_agent_t"
	return &agentWisp{fakeWisp: f, bodies: map[string][]map[string]any{}}, r
}

// startsJob makes key a route that records its JSON body and answers the ack
// of job j-1.
func (a *agentWisp) startsJob(key, title string) {
	a.routes[key] = func(w http.ResponseWriter, r *http.Request) {
		a.record(key, r)
		writeJSON(w, 202, map[string]any{"jobId": "j-1", "kind": "k", "title": title, "subject": nil})
	}
}

// answers makes key a route that records its JSON body and answers status.
func (a *agentWisp) answers(key string, status int) {
	a.routes[key] = func(w http.ResponseWriter, r *http.Request) {
		a.record(key, r)
		w.WriteHeader(status)
	}
}

func (a *agentWisp) record(key string, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var body map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &body); err != nil {
			body = map[string]any{"<not json>": string(raw)}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.bodies[key] = append(a.bodies[key], body)
}

func (a *agentWisp) body(t *testing.T, key string) map[string]any {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.bodies[key]) == 0 {
		t.Fatalf("no request %s", key)
	}
	return a.bodies[key][len(a.bodies[key])-1]
}

func asJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

const deployedWeb = `{"name":"web","image":"docker.io/library/nginx:1.27","state":"running","command":["nginx","-g","daemon off;"],
"cpuLimit":0.5,"memoryLimitMiB":256,"restartPolicy":"always","autostart":false,"autoBackup":false,"localDns":true,
"env":{"MODE":{"value":"prod"},"API_KEY":{"value":null,"secret":true,"isSet":true}},"mounts":[]}`

func TestCreateSendsOneDeployAndPrintsTheContainerItRuns(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/deploy", "Deploy web")
	jobRoute(a.fakeWisp, `{"step":"pulling","detail":"docker.io/library/nginx:1.27"}`, `{"step":"starting"}`,
		`{"step":"done","result":`+strings.ReplaceAll(deployedWeb, "\n", "")+`}`)

	r.do("containers", "create", "web", "--image", "nginx:1.27", "--env", "MODE=prod", "--secret-env", "API_KEY=s3cret",
		"--cpu", "0.5", "--memory=256", "--restart-policy", "always", "--local-dns", "on", "--", "nginx", "-g", "daemon off;").wantCode(0)
	want := `{"command":["nginx","-g","daemon off;"],"cpuLimit":0.5,"env":{"MODE":"prod"},"image":"nginx:1.27","localDns":true,` +
		`"memoryLimitMiB":256,"name":"web","restartPolicy":"always","secretEnv":{"API_KEY":"s3cret"}}`
	if got := asJSON(a.body(t, "POST /api/containers/deploy")); got != want {
		t.Fatalf("body %s\nwant %s", got, want)
	}
	if r.stderr.String() != "Deploy web: job j-1\npulling docker.io/library/nginx:1.27\nstarting\n" {
		t.Fatalf("stderr %q", r.stderr.String())
	}
	out := r.stdout.String()
	for _, want := range []string{"running", "nginx -g 'daemon off;'", "0.5 cores", "256 MiB", "always", "MODE=prod", "API_KEY=(secret, set)"} {
		if !strings.Contains(out, want) {
			t.Errorf("the container lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out+r.stderr.String(), "s3cret") {
		t.Error("the secret value was printed")
	}

	r.do("containers", "create", "web", "--image", "nginx:1.27", "--no-start", "--json").wantCode(0)
	if got := asJSON(a.body(t, "POST /api/containers/deploy")); got != `{"image":"nginx:1.27","name":"web","start":false}` {
		t.Fatalf("--no-start body %s", got)
	}
	if !strings.HasPrefix(r.stdout.String(), `{"name":"web"`) {
		t.Fatalf("--json prints the job's result: %q", r.stdout.String())
	}
}

func TestCreateWithLimitsRemovedAndSwitchesOff(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/deploy", "Deploy web")
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"web"}}`)
	r.do("containers", "create", "--autostart", "off", "web", "--auto-backup", "on", "--cpu", "none", "--memory", "none", "--image", "x", "--no-command").wantCode(0)
	if got := asJSON(a.body(t, "POST /api/containers/deploy")); got != `{"autoBackup":true,"autostart":false,"command":null,"cpuLimit":null,"image":"x","memoryLimitMiB":null,"name":"web"}` {
		t.Fatalf("body %s", got)
	}
}

func TestAWrongCreateOrLifecycleLineExits2AndSendsNothing(t *testing.T) {
	a, r := newAgentWisp(t)
	for _, args := range [][]string{
		{"containers", "create", "web"},
		{"containers", "create", "--image", "x"},
		{"containers", "create", "web", "--image", "x", "--env", "NOVALUE"},
		{"containers", "create", "web", "--image", "x", "--env", "=v"},
		{"containers", "create", "web", "--image", "x", "--env", "A=1", "--secret-env", "A=2"},
		{"containers", "create", "web", "--image", "x", "--cpu", "lots"},
		{"containers", "create", "web", "--image", "x", "--cpu", "NaN"},
		{"containers", "create", "web", "--image", "x", "--memory", "1.5"},
		{"containers", "create", "web", "--image", "x", "--autostart", "yes"},
		{"containers", "create", "web", "--image", "x", "--image", "y"},
		{"containers", "create", "web", "--image", "x", "--"},
		{"containers", "create", "web", "--image", "x", "--unset-env", "A"},
		{"containers", "create", "web", "--image", "x", "--no-command", "--", "sh"},
		{"containers", "start"},
		{"containers", "stop", "a", "b"},
		{"containers", "restart", "web", "--image", "x"},
	} {
		r.do(args...).wantCode(2)
	}
	if n := a.requestCount(); n != 0 {
		t.Fatalf("%d requests sent", n)
	}
}

func TestStartStopRestartWaitForTheirJob(t *testing.T) {
	a, r := newAgentWisp(t)
	for _, route := range []string{"start", "stop", "restart"} {
		a.startsJob("POST /api/containers/web/"+route, route+" web")
	}
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"web"}}`)
	for route, want := range map[string]string{"start": "Started web.\n", "stop": "Stopped web.\n", "restart": "Restarted web.\n"} {
		r.do("containers", route, "web").wantCode(0)
		if r.stdout.String() != want || !strings.HasPrefix(r.stderr.String(), route+" web: job j-1\n") {
			t.Fatalf("%s: stdout %q stderr %q", route, r.stdout.String(), r.stderr.String())
		}
	}
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"web","restartCancelled":true}}`)
	r.do("containers", "stop", "web").wantCode(0)
	if !strings.Contains(r.stdout.String(), "scheduled restart is cancelled") {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func TestALifecycleRefusalIsTheAPIsAndExit1(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["POST /api/containers/web/start"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 409, "CONTAINER_ALREADY_RUNNING", `Container "web" is already running`)
	}
	a.routes["POST /api/containers/web/stop"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 409, "CONTAINER_BUSY", `Container "web" is busy: start is running`)
	}
	r.do("containers", "start", "web").wantCode(1)
	if r.stderr.String() != "CONTAINER_ALREADY_RUNNING: Container \"web\" is already running\n" || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
	r.do("containers", "stop", "web", "--json").wantCode(1)
	if strings.TrimSpace(r.stderr.String()) != `{"detail":"Container \"web\" is busy: start is running","error":"CONTAINER_BUSY"}` {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestAJobThatFailsEndsTheCommandWithItsError(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/deploy", "Deploy web")
	jobRoute(a.fakeWisp, `{"step":"pulling"}`, `{"step":"error","error":"CONTAINER_START_FAILED","detail":"Container \"web\" was created but failed to start"}`)
	r.do("containers", "create", "web", "--image", "x").wantCode(1)
	if !strings.HasSuffix(r.stderr.String(), "CONTAINER_START_FAILED: Container \"web\" was created but failed to start\n") || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
}

func TestNoWaitPrintsTheJobAndJobsWaitEndsAsTheCommandWould(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/web/restart", "Restart web")
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"web"}}`)
	r.do("containers", "restart", "web", "--no-wait").wantCode(0)
	if r.stdout.String() != "j-1\n" || r.stderr.Len() != 0 {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}
	if a.lastRequest().URL.Path != "/api/containers/web/restart" {
		t.Fatal("--no-wait followed the job")
	}
	r.do("containers", "restart", "web", "--no-wait", "--json").wantCode(0)
	if !strings.HasPrefix(r.stdout.String(), `{"jobId":"j-1"`) {
		t.Fatalf("--no-wait --json: %q", r.stdout.String())
	}
	r.do("jobs", "wait", strings.TrimSpace("j-1")).wantCode(0)

	jobRoute(a.fakeWisp, `{"step":"error","error":"CONTAINER_BUSY","detail":"busy"}`)
	r.do("containers", "restart", "web").wantCode(1)
	r.do("jobs", "wait", "j-1").wantCode(1)
}

func TestAnInterruptEndsTheCommandsWaitNotItsJob(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/deploy", "Deploy web")
	a.routes["GET /api/jobs/j-1/progress"] = func(w http.ResponseWriter, req *http.Request) {
		sseWrite(w, `{"step":"pulling"}`)
		<-req.Context().Done()
	}
	r.interruptOnceItPrints("pulling")
	r.do("containers", "create", "web", "--image", "x").wantCode(1)
	if !strings.Contains(r.stderr.String(), "stopped waiting: the job j-1 goes on") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestSetSendsEachSettingItHasAFlagForAsOnePatch(t *testing.T) {
	a, r := newAgentWisp(t)
	a.answers("PATCH /api/containers/web", 204)
	r.do("containers", "set", "web", "--image", "nginx:1.29", "--env", "A=1", "--env", "B=2", "--unset-env", "C", "--secret-env", "S=hush",
		"--cpu", "2", "--memory", "none", "--restart-policy", "on-failure", "--autostart", "on", "--auto-backup", "off", "--local-dns", "off").wantCode(0)
	want := `{"autoBackup":false,"autostart":true,"cpuLimit":2,"envPatch":{"A":{"value":"1"},"B":{"value":"2"},"C":null,"S":{"secret":true,"value":"hush"}},` +
		`"image":"nginx:1.29","localDns":false,"memoryLimitMiB":null,"restartPolicy":"on-failure"}`
	if got := asJSON(a.body(t, "PATCH /api/containers/web")); got != want {
		t.Fatalf("body %s\nwant %s", got, want)
	}
	if !strings.HasPrefix(r.stdout.String(), "Saved the settings of web.") || strings.Contains(r.out(), "hush") {
		t.Fatalf("stdout %q", r.stdout.String())
	}

	r.do("containers", "set", "web", "--", "worker", "--queue", "jobs").wantCode(0)
	if got := asJSON(a.body(t, "PATCH /api/containers/web")); got != `{"command":["worker","--queue","jobs"]}` {
		t.Fatalf("command body %s", got)
	}
	r.do("containers", "set", "web", "--no-command").wantCode(0)
	if got := asJSON(a.body(t, "PATCH /api/containers/web")); got != `{"command":null}` {
		t.Fatalf("--no-command body %s", got)
	}
}

func TestASettingTheWispRefusesIsItsRefusal(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["PATCH /api/containers/web"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 403, "SCOPE_INSUFFICIENT", "body/runAsRoot: an agent token cannot send this; it needs an admin-scoped token or a session")
	}
	r.do("containers", "set", "web", "--autostart", "on").wantCode(1)
	if r.stderr.String() != "SCOPE_INSUFFICIENT: body/runAsRoot: an agent token cannot send this; it needs an admin-scoped token or a session\n" {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestAWrongSetLineExits2AndSendsNothing(t *testing.T) {
	a, r := newAgentWisp(t)
	for _, args := range [][]string{
		{"containers", "set", "web"},
		{"containers", "set", "web", "--no-command", "--", "sh"},
		{"containers", "set", "web", "--env", "A=1", "--unset-env", "A"},
		{"containers", "set", "web", "--unset-env", "A=1"},
		{"containers", "set", "web", "--no-start"},
		{"containers", "set", "web", "--cpu", "-"},
		{"containers", "set", "web", "--app-config", "/no/such/file.json"},
		{"containers", "update", "web", "--env", "A=1"},
		{"containers", "update"},
	} {
		r.do(args...).wantCode(2)
	}
	if n := a.requestCount(); n != 0 {
		t.Fatalf("%d requests sent", n)
	}
}

func TestUpdatePullsAndRestartsAsOneJob(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/web/image-update", "Update the image of web")
	jobRoute(a.fakeWisp, `{"step":"pulling","detail":"docker.io/library/nginx:1.29"}`,
		`{"step":"done","result":{"name":"web","image":"docker.io/library/nginx:1.29","restarted":true,"applied":true,"note":"Restarted on the updated image."}}`)
	r.do("containers", "update", "web", "--image", "nginx:1.29").wantCode(0)
	if got := asJSON(a.body(t, "POST /api/containers/web/image-update")); got != `{"image":"nginx:1.29"}` {
		t.Fatalf("body %s", got)
	}
	if r.stdout.String() != "web is on docker.io/library/nginx:1.29. Restarted on the updated image.\n" {
		t.Fatalf("stdout %q", r.stdout.String())
	}
	r.do("containers", "update", "web").wantCode(0)
	if got := asJSON(a.body(t, "POST /api/containers/web/image-update")); got != `{}` {
		t.Fatalf("body %s", got)
	}
}

func TestAMalformedSecretEnvNeverEchoesItsValue(t *testing.T) {
	_, r := newAgentWisp(t)
	for _, v := range []string{"hunter2", "=hunter2"} {
		r.do("containers", "create", "web", "--image", "x", "--secret-env", v).wantCode(2)
		if strings.Contains(r.stderr.String(), "hunter2") {
			t.Fatalf("stderr %q", r.stderr.String())
		}
	}
}
