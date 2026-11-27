package cmd

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// vmRow is a GET /api/vms row: what the list shows.
type vmRow struct {
	Name           string  `json:"name"`
	State          string  `json:"state"`
	Vcpus          int     `json:"vcpus"`
	MemoryMiB      int     `json:"memoryMiB"`
	Profile        *string `json:"profile"`
	PendingRestart *struct {
		Since string `json:"since"`
	} `json:"pendingRestart"`
	StaleBinary bool `json:"staleBinary"`
}

func runVMsList(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var rows []vmRow
	body, err := client.GetJSON(ctx, "/api/vms", nil, &rows)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	if len(rows) == 0 {
		fmt.Fprintln(c.env.Stdout, "No VMs.")
		return nil
	}
	t := newTable(c.env.Stdout, "NAME", "STATE", "VCPUS", "MEMORY", "PROFILE", "NOTES")
	for _, r := range rows {
		t.row(r.Name, r.State, strconv.Itoa(r.Vcpus), fmt.Sprintf("%d MiB", r.MemoryMiB), orDash(r.Profile), strings.Join(restartNotes(r.PendingRestart != nil, r.StaleBinary), ", "))
	}
	return t.flush()
}

// restartNotes says why a VM waits for a restart, if it does.
func restartNotes(pending, staleBinary bool) []string {
	var notes []string
	if pending {
		notes = append(notes, "restart pending: a saved change waits for it")
	}
	if staleBinary {
		notes = append(notes, "restart pending: QEMU was updated")
	}
	return notes
}

// vmDetail is GET /api/vms/:name, for the text the show prints.
type vmDetail struct {
	vmRow
	Autostart   bool    `json:"autostart"`
	OSType      string  `json:"osType"`
	Arch        *string `json:"arch"`
	MachineType *string `json:"machineType"`
	Firmware    string  `json:"firmware"`
	CPUMode     *string `json:"cpuMode"`
	CPUTopology *struct {
		Sockets int `json:"sockets"`
		Cores   int `json:"cores"`
		Threads int `json:"threads"`
	} `json:"cpuTopology"`
	NestedVirt bool     `json:"nestedVirt"`
	BootOrder  []string `json:"bootOrder"`
	BootMenu   bool     `json:"bootMenu"`
	Disks      []struct {
		Slot    *string `json:"slot"`
		Device  string  `json:"device"`
		Bus     *string `json:"bus"`
		Source  *string `json:"source"`
		SizeGiB *int    `json:"sizeGiB"`
	} `json:"disks"`
	NICs []struct {
		Type   *string `json:"type"`
		MAC    *string `json:"mac"`
		Source *string `json:"source"`
		Model  *string `json:"model"`
	} `json:"nics"`
	GuestAgent   bool     `json:"guestAgent"`
	StartedAt    *float64 `json:"startedAt"` // epoch milliseconds
	GuestNetwork struct {
		IP       *string `json:"ip"`
		Hostname *string `json:"hostname"`
	} `json:"guestNetwork"`
}

func runVMsShow(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var d vmDetail
	body, answeredAt, err := client.GetJSONDated(ctx, "/api/vms/"+url.PathEscape(c.args[0]), nil, &d)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	// The uptime is the host's: startedAt against the host's clock, as its
	// answer's Date says, so a client whose clock is off still prints it right.
	if answeredAt.IsZero() {
		answeredAt = time.Now()
	}
	printVM(c, &d, answeredAt)
	return nil
}

