package cmd

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

const vmsBody = `[{"name":"ubuntu","uuid":"u1","state":"running","stateCode":1,"vcpus":4,"memoryMiB":4096,"profile":"linux","iconId":null,"guestAgent":true,"pendingRestart":{"since":"2026-11-26T10:00:00.000Z"},"startedAt":1764150000000,"staleBinary":false},` +
	`{"name":"win","uuid":"u2","state":"shutoff","stateCode":5,"vcpus":8,"memoryMiB":16384,"profile":"windows-11","iconId":null,"guestAgent":false,"pendingRestart":null,"startedAt":null,"staleBinary":false},` +
	`{"name":"old","uuid":"u3","state":"running","stateCode":1,"vcpus":1,"memoryMiB":512,"profile":null,"iconId":null,"guestAgent":false,"pendingRestart":null,"startedAt":1764150000000,"staleBinary":true}]`

// vmDetailBody is a running VM's read, started `up` before now.
func vmDetailBody(up time.Duration) string {
	return fmt.Sprintf(`{"name":"ubuntu","uuid":"u1","state":"running","stateCode":1,"autostart":true,"vcpus":4,"memoryMiB":4096,"osType":"hvm","profile":"linux","arch":"x86_64","machineType":"pc-q35-9.2","firmware":"uefi","cpuMode":"host-passthrough",`+
		`"cpuTopology":{"sockets":1,"dies":1,"cores":4,"threads":1},"cpuFeatures":[],"nestedVirt":false,"bootOrder":["hd","cdrom"],"bootMenu":false,`+
		`"disks":[{"slot":"sda","device":"disk","bus":"virtio","source":"/var/lib/wisp/vms/ubuntu/disk0.qcow2","driverType":"qcow2","readonly":false,"sizeGiB":32},{"slot":"sdc","device":"cdrom","bus":"sata","source":null,"driverType":"raw","readonly":true}],`+
		`"nics":[{"type":"bridge","mac":"52:54:00:aa:bb:cc","source":"br0","model":"virtio","target":"vnet3"}],"graphics":{"type":"vnc","port":5900,"listen":"127.0.0.1","autoport":"yes"},"videoModel":"virtio","features":{"hyperv":false},`+
		`"memBalloon":true,"guestAgent":true,"vtpm":false,"virtioRng":true,"iconId":null,"pendingRestart":null,"startedAt":%d,"guestNetwork":{"ip":"192.168.1.10","hostname":"ubuntu-guest"}}`,
		time.Now().Add(-up).UnixMilli())
}

const vmOffBody = `{"name":"win","state":"shutoff","stateCode":5,"autostart":false,"vcpus":8,"memoryMiB":16384,"profile":"windows-11","firmware":"uefi-secure","cpuMode":null,"cpuTopology":null,"bootOrder":[],"disks":[],"nics":[],"guestAgent":false,"pendingRestart":null,"startedAt":null,"guestNetwork":{"ip":null,"hostname":null}}`

