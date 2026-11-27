package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// containerRow is a GET /api/containers row: what the list shows.
type containerRow struct {
	Name             string `json:"name"`
	Image            string `json:"image"`
	State            string `json:"state"`
	UpdateAvailable  bool   `json:"updateAvailable"`
	ScheduledRestart *struct {
		Attempt int     `json:"attempt"`
		At      float64 `json:"at"`
	} `json:"scheduledRestart"`
	PendingRestart *struct {
		Since string `json:"since"`
	} `json:"pendingRestart"`
}

func runContainersList(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var rows []containerRow
	body, err := client.GetJSON(ctx, "/api/containers", nil, &rows)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	if len(rows) == 0 {
		fmt.Fprintln(c.env.Stdout, "No containers.")
		return nil
	}
	t := newTable(c.env.Stdout, "NAME", "STATE", "IMAGE", "NOTES")
	for _, r := range rows {
		var notes []string
		if r.UpdateAvailable {
			notes = append(notes, "image update available")
		}
		if r.PendingRestart != nil {
			notes = append(notes, "restart pending")
		}
		if r.ScheduledRestart != nil {
			notes = append(notes, fmt.Sprintf("restart %d at %s", r.ScheduledRestart.Attempt, epochText(r.ScheduledRestart.At)))
		}
		t.row(r.Name, r.State, r.Image, strings.Join(notes, ", "))
	}
	return t.flush()
}

// containerDetail is GET /api/containers/:name, for the text the show prints.
type containerDetail struct {
	containerRow
	Command        []string `json:"command"`
	CPULimit       *float64 `json:"cpuLimit"`
	MemoryLimitMiB *float64 `json:"memoryLimitMiB"`
	RestartPolicy  string   `json:"restartPolicy"`
	Autostart      bool     `json:"autostart"`
	AutoBackup     bool     `json:"autoBackup"`
	RunAsRoot      bool     `json:"runAsRoot"`
	LocalDNS       bool     `json:"localDns"`
	CreatedAt      string   `json:"createdAt"`
	ImageDigest    string   `json:"imageDigest"`
	ImagePulledAt  string   `json:"imagePulledAt"`
	PID            *int     `json:"pid"`
	Uptime         *float64 `json:"uptime"` // milliseconds
	MDNSHostname   *string  `json:"mdnsHostname"`
	Env            map[string]struct {
		Value  *string `json:"value"`
		Secret bool    `json:"secret"`
		IsSet  bool    `json:"isSet"`
	} `json:"env"`
	Mounts []struct {
		Type          string   `json:"type"`
		Name          string   `json:"name"`
		ContainerPath string   `json:"containerPath"`
		Readonly      bool     `json:"readonly"`
		SourceID      *string  `json:"sourceId"`
		SubPath       string   `json:"subPath"`
		SizeMiB       *int     `json:"sizeMiB"`
		Secret        bool     `json:"secret"`
		IsSet         bool     `json:"isSet"`
		SizeBytes     *float64 `json:"sizeBytes"`
	} `json:"mounts"`
	Devices []struct {
		Type   string `json:"type"`
		Device string `json:"device"`
	} `json:"devices"`
	Services []struct {
		Port int               `json:"port"`
		Type string            `json:"type"`
		TXT  map[string]string `json:"txt"`
	} `json:"services"`
	Network *struct {
		Type      string  `json:"type"`
		MAC       string  `json:"mac"`
		Interface *string `json:"interface"`
		IP        string  `json:"ip"`
		IP6       string  `json:"ip6"`
	} `json:"network"`
	Metadata *struct {
		App       string          `json:"app"`
		AppConfig json.RawMessage `json:"appConfig"`
	} `json:"metadata"`
}

// containerPath is the API path of a container's route, each segment escaped:
// a name the user gives (the container's, a mount's) may hold any character.
func containerPath(name string, rest ...string) string {
	segments := append([]string{name}, rest...)
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	return "/api/containers/" + strings.Join(segments, "/")
}

func runContainersShow(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var d containerDetail
	body, err := client.GetJSON(ctx, containerPath(c.args[0]), nil, &d)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	printContainer(c, &d)
	return nil
}

