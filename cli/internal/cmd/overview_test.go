package cmd

import (
	"net/http"
	"strings"
	"testing"
)

const overviewBody = `{"wispVersion":"1.0.0","serverName":"Lab","host":{"hostname":"lab","kernel":"6.8.0-49-generic","primaryAddress":"192.168.1.5","uptimeSeconds":90061,"libvirtVersion":"10.0.0","qemuVersion":"8.2.2"},
"bridges":["br0","br0-vlan22"],"sections":[],"certificate":{"domain":"lab.example.com","validUntil":"2027-02-01T00:00:00.000Z"},
"containers":[{"name":"web","state":"running","image":"docker.io/library/nginx:1.27","updateAvailable":true,"ip":"192.168.1.20","bridge":"br0","mdnsName":"web.local","app":null,"autostart":true,"autoBackup":false,"restartPolicy":"unless-stopped"},
{"name":"worker","state":"stopped","image":"localhost/worker:v3","updateAvailable":false,"ip":null,"lastKnownIp":"192.168.1.21","bridge":"br0","mdnsName":null,"app":null,"autostart":false,"autoBackup":false,"restartPolicy":"never"}],
"vms":[{"name":"ubuntu","state":"running","vcpus":4,"memoryMiB":4096,"profile":"linux","ip":"192.168.1.10","guestHostname":"ubuntu-guest"},
{"name":"old","state":"shutoff","vcpus":2,"memoryMiB":2048,"profile":null,"ip":null,"guestHostname":null}]}`

// line is the line of out that holds every one of want, or "".
func line(out string, want ...string) string {
	for _, l := range strings.Split(out, "\n") {
		found := true
		for _, w := range want {
			found = found && strings.Contains(l, w)
		}
		if found {
			return l
		}
	}
	return ""
}

func TestOverviewPrintsTheHostThenEveryWorkloadWithItsAddress(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/overview"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(overviewBody)) }
	r.do("overview").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"Wisp:", "1.0.0", "Lab"},
		{"Host:", "lab", "192.168.1.5", "up 25h1m0s"},
		{"Bridges:", "br0, br0-vlan22"},
		{"Certificate:", "lab.example.com", "valid until"},
		{"web", "running", "192.168.1.20", "web.local", "nginx:1.27", "image update available"},
		{"ubuntu", "running", "192.168.1.10", "ubuntu-guest", "4", "4096 MiB", "linux"},
		{"old", "shutoff", "—", "2048 MiB"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q", want)
		}
	}
	if strings.Index(out, "Containers:") > strings.Index(out, "VMs:") || strings.Index(out, "Certificate:") > strings.Index(out, "Containers:") {
		t.Error("not the host, then the containers, then the VMs")
	}
	// A stopped container's last lease is marked old, and is never its address.
	worker := line(out, "worker")
	if !strings.Contains(worker, "old address 192.168.1.21") || strings.Contains(strings.Replace(worker, "old address 192.168.1.21", "", 1), "192.168.1.21") {
		t.Errorf("worker: %q", worker)
	}
	if t.Failed() {
		t.Log(out)
	}

	r.do("overview", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != overviewBody {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestAnOverviewWithNothingSaysNone(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/overview"] = func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"wispVersion":"1.0.0","serverName":"My Server","host":{"hostname":"dev","kernel":"25.6.0","primaryAddress":null,"uptimeSeconds":12,"libvirtVersion":null,"qemuVersion":null},"bridges":[],"sections":[],"certificate":null,"containers":[],"vms":[]}`))
	}
	r.do("overview").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{{"Certificate:", "none"}, {"Bridges:", "none"}, {"libvirt:", "none"}} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "Containers:\n  none\n") || !strings.Contains(out, "VMs:\n  none\n") {
		t.Errorf("no workloads:\n%s", out)
	}
}

func TestHelpNamesOverviewAsWhereToStart(t *testing.T) {
	r := newRun(t).do("help").wantCode(0)
	if !strings.Contains(r.stdout.String(), `Start with "wisp overview"`) {
		t.Fatalf("help:\n%s", r.stdout.String())
	}
}
