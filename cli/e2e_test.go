package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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
	binary   atomic.Pointer[[]byte] // the download, or nil for none
	// The deploy's body, and its job's progress (an e2eJob).
	deployBody atomic.Value
	job        atomic.Value
	// The VM lifecycle requests that reached it.
	vmRequests atomic.Int32
}

// e2eJob is the frames of a job's progress; with hangs, the stream stays
// open after them.
type e2eJob struct {
	frames []string
	hangs  bool
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
			binary := w.binary.Load()
			if binary == nil {
				reply(404, map[string]string{"error": "CLI_NOT_AVAILABLE", "detail": "none"})
				return
			}
			rw.Header().Set("Content-Type", "application/octet-stream")
			rw.Write(*binary)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+w.token {
			reply(401, map[string]string{"error": "AUTH_INVALID", "detail": "Invalid API token"})
			return
		}
		if v := r.Header.Get("Wisp-Cli-Version"); v != w.version {
			reply(409, map[string]string{"error": "CLI_VERSION_MISMATCH", "detail": "This wisp CLI is " + v + " and this Wisp is " + w.version + ": run `wisp update` to get this Wisp's CLI."})
			return
		}
		switch r.URL.Path {
		case "/api/containers":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`[{"name":"web","image":"nginx:1.27","state":"running","updateAvailable":false,"scheduledRestart":null,"pendingRestart":null}]`))
		case "/api/jobs":
			reply(200, map[string]any{"jobs": []any{}})
		case "/api/overview":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(e2eOverview))
		case "/api/vms":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`[]`))
		case "/api/vms/ubuntu":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(e2eVM))
		case "/api/containers/web/mounts/usage":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`{"name":"web","mounts":[{"name":"cache","containerPath":"/var/cache","type":"tmpfs","source":"tmpfs","hostPath":null,"sizeBytes":null,"partial":false},{"name":"data","containerPath":"/data","type":"directory","source":"local","hostPath":"/x","sizeBytes":2048,"partial":true}]}`))
		case "/api/containers/images/check-updates":
			if w.token == "wisp_read_e2e" {
				reply(403, map[string]string{"error": "SCOPE_INSUFFICIENT", "detail": "This route needs an agent or admin token"})
				return
			}
			reply(202, map[string]any{"jobId": "j-1", "kind": "container-image-update-check", "title": "Check image updates", "subject": nil})
		case "/api/host/stats":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`{"cpu":{"allocated":2,"total":4,"usagePercent":12.5,"perCore":[10,15]},"cpuTemp":null,"cpuTempThresholds":null,"thermalZones":[],"cpuPowerWatts":null,"memory":{"allocatedGB":2,"totalGB":16,"usagePercent":40,"usedBytes":1,"buffersBytes":1,"cachedBytes":1,"swapTotalBytes":0,"swapUsedBytes":0},"loadAvg":[0.5,0.4,0.3],"disk":{"readMBs":0,"writeMBs":0},"net":{"rxMBs":0,"txMBs":0},"runningVMs":1,"runningContainers":0,"pendingUpdates":0,"updatesLastChecked":null,"updateOperationInProgress":false,"rebootRequired":false,"rebootReasons":[],"certificateFailed":false,"wispUpdate":{"current":"9.9.9-e2e","latest":null,"available":false,"lastChecked":null}}`))
		case "/api/host/hardware":
			rw.Header().Set("Content-Type", "application/json")
			rw.Write([]byte(`{"cpu":{"model":"Test CPU","cores":4,"threads":8,"mhz":null,"cacheKb":null,"coreTypes":null},"disks":[],"filesystems":[],"network":[],"memory":[],"memoryError":null,"pciDevices":[{"address":"0000:00:02.0","classId":"0300","classCode":"030000","className":"VGA compatible controller","vendor":"Intel Corporation","vendorId":"8086","device":"UHD Graphics","deviceId":"3e92","driver":"i915"}],"system":null}`))
		case "/api/vms/gone":
			reply(404, map[string]string{"error": "VM_NOT_FOUND", "detail": `VM "gone" not found`})
		case "/api/containers/deploy":
			body, _ := io.ReadAll(r.Body)
			w.deployBody.Store(string(body))
			reply(202, map[string]any{"jobId": "j-1", "kind": "container-deploy", "title": "Deploy web", "subject": map[string]string{"type": "container", "name": "web"}})
		case "/api/vms/ubuntu/start", "/api/vms/ubuntu/force-stop":
			w.vmRequests.Add(1)
			reply(202, map[string]any{"jobId": "j-1", "kind": "vm-" + strings.TrimPrefix(r.URL.Path, "/api/vms/ubuntu/"), "title": "ubuntu", "subject": map[string]string{"type": "vm", "name": "ubuntu"}})
		case "/api/vms/ubuntu/reboot":
			w.vmRequests.Add(1)
			rw.WriteHeader(204)
		case "/api/jobs/j-1/progress":
			rw.Header().Set("Content-Type", "text/event-stream")
			job, _ := w.job.Load().(e2eJob)
			for _, f := range job.frames {
				fmt.Fprintf(rw, "data: %s\n\n", f)
			}
			rw.(http.Flusher).Flush()
			if job.hangs {
				<-r.Context().Done()
			}
		default:
			reply(404, map[string]string{"error": "ROUTE_NOT_FOUND", "detail": r.URL.Path})
		}
	}))
	t.Cleanup(w.Close)
	return w
}

