package cmd

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

const usageBody = `{"name":"web","mounts":[{"name":"data","containerPath":"/data","type":"directory","source":"local","hostPath":"/var/lib/wisp/containers/web/files/data","sizeBytes":1610612736,"partial":false},` +
	`{"name":"media","containerPath":"/media","type":"directory","source":"storage","hostPath":"/mnt/wisp/nas/media","sizeBytes":5368709120,"partial":true},` +
	`{"name":"cache","containerPath":"/var/cache","type":"tmpfs","source":"tmpfs","hostPath":null,"sizeBytes":null,"partial":false},` +
	`{"name":"conf","containerPath":"/etc/app.conf","type":"file","source":"local","hostPath":"/var/lib/wisp/containers/web/files/conf","sizeBytes":0,"partial":false}]}`

func TestUsagePrintsEachMountsSizeOnDisk(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/containers/web/mounts/usage"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(usageBody)) }
	r.do("containers", "usage", "web").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"NAME", "KIND", "PATH", "ON DISK"},
		{"data", "directory", "/data", "1.5 GiB"},
		{"media", "directory", "/media", "at least 5.0 GiB", "on a host mount"},
		{"cache", "tmpfs", "/var/cache", "nothing: a memory folder"},
		{"conf", "file", "/etc/app.conf", "0 B"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q:\n%s", want, out)
		}
	}
	if strings.Contains(line(out, "data"), "at least") {
		t.Errorf("a whole size reads as partial: %q", line(out, "data"))
	}
	r.do("containers", "usage", "web", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != usageBody {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestImagesCheckWaitsForTheJobAndPrintsWhatItFound(t *testing.T) {
	a, r := newAgentWisp(t)
	var sent string
	a.routes["POST /api/containers/images/check-updates"] = func(w http.ResponseWriter, req *http.Request) {
		b, _ := io.ReadAll(req.Body)
		sent = string(b)
		writeJSON(w, 202, map[string]any{"jobId": "j-1", "kind": "container-image-update-check", "title": "Check image updates", "subject": nil})
	}
	jobRoute(a.fakeWisp,
		`{"step":"checking","ref":"docker.io/library/nginx:1.27","index":1,"total":2}`,
		`{"step":"updated","ref":"docker.io/library/nginx:1.27","oldDigest":"sha256:a","newDigest":"sha256:b"}`,
		`{"step":"skipped","ref":"localhost/myapp:v1","error":"CONTAINER_IMAGE_LOCAL","detail":"localhost/myapp:v1 is this host's own image: it is not pulled"}`,
		`{"step":"flagged-container","name":"web"}`,
		`{"step":"done","result":{"checked":2,"updated":1,"flaggedContainers":1,"lastCheckedAt":"2026-11-27T12:00:00.000Z"}}`)
	r.do("images", "check").wantCode(0)
	if sent != "" {
		t.Errorf("the check sent a body: %q", sent)
	}
	if r.stdout.String() != "Checked 2 images: 1 has a newer one, and 1 container runs an older one.\n\"wisp overview\" shows which; \"wisp containers update <name>\" moves one to the newer image.\n" {
		t.Errorf("stdout %q", r.stdout.String())
	}
	for _, want := range []string{"Check image updates: job j-1", "checking docker.io/library/nginx:1.27", "updated docker.io/library/nginx:1.27", "skipped localhost/myapp:v1 localhost/myapp:v1 is this host's own image", "flagged-container web"} {
		if !strings.Contains(r.stderr.String(), want) {
			t.Errorf("progress lacks %q:\n%s", want, r.stderr.String())
		}
	}

	r.do("images", "check", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != `{"checked":2,"updated":1,"flaggedContainers":1,"lastCheckedAt":"2026-11-27T12:00:00.000Z"}` {
		t.Errorf("--json %q", r.stdout.String())
	}
	r.do("images", "check", "--no-wait").wantCode(0)
	if r.stdout.String() != "j-1\n" {
		t.Errorf("--no-wait %q", r.stdout.String())
	}
}

func TestImagesCheckWithAReadTokenIsTheWispsRefusal(t *testing.T) {
	f, r := readWisp(t)
	f.routes["POST /api/containers/images/check-updates"] = func(w http.ResponseWriter, r *http.Request) {
		refuse(w, 403, "SCOPE_INSUFFICIENT", "This route needs an agent or admin token")
	}
	r.do("images", "check").wantCode(1)
	if r.stderr.String() != "SCOPE_INSUFFICIENT: This route needs an agent or admin token\n" || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
}
