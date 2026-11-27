package cmd

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/acdtrx/wisp/cli/internal/term"
)

// The settings flags of `containers create` and `containers set`
// (docs/specs/CLI.md, The settings flags). Each turns into the API's own
// field; what a value may be is the Wisp's to say, but for the form the
// command line gives it.
var (
	imageFlag     = flagDef{Name: "image", Value: "<ref>", Usage: "The image, as a registry reference (nginx:1.27, ghcr.io/me/app:v2) or a name \"wisp images list\" shows (localhost/myapp:v1)."}
	envFlag       = flagDef{Name: "env", Value: "KEY=VALUE", Repeat: true, Usage: "Sets an env variable. May be repeated."}
	secretEnvFlag = flagDef{Name: "secret-env", Value: "KEY=VALUE", Repeat: true, Usage: "Sets an env variable stored write-only: no command prints its value again. May be repeated."}
	cpuFlag       = flagDef{Name: "cpu", Value: "<cores>", Usage: "The CPU limit, in cores (0.5, 2); none removes it."}
	memoryFlag    = flagDef{Name: "memory", Value: "<MiB>", Usage: "The memory limit, in MiB; none removes it."}
	restartFlag   = flagDef{Name: "restart-policy", Value: "<policy>", Usage: "What the Wisp does when the process exits on its own: never, on-failure (on a non-zero exit), unless-stopped or always (on any exit). A stop through the Wisp is never undone."}
	autostartFlag = flagDef{Name: "autostart", Value: "on|off", Usage: "Start the container when the host boots."}
	backupFlag    = flagDef{Name: "auto-backup", Value: "on|off", Usage: "Include the container in the Wisp's daily scheduled backup."}
	localDNSFlag  = flagDef{Name: "local-dns", Value: "on|off", Usage: "Announce <name>.local on the LAN."}
	noWaitFlag    = flagDef{Name: "no-wait", Usage: "Print the job's id and end at once, the job running on; \"wisp jobs wait <id>\" waits for it."}
)

// keyValues reads the KEY=VALUE values of flag name, refusing a key given twice
// in seen (shared between the env flags).
func (c *call) keyValues(name string, seen map[string]string) (map[string]string, error) {
	values := c.lists[name]
	if len(values) == 0 {
		return nil, nil
	}
	out := map[string]string{}
	for _, v := range values {
		key, value, ok := strings.Cut(v, "=")
		if !ok || key == "" {
			if name == "secret-env" {
				// Never the argument: it may be the secret, with its = or its key lost.
				return nil, usagef(c.cmd.Path, "--secret-env takes KEY=VALUE, with a KEY before the =")
			}
			return nil, usagef(c.cmd.Path, "--%s takes KEY=VALUE, not %q", name, v)
		}
		if other, dup := seen[key]; dup {
			return nil, usagef(c.cmd.Path, "%s is given twice (--%s and --%s)", key, other, name)
		}
		seen[key] = name
		out[key] = value
	}
	return out, nil
}

// onOff reads an on|off flag into body[field].
func (c *call) onOff(name, field string, body map[string]any) error {
	v, ok := c.values[name]
	if !ok {
		return nil
	}
	switch v {
	case "on":
		body[field] = true
	case "off":
		body[field] = false
	default:
		return usagef(c.cmd.Path, "--%s takes on or off, not %q", name, v)
	}
	return nil
}

// limit reads --cpu or --memory into body[field]: a number, or none (null).
func (c *call) limit(name, field string, integer bool, body map[string]any) error {
	v, ok := c.values[name]
	if !ok {
		return nil
	}
	if v == "none" {
		body[field] = nil
		return nil
	}
	if integer {
		n, err := strconv.Atoi(v)
		if err != nil {
			return usagef(c.cmd.Path, "--%s takes a whole number of MiB, or none, not %q", name, v)
		}
		body[field] = n
		return nil
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return usagef(c.cmd.Path, "--%s takes a number of cores, or none, not %q", name, v)
	}
	body[field] = n
	return nil
}