func printContainer(c *call, d *containerDetail) {
	w := c.env.Stdout
	l := newLabelled(w)
	l.line("Name", d.Name)
	state := d.State
	var running []string
	if d.PID != nil {
		running = append(running, "pid "+strconv.Itoa(*d.PID))
	}
	if d.Uptime != nil {
		running = append(running, "up "+durationText(*d.Uptime))
	}
	if len(running) > 0 {
		state += " (" + strings.Join(running, ", ") + ")"
	}
	l.line("State", state)
	if d.PendingRestart != nil {
		l.line("Restart", "pending since "+timeText(d.PendingRestart.Since)+": a change waits for the next start")
	}
	if d.ScheduledRestart != nil {
		l.line("Restart", fmt.Sprintf("attempt %d at %s, by the restart policy", d.ScheduledRestart.Attempt, epochText(d.ScheduledRestart.At)))
	}
	l.line("Image", d.Image)
	if d.ImageDigest != "" {
		l.line("Image digest", d.ImageDigest)
	}
	if d.ImagePulledAt != "" {
		l.line("Image pulled", timeText(d.ImagePulledAt))
	}
	if d.UpdateAvailable {
		l.line("Image update", "available")
	}
	if d.Command == nil {
		l.line("Command", "the image's own")
	} else {
		l.line("Command", shellWords(d.Command))
	}
	if d.CPULimit != nil {
		l.line("CPU limit", strconv.FormatFloat(*d.CPULimit, 'f', -1, 64)+" cores")
	} else {
		l.line("CPU limit", "none")
	}
	if d.MemoryLimitMiB != nil {
		l.line("Memory limit", strconv.FormatFloat(*d.MemoryLimitMiB, 'f', -1, 64)+" MiB")
	} else {
		l.line("Memory limit", "none")
	}
	l.line("Restart policy", d.RestartPolicy)
	l.line("Autostart", onOff(d.Autostart))
	l.line("Auto backup", onOff(d.AutoBackup))
	l.line("Run as root", onOff(d.RunAsRoot))
	dns := onOff(d.LocalDNS)
	if d.MDNSHostname != nil && *d.MDNSHostname != "" {
		dns += " (" + *d.MDNSHostname + ")"
	}
	l.line("Local DNS", dns)
	if n := d.Network; n != nil {
		var parts []string
		if n.Interface != nil && *n.Interface != "" {
			parts = append(parts, "bridge "+*n.Interface)
		}
		for _, p := range []string{n.IP, n.IP6} {
			if p != "" {
				parts = append(parts, p)
			}
		}
		if n.MAC != "" {
			parts = append(parts, "mac "+n.MAC)
		}
		l.line("Network", strings.Join(parts, ", "))
	}
	if d.Metadata != nil && d.Metadata.App != "" {
		l.line("App", d.Metadata.App)
	}
	if d.CreatedAt != "" {
		l.line("Created", timeText(d.CreatedAt))
	}
	l.flush()

	fmt.Fprintln(w, "\nEnv:")
	if len(d.Env) == 0 {
		fmt.Fprintln(w, "  none")
	}
	keys := make([]string, 0, len(d.Env))
	for k := range d.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		e := d.Env[k]
		switch {
		case e.Secret && e.IsSet:
			fmt.Fprintf(w, "  %s=(secret, set)\n", k)
		case e.Secret:
			fmt.Fprintf(w, "  %s=(secret, not set)\n", k)
		case e.Value != nil:
			fmt.Fprintf(w, "  %s=%s\n", k, *e.Value)
		default:
			fmt.Fprintf(w, "  %s=\n", k)
		}
	}

	fmt.Fprintln(w, "\nMounts:")
	if len(d.Mounts) == 0 {
		fmt.Fprintln(w, "  none")
	} else {
		t := newTable(w, "  NAME", "KIND", "PATH", "NOTES")
		for _, m := range d.Mounts {
			var notes []string
			if m.Readonly {
				notes = append(notes, "read-only")
			}
			if m.SourceID != nil && *m.SourceID != "" {
				notes = append(notes, "on storage "+*m.SourceID+"/"+strings.TrimPrefix(m.SubPath, "/"))
			}
			if m.SizeMiB != nil {
				notes = append(notes, strconv.Itoa(*m.SizeMiB)+" MiB")
			}
			if m.Secret {
				if m.IsSet {
					notes = append(notes, "secret, set")
				} else {
					notes = append(notes, "secret, not set")
				}
			}
			if m.SizeBytes != nil {
				notes = append(notes, bytesText(*m.SizeBytes))
			}
			t.row("  "+m.Name, m.Type, m.ContainerPath, strings.Join(notes, ", "))
		}
		t.flush()
	}

	if len(d.Devices) > 0 {
		fmt.Fprintln(w, "\nDevices:")
		for _, dev := range d.Devices {
			fmt.Fprintf(w, "  %s %s\n", dev.Type, dev.Device)
		}
	}
	if len(d.Services) > 0 {
		fmt.Fprintln(w, "\nmDNS services:")
		for _, s := range d.Services {
			txt := make([]string, 0, len(s.TXT))
			for k, v := range s.TXT {
				txt = append(txt, k+"="+v)
			}
			sort.Strings(txt)
			fmt.Fprintf(w, "  %s port %d %s\n", s.Type, s.Port, strings.Join(txt, " "))
		}
	}
	if d.Metadata != nil && len(d.Metadata.AppConfig) > 0 && string(d.Metadata.AppConfig) != "null" {
		fmt.Fprintln(w, "\nApp config:")
		fmt.Fprintln(w, indentedJSON(d.Metadata.AppConfig, "  "))
	}
}

// logEvent is one event of GET /api/containers/:name/logs.
type logEvent struct {
	Type  string   `json:"type"`
	Lines []string `json:"lines"`
	RunID *string  `json:"runId"`
	Line  string   `json:"line"`
}

func runContainersLogs(ctx context.Context, c *call) error {
	lines := 100
	if v, ok := c.values["lines"]; ok {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return usagef(c.cmd.Path, "--lines takes a whole number of 1 or more, not %q", v)
		}
		lines = n
	}
	query := url.Values{}
	if run, ok := c.values["run"]; ok {
		query.Set("runId", run)
	}
	follow := c.switches["follow"]
	client, err := c.client()
	if err != nil {
		return err
	}
	name := c.args[0]
	err = client.Stream(ctx, containerPath(name, "logs"), query, func(data []byte) (bool, error) {
		var e logEvent
		if err := json.Unmarshal(data, &e); err != nil {
			return false, fmt.Errorf("read the log stream: %w", err)
		}
		switch e.Type {
		case "history":
			if e.RunID == nil {
				fmt.Fprintf(c.env.Stderr, "%s has not run yet: it has no log.\n", name)
				return true, nil
			}
			from := max(len(e.Lines)-lines, 0)
			for _, line := range e.Lines[from:] {
				fmt.Fprintln(c.env.Stdout, line)
			}
			return !follow, nil
		case "line":
			fmt.Fprintln(c.env.Stdout, e.Line)
		}
		return false, nil
	})
	if follow && err != nil && ctx.Err() != nil {
		return nil // interrupted: how a follow ends
	}
	return err
}
