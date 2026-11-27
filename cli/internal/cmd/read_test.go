package cmd

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

const webDetail = `{"name":"web","uuid":"u1","type":"container","image":"docker.io/library/caddy:2","state":"running",
"command":["caddy","run","--config","/etc/caddy/Caddyfile"],"cpuLimit":1.5,"memoryLimitMiB":null,"restartPolicy":"unless-stopped",
"autostart":true,"autoBackup":false,"runAsRoot":false,"localDns":true,"mdnsHostname":"web.local","pid":4242,"uptime":7260500,
"env":{"PLAIN":{"value":"hello"},"API_KEY":{"value":null,"secret":true,"isSet":true}},
"mounts":[{"type":"directory","name":"site","containerPath":"/srv","readonly":true},{"type":"file","name":"cert","containerPath":"/etc/c.pem","secret":true,"isSet":true,"sizeBytes":2048}],
"devices":[],"services":[{"port":80,"type":"_http._tcp","txt":{"path":"/"}}],
"network":{"type":"bridge","interface":"br0","ip":"192.168.1.50","mac":"02:00:00:00:00:01"},
"metadata":{"app":"caddy","appConfig":{"hosts":[{"name":"www","upstream":"10.0.0.2:80"}],"token":"****"}},
"pendingRestart":null,"scheduledRestart":null,"updateAvailable":false}`

func readWisp(t *testing.T) (*fakeWisp, *run) {
	f := newFakeWisp(t, "1.0.0")
	f.tokens["wisp_read_t"] = true
	f.routes["GET /api/containers/web"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(webDetail)) }
	r := newRun(t)
	r.env["WISP_URL"], r.env["WISP_TOKEN"] = f.URL, "wisp_read_t"
	return f, r
}

func TestShowPrintsEverythingWithTheSecretsMasked(t *testing.T) {
	_, r := readWisp(t)
	r.do("containers", "show", "web").wantCode(0)
	out := r.stdout.String()
	for _, want := range []string{
		"Name:", "web", "running (pid 4242, up 2h1m0s)", "caddy run --config /etc/caddy/Caddyfile", "1.5 cores",
		"Memory limit:", "none", "unless-stopped", "Local DNS:", "on (web.local)", "bridge br0, 192.168.1.50, mac 02:00:00:00:00:01",
		"PLAIN=hello", "API_KEY=(secret, set)", "site", "/srv", "read-only", "cert", "secret, set", "2.0 KiB",
		"_http._tcp port 80 path=/", "App:", "caddy", "App config:", `"upstream": "10.0.0.2:80"`, `"token": "****"`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("show lacks %q", want)
		}
	}
	if t.Failed() {
		t.Log(out)
	}
	r.do("containers", "show", "web", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != webDetail {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestImagesAndJobsLists(t *testing.T) {
	f, r := readWisp(t)
	images := `[{"name":"localhost/myapp:v1","digest":"sha256:0123456789abcdef0123","size":15728640,"updated":"2026-11-26T10:00:00.000Z"},{"name":"docker.io/library/caddy:2","digest":"sha256:fedcba9876543210ffff","size":512,"updated":null}]`
	f.routes["GET /api/containers/images"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(images)) }
	jobs := `{"jobs":[{"jobId":"j-1","kind":"container-start","title":"Start web","subject":{"type":"container","name":"web"},"status":"done","createdAt":1764150000000},{"jobId":"j-2","kind":"image-update-check","title":"Check images","subject":null,"status":"running","createdAt":1764150001000}]}`
	f.routes["GET /api/jobs"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(jobs)) }

	r.do("images", "list").wantCode(0)
	out := r.stdout.String()
	for _, want := range []string{"NAME", "localhost/myapp:v1", "15.0 MiB", "0123456789ab", "512 B", "—"} {
		if !strings.Contains(out, want) {
			t.Errorf("images list lacks %q:\n%s", want, out)
		}
	}
	r.do("images", "list", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != images {
		t.Error("images --json changed")
	}

	r.do("jobs", "list").wantCode(0)
	out = r.stdout.String()
	for _, want := range []string{"ID", "j-1", "done", "container web", "Start web", "j-2", "running", "Check images"} {
		if !strings.Contains(out, want) {
			t.Errorf("jobs list lacks %q:\n%s", want, out)
		}
	}
	r.do("jobs", "list", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != jobs {
		t.Error("jobs --json changed")
	}
}

func sseWrite(w http.ResponseWriter, frames ...string) {
	for _, f := range frames {
		fmt.Fprintf(w, "data: %s\n\n", f)
	}
	w.(http.Flusher).Flush()
}

func TestLogsPrintsTheLastLinesAndEnds(t *testing.T) {
	f, r := readWisp(t)
	var history []string
	for i := 1; i <= 150; i++ {
		history = append(history, fmt.Sprintf(`"line %d"`, i))
	}
	var gotRun string
	f.routes["GET /api/containers/web/logs"] = func(w http.ResponseWriter, req *http.Request) {
		gotRun = req.URL.Query().Get("runId")
		w.Header().Set("Content-Type", "text/event-stream")
		sseWrite(w, `{"type":"history","runId":"2026-11-26T10-00-00-000Z","lines":[`+strings.Join(history, ",")+`]}`)
		<-req.Context().Done() // the stream stays open, as Wisp's does
	}
	r.do("containers", "logs", "web").wantCode(0)
	lines := strings.Split(strings.TrimSpace(r.stdout.String()), "\n")
	if len(lines) != 100 || lines[0] != "line 51" || lines[99] != "line 150" {
		t.Fatalf("%d lines, %q … %q", len(lines), lines[0], lines[len(lines)-1])
	}
	r.do("containers", "logs", "--lines", "3", "web", "--run", "2026-11-26T09-00-00-000Z").wantCode(0)
	if r.stdout.String() != "line 148\nline 149\nline 150\n" || gotRun != "2026-11-26T09-00-00-000Z" {
		t.Fatalf("stdout %q, run %q", r.stdout.String(), gotRun)
	}
}

func TestLogsOfAContainerThatNeverRan(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/containers/web/logs"] = func(w http.ResponseWriter, req *http.Request) {
		sseWrite(w, `{"type":"history","runId":null,"lines":[]}`)
		<-req.Context().Done()
	}
	r.do("containers", "logs", "web", "--follow").wantCode(0)
	if r.stdout.Len() != 0 || !strings.Contains(r.stderr.String(), "has not run yet") {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}
}

func TestLogsFollowPrintsNewLinesUntilInterrupted(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/containers/web/logs"] = func(w http.ResponseWriter, req *http.Request) {
		sseWrite(w, `{"type":"history","runId":"r1","lines":["old"]}`)
		sseWrite(w, `{"type":"line","line":"new 1"}`, `{"type":"line","line":"new 2"}`)
		<-req.Context().Done()
	}
	r.interruptOnceItPrints("new 2")
	r.do("containers", "logs", "web", "--follow").wantCode(0)
	if r.stdout.String() != "old\nnew 1\nnew 2\n" {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func jobRoute(f *fakeWisp, frames ...string) {
	f.routes["GET /api/jobs/j-1/progress"] = func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte(": keepalive\n\n"))
		sseWrite(w, frames...)
	}
}

