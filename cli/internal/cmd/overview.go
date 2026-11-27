package cmd

import (
	"context"
	"fmt"
	"strings"
)

// overview is GET /api/overview, for the text the command prints
// (docs/specs/API-HOST.md).
type overview struct {
	WispVersion string `json:"wispVersion"`
	ServerName  string `json:"serverName"`
	Host        struct {
		Hostname       string  `json:"hostname"`
		Kernel         string  `json:"kernel"`
		PrimaryAddress *string `json:"primaryAddress"`
		UptimeSeconds  float64 `json:"uptimeSeconds"`
		LibvirtVersion *string `json:"libvirtVersion"`
		QemuVersion    *string `json:"qemuVersion"`
	} `json:"host"`
	Bridges     []string `json:"bridges"`
	Certificate *struct {
		Domain     string `json:"domain"`
		ValidUntil string `json:"validUntil"`
	} `json:"certificate"`
	Containers []struct {
		Name            string  `json:"name"`
		State           string  `json:"state"`
		Image           string  `json:"image"`
		UpdateAvailable bool    `json:"updateAvailable"`
		IP              *string `json:"ip"`
		LastKnownIP     *string `json:"lastKnownIp"`
		MDNSName        *string `json:"mdnsName"`
		App             *string `json:"app"`
	} `json:"containers"`
	VMs []struct {
		Name          string  `json:"name"`
		State         string  `json:"state"`
		Vcpus         int     `json:"vcpus"`
		MemoryMiB     int     `json:"memoryMiB"`
		Profile       *string `json:"profile"`
		IP            *string `json:"ip"`
		GuestHostname *string `json:"guestHostname"`
	} `json:"vms"`
}

func runOverview(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var o overview
	body, err := client.GetJSON(ctx, "/api/overview", nil, &o)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	w := c.env.Stdout
	l := newLabelled(w)
	l.line("Wisp", o.WispVersion+", named "+o.ServerName)
	host := []string{o.Host.Hostname}
	if o.Host.PrimaryAddress != nil {
		host = append(host, *o.Host.PrimaryAddress)
	}
	host = append(host, "up "+durationText(o.Host.UptimeSeconds*1000))
	l.line("Host", strings.Join(host, ", "))
	l.line("Kernel", o.Host.Kernel)
	l.line("libvirt", orNone(o.Host.LibvirtVersion))
	l.line("QEMU", orNone(o.Host.QemuVersion))
	l.line("Bridges", listOrNone(o.Bridges))
	if o.Certificate != nil {
		l.line("Certificate", o.Certificate.Domain+", valid until "+timeText(o.Certificate.ValidUntil))
	} else {
		l.line("Certificate", "none")
	}
	l.flush()

	fmt.Fprintln(w, "\nContainers:")
	if len(o.Containers) == 0 {
		fmt.Fprintln(w, "  none")
	} else {
		t := newTable(w, "  NAME", "STATE", "ADDRESS", "MDNS", "IMAGE", "NOTES")
		for _, ct := range o.Containers {
			var notes []string
			// A container that is not running has no address: its last lease may
			// be another machine's by now.
			if ct.IP == nil && ct.LastKnownIP != nil {
				notes = append(notes, "old address "+*ct.LastKnownIP+" (its last lease: another machine may hold it now)")
			}
			if ct.UpdateAvailable {
				notes = append(notes, "image update available")
			}
			if ct.App != nil {
				notes = append(notes, "app "+*ct.App)
			}
			t.row("  "+ct.Name, ct.State, orDash(ct.IP), orDash(ct.MDNSName), ct.Image, strings.Join(notes, ", "))
		}
		t.flush()
	}

	fmt.Fprintln(w, "\nVMs:")
	if len(o.VMs) == 0 {
		fmt.Fprintln(w, "  none")
		return nil
	}
	t := newTable(w, "  NAME", "STATE", "ADDRESS", "GUEST NAME", "VCPUS", "MEMORY", "PROFILE")
	for _, vm := range o.VMs {
		t.row("  "+vm.Name, vm.State, orDash(vm.IP), orDash(vm.GuestHostname), fmt.Sprint(vm.Vcpus), fmt.Sprintf("%d MiB", vm.MemoryMiB), orDash(vm.Profile))
	}
	return t.flush()
}
