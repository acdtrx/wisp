package cmd

import (
	"net/http"
	"strings"
	"testing"
)

const statsBody = `{"cpu":{"allocated":6,"total":16,"usagePercent":34.2,"perCore":[12.5,45,8.3,0]},"cpuTemp":62.5,"cpuTempThresholds":{"maxC":80,"critC":95},` +
	`"thermalZones":[{"type":"x86_pkg_temp","label":"CPU Package","tempC":62.5,"maxC":80,"critC":95,"pciAddress":null},{"type":"nvme nvme0","label":"nvme nvme0","tempC":41,"maxC":null,"critC":null,"pciAddress":"0000:01:00.0"}],` +
	`"cpuPowerWatts":45.2,"memory":{"allocatedGB":12,"totalGB":64,"usagePercent":28.1,"usedBytes":19327352832,"buffersBytes":104857600,"cachedBytes":8589934592,"swapTotalBytes":4294967296,"swapUsedBytes":1048576},` +
	`"loadAvg":[1.2,0.8,0.6],"disk":{"readMBs":1.2,"writeMBs":0.4},"net":{"rxMBs":2.1,"txMBs":0.8},"runningVMs":3,"runningContainers":2,"pendingUpdates":4,"updatesLastChecked":"2026-11-27T12:00:00.000Z",` +
	`"updateOperationInProgress":false,"rebootRequired":true,"rebootReasons":["linux-image-6.8.0-50-generic"],"certificateFailed":false,"wispUpdate":{"current":"1.0.0","latest":"1.0.1","available":true,"lastChecked":"2026-11-27T11:00:00.000Z"}}`

const statsSparseBody = `{"cpu":{"allocated":null,"total":4,"usagePercent":0,"perCore":[]},"cpuTemp":null,"cpuTempThresholds":null,"thermalZones":[],"cpuPowerWatts":null,` +
	`"memory":{"allocatedGB":null,"totalGB":8,"usagePercent":50,"usedBytes":0,"buffersBytes":0,"cachedBytes":0,"swapTotalBytes":0,"swapUsedBytes":0},"loadAvg":null,` +
	`"disk":{"readMBs":0,"writeMBs":0},"net":{"rxMBs":0,"txMBs":0},"runningVMs":null,"runningContainers":null,"pendingUpdates":0,"updatesLastChecked":null,` +
	`"updateOperationInProgress":false,"rebootRequired":false,"rebootReasons":[],"certificateFailed":false,"wispUpdate":{"current":"1.0.0","latest":null,"available":false,"lastChecked":null}}`

const hardwareBody = `{"cpu":{"model":"Intel(R) Core(TM) i5-12500H","cores":12,"threads":16,"mhz":2500,"cacheKb":18432,"coreTypes":{"performance":[0,1,2,3],"efficiency":[8,9,10,11]}},` +
	`"disks":[{"name":"nvme0n1","model":"Samsung SSD 980","sizeBytes":1000204886016,"rotational":false,"pciAddress":"0000:01:00.0","smart":{"supported":true,"overall":"healthy","temperatureC":41,"powerOnHours":2387,"criticalWarning":null,"percentageUsed":2,"availableSpare":100,"availableSpareThreshold":10,"reallocatedSectors":null,"pendingSectors":null,"offlineUncorrectableSectors":null,"ssdLifePercentRemaining":null,"lastUpdated":"2026-11-27T12:00:00.000Z","error":null}},` +
	`{"name":"sda","model":"WDC WD40","sizeBytes":4000787030016,"rotational":true,"pciAddress":null,"smart":{"supported":true,"overall":"sleeping","temperatureC":null,"powerOnHours":null,"criticalWarning":null,"percentageUsed":null,"availableSpare":null,"availableSpareThreshold":null,"reallocatedSectors":null,"pendingSectors":null,"offlineUncorrectableSectors":null,"ssdLifePercentRemaining":null,"lastUpdated":"2026-11-27T12:00:00.000Z","error":null}}],` +
	`"filesystems":[],"network":[],"memory":[{"type":"DDR5","sizeBytes":17179869184,"speedMts":4800,"slot":"Controller0-ChannelA","formFactor":"SODIMM","manufacturer":"Samsung","voltage":"1.1 V"}],"memoryError":null,` +
	`"pciDevices":[{"address":"0000:00:02.0","classId":"0300","classCode":"030000","className":"VGA compatible controller","vendor":"Intel Corporation","vendorId":"8086","device":"Alder Lake-P GT2 [Iris Xe Graphics]","deviceId":"46a6","driver":"i915"},` +
	`{"address":"0000:01:00.0","classId":"0108","classCode":"010802","className":"Non-Volatile memory controller","vendor":"Samsung Electronics Co Ltd","vendorId":"144d","device":"NVMe SSD Controller 980","deviceId":"a809","driver":"nvme"}],` +
	`"system":{"boardVendor":"Intel Corporation","boardName":"NUC12WSBi5","boardVersion":"M46425-302","systemVendor":"Intel(R) Client Systems","systemProduct":"NUC12WSHi5","systemVersion":null,"biosVendor":"Intel Corp.","biosVersion":"WSADL357.0088","biosDate":"10/05/2023"}}`

const hardwareSparseBody = `{"cpu":null,"disks":[],"filesystems":[],"network":[],"memory":null,"memoryError":"wisp-dmidecode: dmidecode failed","pciDevices":[],"system":null}`