const e2eOverview = `{"wispVersion":"9.9.9-e2e","serverName":"Lab","host":{"hostname":"lab","kernel":"6.8.0","primaryAddress":"192.168.1.5","uptimeSeconds":3600,"libvirtVersion":"10.0.0","qemuVersion":"8.2.2"},"bridges":["br0"],"sections":[],"certificate":null,` +
	`"containers":[{"name":"web","state":"stopped","image":"nginx:1.27","updateAvailable":false,"ip":null,"lastKnownIp":"192.168.1.20","bridge":"br0","mdnsName":null,"app":null,"autostart":false,"autoBackup":false,"restartPolicy":"never"}],` +
	`"vms":[{"name":"ubuntu","state":"running","vcpus":2,"memoryMiB":2048,"profile":"linux","ip":"192.168.1.10","guestHostname":"ubuntu"}]}`

const e2eVM = `{"name":"ubuntu","state":"running","stateCode":1,"autostart":false,"vcpus":2,"memoryMiB":2048,"profile":"linux","firmware":"uefi","cpuMode":"host-passthrough","cpuTopology":null,"bootOrder":["hd"],` +
	`"disks":[{"slot":"sda","device":"disk","bus":"virtio","source":"/var/lib/wisp/vms/ubuntu/disk0.qcow2","sizeGiB":20}],"nics":[{"type":"bridge","mac":"52:54:00:00:00:01","source":"br0","model":"virtio"}],` +
	`"guestAgent":true,"pendingRestart":null,"startedAt":1764150000000,"guestNetwork":{"ip":"192.168.1.10","hostname":"ubuntu"}}`

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

