// Package cmd is the CLI's commands: the command line read, one command run,
// its output and its exit code (docs/specs/CLI.md, Commands).
package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/config"
	"github.com/acdtrx/wisp/cli/internal/selfupdate"
	"github.com/acdtrx/wisp/cli/internal/term"
)

// The exit codes (docs/specs/CLI.md, Behaviour every command shares).
const (
	exitDone   = 0
	exitFailed = 1
	exitUsage  = 2
)

// Env is what a run reads and writes outside its arguments: main builds it
// from the process, a test from buffers.
type Env struct {
	Version  string
	Platform string
	Stdin    io.Reader
	Stdout   io.Writer
	Stderr   io.Writer
	Getenv   func(string) string
	// StdinIsTerminal says whether the token is typed at a prompt, read by
	// ReadHidden with the typing hidden, or read from Stdin.
	StdinIsTerminal bool
	ReadHidden      func() (string, error)
	// Executable is the file `wisp update` replaces.
	Executable func() (string, error)
}

// System is the process's own Env.
func System(version string) *Env {
	return &Env{
		Version:         version,
		Platform:        runtime.GOOS + "-" + runtime.GOARCH,
		Stdin:           os.Stdin,
		Stdout:          os.Stdout,
		Stderr:          os.Stderr,
		Getenv:          os.Getenv,
		StdinIsTerminal: term.IsTerminal(os.Stdin),
		ReadHidden:      func() (string, error) { return term.ReadHidden(os.Stdin) },
		Executable:      selfupdate.Executable,
	}
}

// usageError is a wrong command line: exit 2, and nothing was sent.
type usageError struct {
	msg  string
	path string // the command whose help says more, or "" for the overview
}

func (e *usageError) Error() string { return e.msg }

func usagef(path, format string, a ...any) error {
	return &usageError{msg: fmt.Sprintf(format, a...), path: path}
}

// Main runs one command line and answers its exit code.
func Main(ctx context.Context, env *Env, args []string) int {
	if exe, err := env.Executable(); err == nil {
		selfupdate.RemoveLeftover(exe)
	}
	c, err := parseCommandLine(env, args)
	if err == nil && c.help {
		printHelp(env.Stdout, c.cmd)
		return exitDone
	}
	if err == nil {
		err = c.cmd.run(ctx, c)
	}
	return report(env, c, err)
}

// report prints err as the one line the spec gives it, and answers the exit
// code.
func report(env *Env, c *call, err error) int {
	if err == nil {
		return exitDone
	}
	var usage *usageError
	if errors.As(err, &usage) {
		fmt.Fprintf(env.Stderr, "wisp: %s\n", usage.msg)
		if usage.path != "" {
			fmt.Fprintf(env.Stderr, "Run \"wisp help %s\" for its usage.\n", usage.path)
		} else {
			fmt.Fprintln(env.Stderr, "Run \"wisp help\" for the commands.")
		}
		return exitUsage
	}
	jsonOut := c != nil && c.switches["json"]
	var refused *api.Error
	if errors.As(err, &refused) {
		if jsonOut {
			fmt.Fprintln(env.Stderr, strings.TrimSpace(string(refused.Body)))
			return exitFailed
		}
		line := refused.Error()
		if refused.Code == "CLI_VERSION_MISMATCH" && c != nil {
			line += " Run \"" + c.updateCommand() + "\" to get the CLI of that Wisp."
		}
		fmt.Fprintln(env.Stderr, line)
		return exitFailed
	}
	var failed *jobError
	if errors.As(err, &failed) && jsonOut {
		body, _ := json.Marshal(map[string]string{"error": failed.code, "detail": failed.message}) // two strings: cannot fail
		fmt.Fprintln(env.Stderr, string(body))
		return exitFailed
	}
	fmt.Fprintf(env.Stderr, "wisp: %s\n", err)
	return exitFailed
}

// call is one parsed command line.
type call struct {
	env      *Env
	cmd      *command
	profile  string // --profile, or "" when not given
	help     bool
	args     []string
	values   map[string]string
	switches map[string]bool
}