func TestHostStatsPrintsTheFiguresAndEnds(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/host/stats"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(statsBody)) }
	r.do("host", "stats").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"CPU:", "34.2% of 16 cores", "6 vCPUs given to running VMs"},
		{"Per core:", "12.5% 45% 8.3% 0%"},
		{"Load:", "1.20 0.80 0.60"},
		{"CPU temperature:", "62.5 °C", "high 80 °C", "critical 95 °C"},
		{"CPU power:", "45.2 W"},
		{"Memory:", "28.1% of 64 GB used", "12 GB given to running VMs"},
		{"Swap:", "1.0 MiB of 4.0 GiB used"},
		{"Disks:", "read 1.2 MB/s, write 0.4 MB/s"},
		{"Network:", "in 2.1 MB/s, out 0.8 MB/s"},
		{"Running VMs:", "3"},
		{"Running containers:", "2"},
		{"OS updates:", "4 pending", "checked"},
		{"Reboot:", "required", "linux-image-6.8.0-50-generic"},
		{"Wisp:", "1.0.0, 1.0.1 available"},
		{"nvme nvme0", "41 °C", "—"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q", want)
		}
	}
	if t.Failed() {
		t.Log(out)
	}
	if f.requestCount() != 1 {
		t.Errorf("%d requests: a sample is one read", f.requestCount())
	}
	r.do("host", "stats", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != statsBody {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

// sectionHeadings are the lines that head a list, and hold no value.
var sectionHeadings = map[string]bool{"Sensors": true, "Memory modules": true, "Disks": true, "GPUs": true, "PCI devices": true}

// noBlankOrZero fails on a labelled line with no value, or a zero where the
// API sent none.
func noBlankOrZero(t *testing.T, out string, zeroLabels ...string) {
	t.Helper()
	for _, l := range strings.Split(out, "\n") {
		label, value, found := strings.Cut(l, ":")
		if found && !strings.HasPrefix(l, " ") && strings.TrimSpace(value) == "" && !sectionHeadings[label] {
			t.Errorf("a blank line: %q", l)
		}
		for _, z := range zeroLabels {
			if label == z && (strings.TrimSpace(value) == "0" || strings.HasPrefix(strings.TrimSpace(value), "0 ")) {
				t.Errorf("a zero for none: %q", l)
			}
		}
	}
}

func TestAFigureTheHostHasNoneOfReadsAsNone(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/host/stats"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(statsSparseBody)) }
	r.do("host", "stats").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"CPU temperature:", "none"}, {"CPU power:", "none"}, {"Swap:", "none"}, {"Load:", "none"},
		{"Running VMs:", "unknown: libvirt does not answer"}, {"Running containers:", "unknown: containerd does not answer"},
		{"OS updates:", "none pending", "not checked"}, {"Reboot:", "not required"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q", want)
		}
	}
	if !strings.Contains(out, "Sensors:\n  none\n") || strings.Contains(out, "Per core") || strings.Contains(out, "given to running VMs") {
		t.Errorf("sparse:\n%s", out)
	}
	noBlankOrZero(t, out, "Running VMs", "Running containers", "CPU power", "CPU temperature", "Swap")
}

func TestHostHardwarePrintsEachPart(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/host/hardware"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(hardwareBody)) }
	r.do("host", "hardware").wantCode(0)
	out := r.stdout.String()
	for _, want := range [][]string{
		{"CPU:", "i5-12500H", "12 cores, 16 threads", "2500 MHz", "18432 KB cache"},
		{"Core types:", "performance 0,1,2,3", "efficiency 8,9,10,11"},
		{"Board:", "Intel Corporation NUC12WSBi5 M46425-302"},
		{"System:", "Intel(R) Client Systems NUC12WSHi5"},
		{"BIOS:", "WSADL357.0088"},
		{"Controller0-ChannelA", "DDR5", "16.0 GiB", "4800 MT/s", "SODIMM", "Samsung"},
		{"nvme0n1", "Samsung SSD 980", "931.5 GiB", "SSD", "healthy", "41 °C", "2387 h"},
		{"sda", "HDD", "sleeping"},
		{"0000:01:00.0", "Non-Volatile memory controller", "nvme"},
	} {
		if line(out, want...) == "" {
			t.Errorf("no line holds %q", want)
		}
	}
	gpus := out[strings.Index(out, "GPUs:"):strings.Index(out, "PCI devices:")]
	if !strings.Contains(gpus, "Iris Xe Graphics") || strings.Contains(gpus, "NVMe") {
		t.Errorf("GPUs:\n%s", gpus)
	}
	if t.Failed() {
		t.Log(out)
	}
	r.do("host", "hardware", "--json").wantCode(0)
	if strings.TrimSpace(r.stdout.String()) != hardwareBody {
		t.Fatal("--json is not the API's answer unchanged")
	}
}

func TestAPartTheHostHasNoneOfReadsAsNone(t *testing.T) {
	f, r := readWisp(t)
	f.routes["GET /api/host/hardware"] = func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(hardwareSparseBody)) }
	r.do("host", "hardware").wantCode(0)
	out := r.stdout.String()
	if line(out, "CPU:", "none") == "" || line(out, "Board:", "none") == "" {
		t.Errorf("no CPU or board:\n%s", out)
	}
	for _, want := range []string{"Memory modules:\n  unknown: wisp-dmidecode: dmidecode failed\n", "Disks:\n  none\n", "GPUs:\n  none\n", "PCI devices:\n  none\n"} {
		if !strings.Contains(out, want) {
			t.Errorf("lacks %q", want)
		}
	}
	if t.Failed() {
		t.Log(out)
	}
	noBlankOrZero(t, out)
}
