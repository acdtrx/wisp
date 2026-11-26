package cmd

import (
	"math"
	"strconv"
	"strings"
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
	if c.command != nil {
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
	if c.switches["no-start"] {
		body["start"] = false
	}
	return body, nil
}

// unsetEnvFlag and noCommandFlag are `containers set`'s alone.
var (
	unsetEnvFlag  = flagDef{Name: "unset-env", Value: "KEY", Repeat: true, Usage: "Removes an env variable. May be repeated."}
	noCommandFlag = flagDef{Name: "no-command", Usage: "Run the image's own command again, in place of the one set."}
)

// patchBody is `containers set`'s settings and env: PATCH
// /api/containers/:name. Empty when the line sets neither.
func (c *call) patchBody() (map[string]any, error) {
	body := map[string]any{}
	if c.switches["no-command"] && c.command != nil {
		return nil, usagef(c.cmd.Path, "--no-command and -- <command> cannot both be given")
	}
	if err := c.commonSettings(body); err != nil {
		return nil, err
	}
	if c.switches["no-command"] {
		body["command"] = nil
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