// updateCommand is the `wisp update` that fetches the CLI of this call's Wisp.
func (c *call) updateCommand() string {
	if c.profile != "" {
		return "wisp --profile " + c.profile + " update"
	}
	return "wisp update"
}

// parseCommandLine reads the global flags (before the command), the command,
// and its arguments and flags, in any order.
func parseCommandLine(env *Env, args []string) (*call, error) {
	c := &call{env: env, values: map[string]string{}, switches: map[string]bool{}}
	for len(args) > 0 && strings.HasPrefix(args[0], "-") {
		name, value, hasValue := strings.Cut(strings.TrimLeft(args[0], "-"), "=")
		switch {
		case args[0] == "-h" || args[0] == "--help":
			c.cmd = findCommand("help")
			return c, nil
		case args[0] == "--profile" || (strings.HasPrefix(args[0], "--") && name == "profile"):
			if !hasValue {
				if len(args) < 2 {
					return nil, usagef("", "--profile needs a profile's name")
				}
				value, args = args[1], args[1:]
			}
			if !config.ValidName(value) {
				return nil, usagef("", "%q is not a profile name: letters, digits, '.', '-' and '_', up to 64", value)
			}
			c.profile = value
			args = args[1:]
		default:
			return nil, usagef("", "unknown flag %s: only --profile <name> goes before the command", args[0])
		}
	}
	if len(args) == 0 {
		return nil, usagef("", "no command given")
	}
	cmd, rest, err := resolveCommand(args)
	if err != nil {
		return nil, err
	}
	c.cmd = cmd
	if err := c.parseArgs(rest); err != nil {
		return nil, err
	}
	return c, nil
}

// resolveCommand finds the command args name: one word, or a group and one of
// its commands.
func resolveCommand(args []string) (*command, []string, error) {
	if cmd := findCommand(args[0]); cmd != nil {
		return cmd, args[1:], nil
	}
	if !isGroup(args[0]) {
		return nil, nil, usagef("", "unknown command %q", args[0])
	}
	if len(args) < 2 || strings.HasPrefix(args[1], "-") {
		if len(args) >= 2 && (args[1] == "--help" || args[1] == "-h") {
			return findCommand("help"), []string{args[0]}, nil
		}
		return nil, nil, usagef(args[0], "%q needs one of its commands: %s", args[0], strings.Join(groupCommands(args[0]), ", "))
	}
	cmd := findCommand(args[0] + " " + args[1])
	if cmd == nil {
		return nil, nil, usagef(args[0], "unknown command %q", args[0]+" "+args[1])
	}
	return cmd, args[2:], nil
}

// parseArgs reads a command's flags and arguments, in either order; `--`
// ends the flags.
func (c *call) parseArgs(args []string) error {
	path := c.cmd.Path
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			positional = append(positional, args[i+1:]...)
			break
		}
		if arg == "-h" || arg == "--help" {
			c.help = true
			continue
		}
		if !strings.HasPrefix(arg, "--") || arg == "--" {
			if strings.HasPrefix(arg, "-") && arg != "-" {
				return usagef(path, "unknown flag %s", arg)
			}
			positional = append(positional, arg)
			continue
		}
		name, value, hasValue := strings.Cut(arg[2:], "=")
		def := c.cmd.flag(name)
		if def == nil {
			return usagef(path, "unknown flag --%s for \"wisp %s\"", name, path)
		}
		if def.Value == "" {
			if hasValue {
				return usagef(path, "--%s takes no value", name)
			}
			c.switches[name] = true
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				return usagef(path, "--%s needs %s", name, def.Value)
			}
			i++
			value = args[i]
		}
		if _, seen := c.values[name]; seen {
			return usagef(path, "--%s is given twice", name)
		}
		c.values[name] = value
	}
	if c.help {
		return nil
	}
	if c.cmd.MaxArgs >= 0 && len(positional) > c.cmd.MaxArgs || len(positional) < c.cmd.MinArgs {
		return usagef(path, "\"wisp %s\" takes %s", path, c.cmd.argsWanted())
	}
	c.args = positional
	return nil
}
