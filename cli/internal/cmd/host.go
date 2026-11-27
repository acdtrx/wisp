package cmd

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// hostStats is GET /api/host/stats, the `stats` topic's payload
// (docs/specs/API.md), for the text the command prints.
type hostStats struct {
	CPU struct {
		Allocated    *float64  `json:"allocated"`
		Total        float64   `json:"total"`
		UsagePercent float64   `json:"usagePercent"`
		PerCore      []float64 `json:"perCore"`
	} `json:"cpu"`
	CPUTemp           *float64 `json:"cpuTemp"`
	CPUTempThresholds *struct {
		MaxC  *float64 `json:"maxC"`
		CritC *float64 `json:"critC"`
	} `json:"cpuTempThresholds"`
	ThermalZones []struct {
		Label string   `json:"label"`
		TempC *float64 `json:"tempC"`
		MaxC  *float64 `json:"maxC"`
		CritC *float64 `json:"critC"`
	} `json:"thermalZones"`
	CPUPowerWatts *float64 `json:"cpuPowerWatts"`
	Memory        struct {
		AllocatedGB    *float64 `json:"allocatedGB"`
		TotalGB        float64  `json:"totalGB"`
		UsagePercent   float64  `json:"usagePercent"`
		UsedBytes      float64  `json:"usedBytes"`
		BuffersBytes   float64  `json:"buffersBytes"`
		CachedBytes    float64  `json:"cachedBytes"`
		SwapTotalBytes float64  `json:"swapTotalBytes"`
		SwapUsedBytes  float64  `json:"swapUsedBytes"`
	} `json:"memory"`
	LoadAvg []float64 `json:"loadAvg"`
	Disk    struct {
		ReadMBs  float64 `json:"readMBs"`
		WriteMBs float64 `json:"writeMBs"`
	} `json:"disk"`
	Net struct {
		RxMBs float64 `json:"rxMBs"`
		TxMBs float64 `json:"txMBs"`
	} `json:"net"`
	RunningVMs                *int     `json:"runningVMs"`
	RunningContainers         *int     `json:"runningContainers"`
	PendingUpdates            int      `json:"pendingUpdates"`
	UpdatesLastChecked        *string  `json:"updatesLastChecked"`
	UpdateOperationInProgress bool     `json:"updateOperationInProgress"`
	RebootRequired            bool     `json:"rebootRequired"`
	RebootReasons             []string `json:"rebootReasons"`
	CertificateFailed         bool     `json:"certificateFailed"`
	WispUpdate                struct {
		Current     string  `json:"current"`
		Latest      *string `json:"latest"`
		Available   bool    `json:"available"`
		LastChecked *string `json:"lastChecked"`
	} `json:"wispUpdate"`
}