// commonSettings reads the settings create and set share into body, with
// the API's names.
func (c *call) commonSettings(body map[string]any) error {
	if v, ok := c.values["image"]; ok {
		body["image"] = v
	}
	if v, ok := c.values["restart-policy"]; ok {
		body["restartPolicy"] = v
	}
	for _, f := range []struct{ flag, field string }{{"autostart", "autostart"}, {"auto-backup", "autoBackup"}, {"local-dns", "localDns"}} {
		if err := c.onOff(f.flag, f.field, body); err != nil {
			return err
		}
	}
	if err := c.limit("cpu", "cpuLimit", false, body); err != nil {
		return err
	}
	if err := c.limit("memory", "memoryLimitMiB", true, body); err != nil {
		return err
	}
	switch {
	case c.switches["no-command"] && c.command != nil:
		return usagef(c.cmd.Path, "--no-command and -- <command> cannot both be given")
	case c.switches["no-command"]:
		body["command"] = nil
	case c.command != nil:
		body["command"] = c.command
	}
	return nil
}

// deployBody is `containers create`'s request: POST /api/containers/deploy.
func (c *call) deployBody() (map[string]any, error) {
	body := map[string]any{"name": c.args[0]}
	if _, ok := c.values["image"]; !ok {
		return nil, usagef(c.cmd.Path, "--image is required: the image the container runs")
	}
	if err := c.commonSettings(body); err != nil {
		return nil, err
	}
	seen := map[string]string{}
	env, err := c.keyValues("env", seen)
	if err != nil {
		return nil, err
	}
	secretEnv, err := c.keyValues("secret-env", seen)
	if err != nil {
		return nil, err
	}
	if env != nil {
		body["env"] = env
	}
	if secretEnv != nil {
		body["secretEnv"] = secretEnv
	}
	mounts, err := c.mounts()
	if err != nil {
		return nil, err
	}
	if mounts != nil {
		body["mounts"] = mounts
	}
	if c.switches["no-start"] {
		body["start"] = false
	}
	return body, nil
}

// unsetEnvFlag is `containers set`'s alone.
var (
	unsetEnvFlag  = flagDef{Name: "unset-env", Value: "KEY", Repeat: true, Usage: "Removes an env variable. May be repeated."}
	noCommandFlag = flagDef{Name: "no-command", Usage: "Run the image's own command, in place of one set before."}
)

// patchBody is `containers set`'s settings and env: PATCH
// /api/containers/:name. Empty when the line sets neither.
func (c *call) patchBody() (map[string]any, error) {
	body := map[string]any{}
	if err := c.commonSettings(body); err != nil {
		return nil, err
	}
	seen := map[string]string{}
	env, err := c.keyValues("env", seen)
	if err != nil {
		return nil, err
	}
	secretEnv, err := c.keyValues("secret-env", seen)
	if err != nil {
		return nil, err
	}
	envPatch := map[string]any{}
	for k, v := range env {
		envPatch[k] = map[string]any{"value": v}
	}
	for k, v := range secretEnv {
		envPatch[k] = map[string]any{"value": v, "secret": true}
	}
	for _, k := range c.lists["unset-env"] {
		if other, dup := seen[k]; dup {
			return nil, usagef(c.cmd.Path, "%s is given twice (--%s and --unset-env)", k, other)
		}
		if k == "" || strings.Contains(k, "=") {
			return nil, usagef(c.cmd.Path, "--unset-env takes a KEY alone, not %q", k)
		}
		seen[k] = "unset-env"
		envPatch[k] = nil
	}
	if len(envPatch) > 0 {
		body["envPatch"] = envPatch
	}
	return body, nil
}