func TestJobsWaitEndsWithTheResult(t *testing.T) {
	f, r := readWisp(t)
	jobRoute(f, `{"step":"pulling","percent":40,"detail":"layer 2 of 5"}`, `{"step":"starting"}`, `{"step":"done","result":{"name":"web"}}`)
	r.do("jobs", "wait", "j-1").wantCode(0)
	if r.stderr.String() != "pulling 40% layer 2 of 5\nstarting\n" || !strings.Contains(r.stdout.String(), `"name": "web"`) {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}
	r.do("jobs", "wait", "j-1", "--json").wantCode(0)
	if r.stdout.String() != `{"name":"web"}`+"\n" {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func TestJobsWaitEndsWithTheError(t *testing.T) {
	f, r := readWisp(t)
	jobRoute(f, `{"step":"pulling"}`, `{"step":"error","error":"CONTAINER_IMAGE_NOT_FOUND","detail":"no such image"}`)
	r.do("jobs", "wait", "j-1").wantCode(1)
	if r.stderr.String() != "pulling\nCONTAINER_IMAGE_NOT_FOUND: no such image\n" {
		t.Fatalf("stderr %q", r.stderr.String())
	}
	r.do("jobs", "wait", "j-1", "--json").wantCode(1)
	if !strings.HasSuffix(r.stderr.String(), `{"detail":"no such image","error":"CONTAINER_IMAGE_NOT_FOUND"}`+"\n") {
		t.Fatalf("stderr %q", r.stderr.String())
	}

	jobRoute(f, `{"step":"cancelled"}`)
	r.do("jobs", "wait", "j-1").wantCode(1)
	if !strings.Contains(r.stderr.String(), "cancelled") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
	r.do("jobs", "wait", "gone").wantCode(1)
}

func TestAnInterruptEndsTheWaitNotTheJob(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/jobs/j-1/progress"] = func(w http.ResponseWriter, req *http.Request) {
		sseWrite(w, `{"step":"pulling"}`)
		<-req.Context().Done()
	}
	r.interruptOnceItPrints("pulling")
	r.do("jobs", "wait", "j-1").wantCode(1)
	if !strings.Contains(r.stderr.String(), "the job j-1 goes on") {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func TestAnUptimeIsTheAPIsMilliseconds(t *testing.T) {
	for ms, want := range map[float64]string{450: "0s", 70_400: "1m10s", 3_599_999: "59m59s", 7_260_500: "2h1m0s"} {
		if got := durationText(ms); got != want {
			t.Errorf("durationText(%v) = %q, want %q", ms, got, want)
		}
	}
}