// number is a figure as the API rounds it, with no trailing zeros.
func number(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// temperature is a reading in °C, or "none".
func temperature(c *float64) string {
	if c == nil {
		return "none"
	}
	return number(*c) + " °C"
}

func runHostStats(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var s hostStats
	body, err := client.GetJSON(ctx, "/api/host/stats", nil, &s)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	w := c.env.Stdout
	l := newLabelled(w)
	cpu := fmt.Sprintf("%s%% of %s cores", number(s.CPU.UsagePercent), number(s.CPU.Total))
	if s.CPU.Allocated != nil {
		cpu += fmt.Sprintf(", %s vCPUs given to running VMs", number(*s.CPU.Allocated))
	}
	l.line("CPU", cpu)
	if len(s.CPU.PerCore) > 0 {
		cores := make([]string, len(s.CPU.PerCore))
		for i, p := range s.CPU.PerCore {
			cores[i] = number(p) + "%"
		}
		l.line("Per core", strings.Join(cores, " "))
	}
	if len(s.LoadAvg) == 3 {
		l.line("Load", fmt.Sprintf("%.2f %.2f %.2f (1, 5, 15 min)", s.LoadAvg[0], s.LoadAvg[1], s.LoadAvg[2]))
	} else {
		l.line("Load", "none")
	}
	temp := temperature(s.CPUTemp)
	if t := s.CPUTempThresholds; s.CPUTemp != nil && t != nil {
		var limits []string
		if t.MaxC != nil {
			limits = append(limits, "high "+temperature(t.MaxC))
		}
		if t.CritC != nil {
			limits = append(limits, "critical "+temperature(t.CritC))
		}
		if len(limits) > 0 {
			temp += " (" + strings.Join(limits, ", ") + ")"
		}
	}
	l.line("CPU temperature", temp)
	if s.CPUPowerWatts != nil {
		l.line("CPU power", number(*s.CPUPowerWatts)+" W")
	} else {
		l.line("CPU power", "none")
	}
	mem := fmt.Sprintf("%s%% of %s GB used (%s used, %s buffers, %s cache)", number(s.Memory.UsagePercent), number(s.Memory.TotalGB),
		bytesText(s.Memory.UsedBytes), bytesText(s.Memory.BuffersBytes), bytesText(s.Memory.CachedBytes))
	if s.Memory.AllocatedGB != nil {
		mem += ", " + number(*s.Memory.AllocatedGB) + " GB given to running VMs"
	}
	l.line("Memory", mem)
	if s.Memory.SwapTotalBytes > 0 {
		l.line("Swap", bytesText(s.Memory.SwapUsedBytes)+" of "+bytesText(s.Memory.SwapTotalBytes)+" used")
	} else {
		l.line("Swap", "none")
	}
	l.line("Disks", fmt.Sprintf("read %s MB/s, write %s MB/s", number(s.Disk.ReadMBs), number(s.Disk.WriteMBs)))
	l.line("Network", fmt.Sprintf("in %s MB/s, out %s MB/s", number(s.Net.RxMBs), number(s.Net.TxMBs)))
	l.line("Running VMs", countOrUnknown(s.RunningVMs, "libvirt"))
	l.line("Running containers", countOrUnknown(s.RunningContainers, "containerd"))
	updates := "none pending"
	if s.PendingUpdates > 0 {
		updates = fmt.Sprintf("%d pending", s.PendingUpdates)
	}
	if s.UpdatesLastChecked != nil {
		updates += ", checked " + timeText(*s.UpdatesLastChecked)
	} else {
		updates += ", not checked since Wisp started"
	}
	if s.UpdateOperationInProgress {
		updates += "; a check or an upgrade runs"
	}
	l.line("OS updates", updates)
	if s.RebootRequired {
		reboot := "required"
		if len(s.RebootReasons) > 0 {
			reboot += ", by " + strings.Join(s.RebootReasons, ", ")
		}
		l.line("Reboot", reboot)
	} else {
		l.line("Reboot", "not required")
	}
	if s.CertificateFailed {
		l.line("Certificate", "the last attempt to get or renew it failed")
	}
	wisp := s.WispUpdate.Current
	switch {
	case s.WispUpdate.Available && s.WispUpdate.Latest != nil:
		wisp += ", " + *s.WispUpdate.Latest + " available"
	case s.WispUpdate.LastChecked == nil:
		wisp += ", not checked for an update yet"
	default:
		wisp += ", the latest"
	}
	l.line("Wisp", wisp)
	l.flush()

	fmt.Fprintln(w, "\nSensors:")
	if len(s.ThermalZones) == 0 {
		fmt.Fprintln(w, "  none")
		return nil
	}
	t := newTable(w, "  SENSOR", "TEMPERATURE", "HIGH", "CRITICAL")
	for _, z := range s.ThermalZones {
		t.row("  "+z.Label, temperature(z.TempC), dashIfNone(temperature(z.MaxC)), dashIfNone(temperature(z.CritC)))
	}
	return t.flush()
}

// countOrUnknown is a count of workloads, or why there is none: the list
// could not be read.
func countOrUnknown(n *int, from string) string {
	if n == nil {
		return "unknown: " + from + " does not answer"
	}
	return strconv.Itoa(*n)
}

func dashIfNone(s string) string {
	if s == "none" {
		return "—"
	}
	return s
}

// hostHardware is GET /api/host/hardware, for the text the command prints
// (docs/specs/API-HOST.md).
type hostHardware struct {
	CPU *struct {
		Model     string   `json:"model"`
		Cores     float64  `json:"cores"`
		Threads   float64  `json:"threads"`
		MHz       *float64 `json:"mhz"`
		CacheKb   *float64 `json:"cacheKb"`
		CoreTypes *struct {
			Performance []int `json:"performance"`
			Efficiency  []int `json:"efficiency"`
		} `json:"coreTypes"`
	} `json:"cpu"`
	Disks []struct {
		Name       string  `json:"name"`
		Model      string  `json:"model"`
		SizeBytes  float64 `json:"sizeBytes"`
		Rotational *bool   `json:"rotational"`
		Smart      *struct {
			Supported    bool     `json:"supported"`
			Overall      string   `json:"overall"`
			TemperatureC *float64 `json:"temperatureC"`
			PowerOnHours *float64 `json:"powerOnHours"`
			Error        *string  `json:"error"`
		} `json:"smart"`
	} `json:"disks"`
	Memory []struct {
		Type         string   `json:"type"`
		SizeBytes    float64  `json:"sizeBytes"`
		SpeedMts     *float64 `json:"speedMts"`
		Slot         string   `json:"slot"`
		FormFactor   *string  `json:"formFactor"`
		Manufacturer *string  `json:"manufacturer"`
	} `json:"memory"`
	MemoryError *string `json:"memoryError"`
	PCIDevices  []struct {
		Address   string  `json:"address"`
		ClassID   string  `json:"classId"`
		ClassName string  `json:"className"`
		Vendor    string  `json:"vendor"`
		Device    string  `json:"device"`
		Driver    *string `json:"driver"`
	} `json:"pciDevices"`
	System *struct {
		BoardVendor   *string `json:"boardVendor"`
		BoardName     *string `json:"boardName"`
		BoardVersion  *string `json:"boardVersion"`
		SystemVendor  *string `json:"systemVendor"`
		SystemProduct *string `json:"systemProduct"`
		SystemVersion *string `json:"systemVersion"`
		BIOSVendor    *string `json:"biosVendor"`
		BIOSVersion   *string `json:"biosVersion"`
		BIOSDate      *string `json:"biosDate"`
	} `json:"system"`
}

// joined is the parts the API gave, or "none" when it gave none.
func joined(parts ...*string) string {
	var given []string
	for _, p := range parts {
		if p != nil && strings.TrimSpace(*p) != "" {
			given = append(given, strings.TrimSpace(*p))
		}
	}
	if len(given) == 0 {
		return "none"
	}
	return strings.Join(given, " ")
}

// cpuList is a list of logical CPU ids.
func cpuList(ids []int) string {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = strconv.Itoa(id)
	}
	return strings.Join(s, ",")
}

