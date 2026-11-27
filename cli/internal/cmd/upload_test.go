package cmd

import (
	"archive/zip"
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateSendsItsMountsInTheOneDeploy(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/containers/deploy", "Deploy site")
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"site","state":"stopped"}}`)
	r.do("containers", "create", "site", "--image", "nginx:1.27", "--no-start", "--mount", "site:/srv:ro", "--mount", "data:/data",
		"--file-mount", "conf:/etc/app.conf:secret:ro", "--tmpfs", "cache:/cache:128", "--tmpfs", "run:/run").wantCode(0)
	want := `[{"containerPath":"/srv","name":"site","readonly":true,"type":"directory"},{"containerPath":"/data","name":"data","type":"directory"},` +
		`{"containerPath":"/etc/app.conf","name":"conf","readonly":true,"secret":true,"type":"file"},` +
		`{"containerPath":"/cache","name":"cache","sizeMiB":128,"type":"tmpfs"},{"containerPath":"/run","name":"run","type":"tmpfs"}]`
	if got := asJSON(a.body(t, "POST /api/containers/deploy")["mounts"]); got != want {
		t.Fatalf("mounts %s\nwant %s", got, want)
	}
	if a.requestCount() != 2 {
		t.Fatalf("%d requests: create is one request and the job's wait", a.requestCount())
	}
}

func TestSetAddsEachMountAfterTheSettingsAndSaysWhatWasSavedBeforeAFailure(t *testing.T) {
	a, r := newAgentWisp(t)
	a.answers("PATCH /api/containers/web", 204)
	added := 0
	a.routes["POST /api/containers/web/mounts"] = func(w http.ResponseWriter, req *http.Request) {
		a.record("POST /api/containers/web/mounts", req)
		if added++; added == 2 {
			refuse(w, 422, "CONTAINER_MOUNT_DUPLICATE", `Duplicate mount name "data"`)
			return
		}
		w.WriteHeader(204)
	}
	r.do("containers", "set", "web", "--autostart", "on", "--mount", "site:/srv", "--mount", "data:/data").wantCode(1)
	if got := asJSON(a.body(t, "PATCH /api/containers/web")); got != `{"autostart":true}` {
		t.Fatalf("patch %s", got)
	}
	if !strings.Contains(r.stdout.String(), "Saved the settings of web.") || !strings.Contains(r.stdout.String(), `Added mount "site"`) {
		t.Fatalf("stdout %q", r.stdout.String())
	}
	if r.stderr.String() != "saved before the failure: the settings, mount \"site\"; then mount \"data\": CONTAINER_MOUNT_DUPLICATE: Duplicate mount name \"data\"\n" {
		t.Fatalf("stderr %q", r.stderr.String())
	}

	// A mount alone: no settings request, and a refusal is the Wisp's alone.
	a.mu.Lock()
	a.bodies = map[string][]map[string]any{}
	a.mu.Unlock()
	added = 1
	r.do("containers", "set", "web", "--mount", "data:/data").wantCode(1)
	if r.stderr.String() != "CONTAINER_MOUNT_DUPLICATE: Duplicate mount name \"data\"\n" || len(a.bodies["PATCH /api/containers/web"]) != 0 {
		t.Fatalf("stderr %q, %d patches", r.stderr.String(), len(a.bodies["PATCH /api/containers/web"]))
	}
}

func TestAppConfigGoesAloneFromAFileOrStandardInput(t *testing.T) {
	a, r := newAgentWisp(t)
	a.answers("PATCH /api/containers/caddy", 204)
	file := filepath.Join(t.TempDir(), "sites.json")
	os.WriteFile(file, []byte(`{"hosts":[{"subdomain":"app","target":"web.local:8080"}]}`), 0o600)
	r.do("containers", "set", "caddy", "--app-config", file).wantCode(0)
	if got := asJSON(a.body(t, "PATCH /api/containers/caddy")); got != `{"appConfig":{"hosts":[{"subdomain":"app","target":"web.local:8080"}]}}` {
		t.Fatalf("body %s", got)
	}
	r.stdin = `{"hosts":[]}`
	r.do("containers", "set", "caddy", "--app-config", "-").wantCode(0)
	if got := asJSON(a.body(t, "PATCH /api/containers/caddy")); got != `{"appConfig":{"hosts":[]}}` {
		t.Fatalf("stdin body %s", got)
	}

	a.routes["PATCH /api/containers/caddy"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 403, "SCOPE_INSUFFICIENT", `Field(s) not agent-writable for "caddy-reverse-proxy": domain. Writable: hosts.`)
	}
	r.do("containers", "set", "caddy", "--app-config", "-").wantCode(1)
	if !strings.HasPrefix(r.stderr.String(), "SCOPE_INSUFFICIENT: Field(s) not agent-writable") {
		t.Fatalf("stderr %q", r.stderr.String())
	}

	before := a.requestCount()
	notJSON := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(notJSON, []byte(`{"hosts":`), 0o600)
	for _, args := range [][]string{
		{"containers", "set", "caddy", "--app-config", file, "--autostart", "on"},
		{"containers", "set", "caddy", "--app-config", file, "--mount", "a:/a"},
		{"containers", "set", "caddy", "--app-config", file, "--", "caddy", "run"},
		{"containers", "set", "caddy", "--app-config", notJSON},
		{"containers", "create", "caddy", "--image", "x", "--app-config", file},
		{"containers", "set", "web", "--mount", "nopath"},
		{"containers", "set", "web", "--mount", "a:/a:rw"},
		{"containers", "set", "web", "--file-mount", "a:/a:ro:ro"},
		{"containers", "set", "web", "--tmpfs", "a:/a:big"},
		{"containers", "set", "web", "--tmpfs", "a:/a:1:2"},
	} {
		r.do(args...).wantCode(2)
	}
	if n := a.requestCount() - before; n != 0 {
		t.Fatalf("%d requests sent", n)
	}
}

// uploadRoute makes key a route that keeps its one file part, then answers
// as answer does.
func (a *agentWisp) uploadRoute(key string, got *[]byte, gotName *string, answer func(w http.ResponseWriter)) {
	a.routes[key] = func(w http.ResponseWriter, r *http.Request) {
		file, header, err := r.FormFile("file")
		if err != nil {
			refuse(w, 400, "UPLOAD_NO_FILE", err.Error())
			return
		}
		*got, _ = io.ReadAll(file)
		*gotName = header.Filename
		answer(w)
	}
}

func TestUploadSendsAFileToAFileMountAndAFolderOrAZipToAFolderMount(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["GET /api/containers/web"] = func(w http.ResponseWriter, req *http.Request) {
		w.Write([]byte(`{"name":"web","mounts":[{"type":"file","name":"conf","containerPath":"/etc/a.conf"},{"type":"directory","name":"site","containerPath":"/srv"}]}`))
	}
	var fileGot, zipGot []byte
	var fileName, zipName string
	a.uploadRoute("POST /api/containers/web/mounts/conf/file", &fileGot, &fileName, func(w http.ResponseWriter) { w.WriteHeader(204) })
	a.uploadRoute("POST /api/containers/web/mounts/site/zip", &zipGot, &zipName, func(w http.ResponseWriter) {
		writeJSON(w, 202, map[string]any{"jobId": "j-1", "kind": "container-zip-extract", "title": "Extract site.zip", "subject": nil})
	})
	jobRoute(a.fakeWisp, `{"step":"extracting"}`, `{"step":"done","result":{"name":"web","mount":"site"}}`)

	dir := t.TempDir()
	conf := filepath.Join(dir, "app.conf")
	os.WriteFile(conf, []byte("listen 8080\n"), 0o644)
	r.do("containers", "upload", "web", "conf", conf).wantCode(0)
	if string(fileGot) != "listen 8080\n" || fileName != "app.conf" || !strings.Contains(r.stdout.String(), `Wrote `+conf+` to mount "conf" of web.`) {
		t.Fatalf("file %q as %q, stdout %q", fileGot, fileName, r.stdout.String())
	}

	site := filepath.Join(dir, "dist")
	os.MkdirAll(filepath.Join(site, "assets", "img"), 0o755)
	os.MkdirAll(filepath.Join(site, "empty"), 0o755)
	os.WriteFile(filepath.Join(site, "index.html"), []byte("<h1>hi</h1>"), 0o644)
	os.WriteFile(filepath.Join(site, "assets", "img", "logo.svg"), []byte("<svg/>"), 0o644)
	r.do("containers", "upload", "web", "site", site).wantCode(0)
	zr, err := zip.NewReader(bytes.NewReader(zipGot), int64(len(zipGot)))
	if err != nil {
		t.Fatalf("not a zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if strings.Join(names, " ") != "assets/ assets/img/ assets/img/logo.svg empty/ index.html" || zipName != "dist.zip" {
		t.Fatalf("zip %v as %q", names, zipName)
	}
	if !strings.Contains(r.stderr.String(), "extracting") || !strings.Contains(r.stdout.String(), `Replaced the content of mount "site" of web`) {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}

	archive := filepath.Join(dir, "site.zip")
	os.WriteFile(archive, zipGot, 0o644)
	zipGot = nil
	r.do("containers", "upload", "web", "site", archive).wantCode(0)
	if !bytes.Equal(zipGot, mustRead(t, archive)) || zipName != "site.zip" {
		t.Fatalf("the zip was not sent as it is")
	}

	r.do("containers", "upload", "web", "site", filepath.Join(dir, "missing")).wantCode(2)
}

func TestAnUploadTheWispRefusesIsItsRefusal(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["POST /api/containers/web/mounts/site/zip"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 409, "CONTAINER_BUSY", `Container "web" is busy (start in progress)`)
	}
	r.do("containers", "upload", "web", "site", t.TempDir()).wantCode(1)
	if r.stderr.String() != "CONTAINER_BUSY: Container \"web\" is busy (start in progress)\n" {
		t.Fatalf("stderr %q", r.stderr.String())
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