func TestTheBuiltBinaryReadsTheHost(t *testing.T) {
	bin := buildWisp(t, t.TempDir(), e2eVersion)
	wisp := newE2EWisp(t, e2eVersion, "wisp_read_e2e")
	env := append(homeEnv(t.TempDir()), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_read_e2e")

	got := runWisp(t, bin, env, "", "overview")
	if got.code != 0 || !strings.Contains(got.stdout, "Certificate:  none") || !strings.Contains(got.stdout, "old address 192.168.1.20") ||
		!strings.Contains(got.stdout, "192.168.1.10") {
		t.Fatalf("overview: %+v", got)
	}
	got = runWisp(t, bin, env, "", "overview", "--json")
	if got.code != 0 || strings.TrimSpace(got.stdout) != e2eOverview {
		t.Fatalf("overview --json: %+v", got)
	}

	got = runWisp(t, bin, env, "", "vms", "list")
	if got.code != 0 || got.stdout != "No VMs.\n" {
		t.Fatalf("vms list: %+v", got)
	}
	got = runWisp(t, bin, env, "", "vms", "show", "ubuntu")
	if got.code != 0 || !strings.Contains(got.stdout, "192.168.1.10") || !strings.Contains(got.stdout, "20 GiB") || !strings.Contains(got.stdout, "52:54:00:00:00:01") {
		t.Fatalf("vms show: %+v", got)
	}
	got = runWisp(t, bin, env, "", "vms", "show", "ubuntu", "--json")
	if got.code != 0 || strings.TrimSpace(got.stdout) != e2eVM {
		t.Fatalf("vms show --json: %+v", got)
	}
	got = runWisp(t, bin, env, "", "vms", "show", "gone")
	if got.code != 1 || !strings.HasPrefix(got.stderr, "VM_NOT_FOUND: ") {
		t.Fatalf("vms show gone: %+v", got)
	}

	got = runWisp(t, bin, env, "", "host", "stats")
	if got.code != 0 || !strings.Contains(got.stdout, "12.5% of 4 cores") || !strings.Contains(got.stdout, "Sensors:\n  none") {
		t.Fatalf("host stats: %+v", got)
	}
	got = runWisp(t, bin, env, "", "containers", "usage", "web")
	if got.code != 0 || !strings.Contains(got.stdout, "nothing: a memory folder") || !strings.Contains(got.stdout, "at least 2.0 KiB") {
		t.Fatalf("containers usage: %+v", got)
	}
	got = runWisp(t, bin, env, "", "images", "check")
	if got.code != 1 || !strings.HasPrefix(got.stderr, "SCOPE_INSUFFICIENT: ") {
		t.Fatalf("images check with a read token: %+v", got)
	}
	got = runWisp(t, bin, env, "", "host", "hardware")
	if got.code != 0 || !strings.Contains(got.stdout, "Test CPU") || !strings.Contains(got.stdout, "UHD Graphics") || !strings.Contains(got.stdout, "Memory modules:\n  none") {
		t.Fatalf("host hardware: %+v", got)
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
	wisp.binary.Store(&newBytes)
	env := append(homeEnv(t.TempDir()), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_read_e2e")

	got := runWisp(t, oldBin, env, "", "containers", "list")
	if got.code != 1 || !strings.Contains(got.stderr, "9.9.8-old") || !strings.Contains(got.stderr, e2eVersion) || !strings.Contains(got.stderr, "wisp update") {
		t.Fatalf("across versions: %+v", got)
	}
	// A download that fails leaves the old binary, which still runs.
	wisp.binary.Store(nil)
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
	portal := []byte("<html>Sign in to the Wi-Fi</html>")
	wisp.binary.Store(&portal)
	got = runWisp(t, oldBin, env, "", "update")
	if got.code != 1 || !strings.Contains(got.stderr, "stays as it was") {
		t.Fatalf("update from a portal: %+v", got)
	}
	if got = runWisp(t, oldBin, env, "", "version"); !strings.Contains(got.stdout, "wisp CLI  9.9.8-old") {
		t.Fatalf("after the portal: %+v", got)
	}

	wisp.binary.Store(&newBytes)
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

func TestTheBuiltBinaryChecksImagesCreatesAContainerAndAnInterruptLeavesTheJob(t *testing.T) {
	bin := buildWisp(t, t.TempDir(), e2eVersion)
	wisp := newE2EWisp(t, e2eVersion, "wisp_agent_e2e")
	env := append(homeEnv(t.TempDir()), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_agent_e2e")
	wisp.job.Store(e2eJob{frames: []string{`{"step":"checking","ref":"nginx:1.27","index":1,"total":1}`, `{"step":"done","result":{"checked":1,"updated":0,"flaggedContainers":0,"lastCheckedAt":"2026-11-27T12:00:00.000Z"}}`}})
	got := runWisp(t, bin, env, "", "images", "check")
	if got.code != 0 || got.stdout != "Checked 1 image: 0 have a newer one, and 0 containers run an older one.\n" || !strings.Contains(got.stderr, "checking nginx:1.27") {
		t.Fatalf("images check: %+v", got)
	}

	wisp.job.Store(e2eJob{frames: []string{`{"step":"pulling"}`, `{"step":"starting"}`, `{"step":"done","result":{"name":"web","state":"running","env":{"K":{"value":"v"}}}}`}})

	got = runWisp(t, bin, env, "", "containers", "create", "web", "--image", "nginx:1.27", "--env", "K=v", "--", "nginx", "-g", "daemon off;")
	if got.code != 0 || !strings.Contains(got.stdout, "running") || !strings.Contains(got.stdout, "K=v") || !strings.Contains(got.stderr, "starting") {
		t.Fatalf("create: %+v", got)
	}
	if body := wisp.deployBody.Load(); body != `{"command":["nginx","-g","daemon off;"],"env":{"K":"v"},"image":"nginx:1.27","name":"web"}` {
		t.Fatalf("deploy body %v", body)
	}

	if runtime.GOOS == "windows" {
		return // no interrupt to send a process here
	}
	wisp.job.Store(e2eJob{frames: []string{`{"step":"pulling"}`}, hangs: true})
	c := exec.Command(bin, "containers", "create", "web", "--image", "nginx:1.27")
	c.Env = env
	stderr := lockedBuffer{changed: make(chan struct{}, 1)}
	c.Stderr = &stderr
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(10 * time.Second)
	for !strings.Contains(stderr.String(), "pulling") {
		select {
		case <-stderr.changed:
		case <-deadline:
			c.Process.Kill()
			t.Fatalf("the CLI never printed its progress: %q", stderr.String())
		}
	}
	if err := c.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	err := c.Wait()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || !strings.Contains(stderr.String(), "the job j-1 goes on") {
		t.Fatalf("interrupted: %v\nstderr: %s", err, stderr.String())
	}
}

func TestTheBuiltBinaryStartsStopsAndRestartsAVM(t *testing.T) {
	bin := buildWisp(t, t.TempDir(), e2eVersion)
	wisp := newE2EWisp(t, e2eVersion, "wisp_agent_e2e")
	env := append(homeEnv(t.TempDir()), "WISP_URL="+wisp.URL, "WISP_TOKEN=wisp_agent_e2e")
	wisp.job.Store(e2eJob{frames: []string{`{"step":"done","result":{"name":"ubuntu"}}`}})
	for _, c := range []struct {
		args   []string
		stdout string
	}{
		{[]string{"vms", "start", "ubuntu"}, "Started ubuntu.\n"},
		{[]string{"vms", "stop", "ubuntu", "--force"}, "Stopped ubuntu.\n"},
		{[]string{"vms", "restart", "ubuntu"}, "Asked the guest of ubuntu to restart.\n"},
	} {
		got := runWisp(t, bin, env, "", c.args...)
		if got.code != 0 || got.stdout != c.stdout {
			t.Fatalf("%v: %+v", c.args, got)
		}
	}
	if n := wisp.vmRequests.Load(); n != 3 {
		t.Fatalf("%d VM requests reached the Wisp, want 3", n)
	}
}

// lockedBuffer is a buffer the test reads while the process writes it; each
// write signals changed, so the test waits for output without polling.
type lockedBuffer struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	changed chan struct{}
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n, err := b.buf.Write(p)
	select {
	case b.changed <- struct{}{}:
	default: // a signal is pending already: the waiter reads everything once woken
	}
	return n, err
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