func runHostHardware(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var h hostHardware
	body, err := client.GetJSON(ctx, "/api/host/hardware", nil, &h)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	w := c.env.Stdout
	l := newLabelled(w)
	if h.CPU == nil {
		l.line("CPU", "none")
	} else {
		cpu := fmt.Sprintf("%s, %s cores, %s threads", h.CPU.Model, number(h.CPU.Cores), number(h.CPU.Threads))
		if h.CPU.MHz != nil {
			cpu += ", " + number(*h.CPU.MHz) + " MHz"
		}
		if h.CPU.CacheKb != nil {
			cpu += ", " + number(*h.CPU.CacheKb) + " KB cache"
		}
		l.line("CPU", cpu)
		if ct := h.CPU.CoreTypes; ct != nil {
			l.line("Core types", "performance "+cpuList(ct.Performance)+"; efficiency "+cpuList(ct.Efficiency))
		}
	}
	if s := h.System; s != nil {
		l.line("Board", joined(s.BoardVendor, s.BoardName, s.BoardVersion))
		l.line("System", joined(s.SystemVendor, s.SystemProduct, s.SystemVersion))
		l.line("BIOS", joined(s.BIOSVendor, s.BIOSVersion, s.BIOSDate))
	} else {
		l.line("Board", "none")
	}
	l.flush()

	fmt.Fprintln(w, "\nMemory modules:")
	switch {
	case h.Memory == nil:
		fmt.Fprintf(w, "  unknown: %s\n", orNone(h.MemoryError))
	case len(h.Memory) == 0:
		fmt.Fprintln(w, "  none")
	default:
		t := newTable(w, "  SLOT", "TYPE", "SIZE", "SPEED", "FORM", "MANUFACTURER")
		for _, m := range h.Memory {
			speed := "—"
			if m.SpeedMts != nil {
				speed = number(*m.SpeedMts) + " MT/s"
			}
			t.row("  "+m.Slot, m.Type, bytesText(m.SizeBytes), speed, orDash(m.FormFactor), orDash(m.Manufacturer))
		}
		t.flush()
	}

	fmt.Fprintln(w, "\nDisks:")
	if len(h.Disks) == 0 {
		fmt.Fprintln(w, "  none")
	} else {
		t := newTable(w, "  NAME", "MODEL", "SIZE", "KIND", "HEALTH", "TEMPERATURE", "POWER-ON")
		for _, d := range h.Disks {
			kind := "—"
			switch {
			case d.Rotational == nil:
			case *d.Rotational:
				kind = "HDD"
			default:
				kind = "SSD"
			}
			health, temp, hours := "unknown", "—", "—"
			if sm := d.Smart; sm != nil {
				health = sm.Overall
				if sm.Error != nil && *sm.Error != "" {
					health += " (" + *sm.Error + ")"
				}
				temp = dashIfNone(temperature(sm.TemperatureC))
				if sm.PowerOnHours != nil {
					hours = number(*sm.PowerOnHours) + " h"
				}
			}
			t.row("  "+d.Name, d.Model, bytesText(d.SizeBytes), kind, health, temp, hours)
		}
		t.flush()
	}

	// The host's GPUs are its PCI display controllers (class 03).
	var gpus []int
	for i, p := range h.PCIDevices {
		if strings.HasPrefix(p.ClassID, "03") {
			gpus = append(gpus, i)
		}
	}
	fmt.Fprintln(w, "\nGPUs:")
	if len(gpus) == 0 {
		fmt.Fprintln(w, "  none")
	} else {
		t := newTable(w, "  ADDRESS", "VENDOR", "DEVICE", "DRIVER")
		for _, i := range gpus {
			p := h.PCIDevices[i]
			t.row("  "+p.Address, p.Vendor, p.Device, orDash(p.Driver))
		}
		t.flush()
	}

	fmt.Fprintln(w, "\nPCI devices:")
	if len(h.PCIDevices) == 0 {
		fmt.Fprintln(w, "  none")
		return nil
	}
	t := newTable(w, "  ADDRESS", "CLASS", "VENDOR", "DEVICE", "DRIVER")
	for _, p := range h.PCIDevices {
		t.row("  "+p.Address, p.ClassName, p.Vendor, p.Device, orDash(p.Driver))
	}
	return t.flush()
}