// The mount flags of create and set: each adds one mount kept on this host.
var (
	mountFlag = flagDef{Name: "mount", Value: "<name>:<container-path>[:ro]", Repeat: true,
		Usage: "Adds a folder kept on this host, by that name, at that path in the container; ro mounts it read-only. It starts empty: \"wisp containers upload\" fills it. May be repeated."}
	fileMountFlag = flagDef{Name: "file-mount", Value: "<name>:<container-path>[:ro][:secret]", Repeat: true,
		Usage: "Adds a file kept on this host; ro mounts it read-only, secret makes its content write-only. It starts empty: \"wisp containers upload\" writes it. May be repeated."}
	tmpfsFlag = flagDef{Name: "tmpfs", Value: "<name>:<container-path>[:<MiB>]", Repeat: true,
		Usage: "Adds a folder in memory, empty at every start, of 64 MiB or the size given. May be repeated."}
	appConfigFlag = flagDef{Name: "app-config", Value: "<file>",
		Usage: "Changes an app container's config: the fields to change, as a JSON object in the file, or - for standard input. Goes alone: no other setting with it."}
)

// mounts reads the mount flags as POST …/mounts bodies: the folders, then
// the files, then the memory folders, each in the order given.
func (c *call) mounts() ([]map[string]any, error) {
	var out []map[string]any
	for _, kind := range []struct {
		flag, mountType string
		options         []string
	}{
		{"mount", "directory", []string{"ro"}},
		{"file-mount", "file", []string{"ro", "secret"}},
		{"tmpfs", "tmpfs", nil},
	} {
		for _, v := range c.lists[kind.flag] {
			parts := strings.Split(v, ":")
			if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
				return nil, usagef(c.cmd.Path, "--%s takes <name>:<container-path>, not %q", kind.flag, v)
			}
			m := map[string]any{"type": kind.mountType, "name": parts[0], "containerPath": parts[1]}
			if kind.mountType == "tmpfs" {
				if len(parts) > 3 {
					return nil, usagef(c.cmd.Path, "--tmpfs takes <name>:<container-path>[:<MiB>], not %q", v)
				}
				if len(parts) == 3 {
					size, err := strconv.Atoi(parts[2])
					if err != nil {
						return nil, usagef(c.cmd.Path, "--tmpfs takes its size as a whole number of MiB, not %q", parts[2])
					}
					m["sizeMiB"] = size
				}
				out = append(out, m)
				continue
			}
			for _, opt := range parts[2:] {
				if !slices.Contains(kind.options, opt) || m[optionField(opt)] != nil {
					return nil, usagef(c.cmd.Path, "--%s takes %s after the path, each once, not %q", kind.flag, strings.Join(kind.options, " or "), opt)
				}
				m[optionField(opt)] = true
			}
			out = append(out, m)
		}
	}
	return out, nil
}

func optionField(opt string) string {
	if opt == "ro" {
		return "readonly"
	}
	return opt
}

// maxAppConfig bounds the app config read from a file or standard input.
const maxAppConfig = 1 << 20

// appConfig reads --app-config: the JSON in the file, or on standard input,
// both under the same bounds on size and on the wait. Nil when the flag is
// not given. Nothing is sent before it is read, so a failure is exit 2.
func (c *call) appConfig(ctx context.Context) (json.RawMessage, error) {
	path, ok := c.values["app-config"]
	if !ok {
		return nil, nil
	}
	source := term.ReaderWithin(ctx, c.env.Stdin, c.env.TokenWait)
	if path != "-" {
		if _, err := os.Stat(path); err != nil {
			return nil, usagef(c.cmd.Path, "--app-config: %s", err)
		}
		source = term.SourceWithin(ctx, path, func() (io.ReadCloser, error) { return os.Open(path) }, c.env.TokenWait)
	}
	raw, err := io.ReadAll(io.LimitReader(source, maxAppConfig+1))
	if err != nil {
		return nil, usagef(c.cmd.Path, "read the app config: %s", err)
	}
	if len(raw) > maxAppConfig {
		return nil, usagef(c.cmd.Path, "the app config is over %d bytes", maxAppConfig)
	}
	if !json.Valid(raw) {
		return nil, usagef(c.cmd.Path, "the app config in %s is not JSON", path)
	}
	return json.RawMessage(raw), nil
}