func TestVMsListMarksOneThatWaitsForARestart(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/vms"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(vmsBody)) }
	r.do("vms", "list").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"NAME", "STATE", "VCPUS", "MEMORY", "PROFILE"},
		{"ubuntu", "running", "4", "4096 MiB", "linux", "restart pending"},
		{"win", "shutoff", "8", "16384 MiB", "windows-11"},
		{"old", "running", "512 MiB", "—", "restart pending: QEMU was updated"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q:\n%s", want, out)
		}
	}
	if strings.Contains(line(out, "win"), "restart") {
		t.Errorf("win waits for no restart: %q", line(out, "win"))
	}
	r.do("vms", "list", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != vmsBody {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestAWispWithNoVMSaysSo(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/vms"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`[]`)) }
	r.do("vms", "list").wantCode(0)
	if r.stdout.String() != "No VMs.\n" {
		t.Fatalf("stdout %q", r.stdout.String())
	}
}

func TestVMsShowPrintsTheStateTheGuestAndTheSettings(t *testing.T) {
	f, r := readWisp(t)
	body := vmDetailBody(2*time.Hour + time.Minute + 30*time.Second)
	f.routes["GET /api/vms/ubuntu"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }
	r.do("vms", "show", "ubuntu").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"State:", "running (up 2h1m0s)"},
		{"Guest name:", "ubuntu-guest"},
		{"Guest address:", "192.168.1.10"},
		{"CPU:", "4 vCPUs, host-passthrough", "1 sockets, 4 cores, 1 threads"},
		{"Memory:", "4096 MiB"},
		{"Firmware:", "uefi"},
		{"Boot order:", "hd, cdrom"},
		{"Autostart:", "on"},
		{"sda", "disk", "virtio", "32 GiB", "/var/lib/wisp/vms/ubuntu/disk0.qcow2"},
		{"sdc", "cdrom", "empty"},
		{"52:54:00:aa:bb:cc", "br0", "virtio"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q", want)
		}
	}
	if t.Failed() {
		t.Log(out)
	}
	r.do("vms", "show", "ubuntu", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != body {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestAVMThatIsOffShowsNoUptimeAndNoGuest(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/vms/win"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(vmOffBody)) }
	r.do("vms", "show", "win").wantCode(0)
	out := r.stdout.String()
	if line(out, "State:", "shutoff") == "" || strings.Contains(out, "up ") || strings.Contains(out, "Guest name") {
		t.Errorf("off:\n%s", out)
	}
	if !strings.Contains(out, "Disks:\n  none\n") || !strings.Contains(out, "Network cards:\n  none\n") || line(out, "Boot order:", "none") == "" {
		t.Errorf("none:\n%s", out)
	}
}

func TestARunningVMWithoutTheAgentHasNoKnownGuest(t *testing.T) {
	f, r := readWisp(t)
	body := strings.Replace(strings.Replace(vmDetailBody(time.Minute), `"ip":"192.168.1.10","hostname":"ubuntu-guest"`, `"ip":null,"hostname":null`, 1), `"guestAgent":true`, `"guestAgent":false`, 1)
	f.routes["GET /api/vms/ubuntu"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }
	r.do("vms", "show", "ubuntu").wantCode(0)
	if line(r.stdout.String(), "Guest:", "unknown: the VM has no guest agent") == "" {
		t.Fatalf("stdout:\n%s", r.stdout.String())
	}
}

func TestAnUnknownVMIsTheWispsRefusal(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/vms/gone"] = func(w http.ResponseWriter, r *http.Request) { refuse(w, 404, "VM_NOT_FOUND", `VM "gone" not found`) }
	r.do("vms", "show", "gone").wantCode(1)
	if r.stderr.String() != "VM_NOT_FOUND: VM \"gone\" not found\n" || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
}

func TestTheUptimeIsTheHostsByItsDateHeader(t *testing.T) {
	started := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	body := strings.Replace(vmOffBody, `"state":"shutoff","stateCode":5`, `"state":"running","stateCode":1`, 1)
	body = strings.Replace(body, `"startedAt":null`, fmt.Sprintf(`"startedAt":%d`, started.UnixMilli()), 1)
	for _, c := range []struct {
		date string // "" for no Date header
		want string
	}{
		{started.Add(3*time.Hour + 20*time.Minute).Format(http.TimeFormat), "running (up 3h20m0s)"},
		{started.Add(-2 * time.Second).Format(http.TimeFormat), "running (up 0s)"},
	} {
		f, r := readWisp(t)
		f.routes["GET /api/vms/win"] = func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Date", c.date)
			w.Write([]byte(body))
		}
		r.do("vms", "show", "win").wantCode(0)
		if line(r.stdout.String(), "State:", c.want) == "" {
			t.Errorf("Date %q: want %q:\n%s", c.date, c.want, r.stdout.String())
		}
	}

	// With no Date, or one that does not parse, the client's clock.
	recent := strings.Replace(body, fmt.Sprintf(`"startedAt":%d`, started.UnixMilli()), fmt.Sprintf(`"startedAt":%d`, time.Now().Add(-2*time.Hour).UnixMilli()), 1)
	for _, date := range []string{"", "yesterday-ish"} {
		f, r := readWisp(t)
		f.routes["GET /api/vms/win"] = func(w http.ResponseWriter, r *http.Request) {
			if date == "" {
				w.Header()["Date"] = nil // net/http adds none
			} else {
				w.Header().Set("Date", date)
			}
			w.Write([]byte(recent))
		}
		r.do("vms", "show", "win").wantCode(0)
		if line(r.stdout.String(), "State:", "running (up 2h0m0s)") == "" {
			t.Errorf("Date %q:\n%s", date, r.stdout.String())
		}
	}
}

func TestVMsStartAndAForcedStopWaitForTheirJob(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/vms/ubuntu/start", "Start ubuntu")
	a.startsJob("POST /api/vms/ubuntu/force-stop", "Force stop ubuntu")
	jobRoute(a.fakeWisp, `{"step":"done","result":{"name":"ubuntu"}}`)
	for _, c := range []struct {
		args   []string
		title  string
		stdout string
	}{
		{[]string{"vms", "start", "ubuntu"}, "Start ubuntu", "Started ubuntu.\n"},
		{[]string{"vms", "stop", "ubuntu", "--force"}, "Force stop ubuntu", "Stopped ubuntu.\n"},
	} {
		r.do(c.args...).wantCode(0)
		if r.stdout.String() != c.stdout || r.stderr.String() != c.title+": job j-1\n" {
			t.Fatalf("%v: stdout %q stderr %q", c.args, r.stdout.String(), r.stderr.String())
		}
	}
	if a.lastRequest().URL.Path != "/api/jobs/j-1/progress" {
		t.Fatalf("last request %s", a.lastRequest().URL.Path)
	}
	r.do("vms", "stop", "--force", "ubuntu", "--no-wait").wantCode(0)
	if r.stdout.String() != "j-1\n" || a.lastRequest().URL.Path != "/api/vms/ubuntu/force-stop" {
		t.Fatalf("--no-wait: stdout %q, last request %s", r.stdout.String(), a.lastRequest().URL.Path)
	}
}

func TestStartingARunningVMIsTheWispsRefusal(t *testing.T) {
	a, r := newAgentWisp(t)
	a.routes["POST /api/vms/ubuntu/start"] = func(w http.ResponseWriter, req *http.Request) {
		refuse(w, 409, "VM_ALREADY_RUNNING", `VM "ubuntu" is already running`)
	}
	r.do("vms", "start", "ubuntu").wantCode(1)
	if r.stderr.String() != "VM_ALREADY_RUNNING: VM \"ubuntu\" is already running\n" || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
}

func TestVMsRestartAsksTheGuestAndEndsAtOnce(t *testing.T) {
	a, r := newAgentWisp(t)
	a.answers("POST /api/vms/ubuntu/reboot", 204)
	r.do("vms", "restart", "ubuntu").wantCode(0)
	if r.stdout.String() != "Asked the guest of ubuntu to restart.\n" || r.stderr.Len() != 0 {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}
	if a.lastRequest().URL.Path != "/api/vms/ubuntu/reboot" {
		t.Fatalf("last request %s", a.lastRequest().URL.Path)
	}
	before := a.requestCount()
	r.do("vms", "restart", "ubuntu", "--json").wantCode(2)
	r.do("vms", "start").wantCode(2)
	if a.requestCount() != before {
		t.Fatal("a wrong line sent a request")
	}
}

func TestVMsStopAsksTheGuestAndEndsWhenTheVMIsOff(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/vms/ubuntu/stop", "Stop ubuntu")
	jobRoute(a.fakeWisp, `{"step":"shutting-down"}`, `{"step":"done","result":{"name":"ubuntu"}}`)
	r.do("vms", "stop", "ubuntu").wantCode(0)
	if r.stdout.String() != "Stopped ubuntu.\n" || r.stderr.String() != "Stop ubuntu: job j-1\nshutting-down\n" {
		t.Fatalf("stdout %q stderr %q", r.stdout.String(), r.stderr.String())
	}
	r.do("vms", "stop", "ubuntu", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != `{"name":"ubuntu"}` {
		t.Fatalf("--json: %q", r.stdout.String())
	}
}

func TestAStopTheGuestIgnoresEndsWithTheJobsError(t *testing.T) {
	a, r := newAgentWisp(t)
	a.startsJob("POST /api/vms/ubuntu/stop", "Stop ubuntu")
	jobRoute(a.fakeWisp, `{"step":"shutting-down"}`, `{"step":"error","error":"VM_STOP_TIMEOUT","detail":"VM \"ubuntu\" is not off 5 min after its guest was asked to shut down: it is left as it is"}`)
	r.do("vms", "stop", "ubuntu").wantCode(1)
	if !strings.HasSuffix(r.stderr.String(), "VM_STOP_TIMEOUT: VM \"ubuntu\" is not off 5 min after its guest was asked to shut down: it is left as it is\n") || r.stdout.Len() != 0 {
		t.Fatalf("stderr %q stdout %q", r.stderr.String(), r.stdout.String())
	}
}