func printVM(c *call, d *vmDetail, now time.Time) {
	w := c.env.Stdout
	l := newLabelled(w)
	l.line("Name", d.Name)
	state := d.State
	if d.StartedAt != nil {
		// Date has whole seconds: a VM started within the second reads as up 0s.
		state += " (up " + durationText(max(0, float64(now.UnixMilli())-*d.StartedAt)) + ")"
	}
	l.line("State", state)
	if d.State == "running" {
		guest := "unknown: the VM has no guest agent"
		if d.GuestAgent {
			guest = "unknown: the guest agent does not answer"
		}
		if d.GuestNetwork.Hostname != nil || d.GuestNetwork.IP != nil {
			guest = ""
		}
		if guest != "" {
			l.line("Guest", guest)
		} else {
			l.line("Guest name", orNone(d.GuestNetwork.Hostname))
			l.line("Guest address", orNone(d.GuestNetwork.IP))
		}
	}
	if d.PendingRestart != nil {
		l.line("Restart", "pending since "+timeText(d.PendingRestart.Since)+": a saved change waits for it")
	}
	if d.StaleBinary {
		l.line("Restart", "pending: QEMU was updated, and a restart moves the VM to the new one")
	}
	l.line("Profile", orNone(d.Profile))
	cpu := fmt.Sprintf("%d vCPUs", d.Vcpus)
	if d.CPUMode != nil {
		cpu += ", " + *d.CPUMode
	}
	if t := d.CPUTopology; t != nil {
		cpu += fmt.Sprintf(" (%d sockets, %d cores, %d threads)", t.Sockets, t.Cores, t.Threads)
	}
	if d.NestedVirt {
		cpu += ", nested virtualization"
	}
	l.line("CPU", cpu)
	l.line("Memory", fmt.Sprintf("%d MiB", d.MemoryMiB))
	l.line("Firmware", d.Firmware)
	machine := orNone(d.MachineType)
	if d.Arch != nil {
		machine += ", " + *d.Arch
	}
	l.line("Machine", machine)
	l.line("Boot order", listOrNone(d.BootOrder))
	l.line("Boot menu", onOff(d.BootMenu))
	l.line("Autostart", onOff(d.Autostart))
	l.line("Guest agent", onOff(d.GuestAgent))
	l.flush()

	fmt.Fprintln(w, "\nDisks:")
	if len(d.Disks) == 0 {
		fmt.Fprintln(w, "  none")
	} else {
		t := newTable(w, "  SLOT", "DEVICE", "BUS", "SIZE", "SOURCE")
		for _, disk := range d.Disks {
			size := "—"
			if disk.SizeGiB != nil {
				size = strconv.Itoa(*disk.SizeGiB) + " GiB"
			}
			source := orDash(disk.Source)
			if disk.Source == nil && disk.Device == "cdrom" {
				source = "empty"
			}
			t.row("  "+orDash(disk.Slot), disk.Device, orDash(disk.Bus), size, source)
		}
		t.flush()
	}

	fmt.Fprintln(w, "\nNetwork cards:")
	if len(d.NICs) == 0 {
		fmt.Fprintln(w, "  none")
		return
	}
	t := newTable(w, "  MAC", "BRIDGE", "MODEL")
	for _, nic := range d.NICs {
		// A card on a libvirt network names the network, not a bridge.
		source := orDash(nic.Source)
		if nic.Type != nil && *nic.Type != "bridge" && nic.Source != nil {
			source = *nic.Type + " " + *nic.Source
		}
		t.row("  "+orDash(nic.MAC), source, orDash(nic.Model))
	}
	t.flush()
}

func vmPath(name, action string) string {
	return "/api/vms/" + url.PathEscape(name) + "/" + action
}

func runVMsStart(ctx context.Context, c *call) error {
	name := c.args[0]
	_, waited, err := runJobRequest(ctx, c, http.MethodPost, vmPath(name, "start"), nil)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Started %s.\n", name)
	return nil
}

// runVMsStop asks the guest to shut down, a job that ends when the VM is off;
// with --force it powers the VM off.
func runVMsStop(ctx context.Context, c *call) error {
	name := c.args[0]
	action := "stop"
	if c.switches["force"] {
		action = "force-stop"
	}
	_, waited, err := runJobRequest(ctx, c, http.MethodPost, vmPath(name, action), nil)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Stopped %s.\n", name)
	return nil
}

// runVMsRestart asks the guest to restart: the Wisp answers at once, as
// nothing tells when a guest is back up.
func runVMsRestart(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	name := c.args[0]
	if _, err := client.Send(ctx, http.MethodPost, vmPath(name, "reboot"), nil); err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Asked the guest of %s to restart.\n", name)
	return nil
}
