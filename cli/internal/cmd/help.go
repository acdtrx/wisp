package cmd

import (
	"context"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

const overviewIntro = `wisp is the command-line client of a Wisp's REST API. It is of the same version as the
Wisp it talks to: the Wisp serves it, and "wisp update" fetches it again after the Wisp
is updated.

Usage: wisp [--profile <name>] <command> [arguments] [flags]
`

const overviewShared = `Signing in:
  A profile is a Wisp's address and an API token, saved by "wisp login". A command uses,
  first match: the profile --profile names; WISP_URL with WISP_TOKEN, set together (no
  file needed); the default profile. The token is never a command's argument.

Global flag, before the command:
  --profile <name>   Use this profile for this one command.

Every command:
  Flags and arguments may come in either order. Output is text, a table for a list and
  labelled lines for one thing. What a command prints is on standard output; progress and
  errors are on standard error. An error is one line, the API's code and its message.
  The commands that print what the API sent take --json, which prints the API's own JSON
  instead, unchanged, and an error as the API's error body.
  Exit codes: 0 done; 1 the request or the job failed; 2 the command line was wrong, and
  nothing was sent.

Run "wisp help <command>" for a command's arguments, flags and an example.
`

func runHelp(_ context.Context, c *call) error {
	w := c.env.Stdout
	switch {
	case len(c.args) == 0:
		printOverview(w)
	case len(c.args) == 1 && isGroup(c.args[0]):
		printGroup(w, c.args[0])
	default:
		path := strings.Join(c.args, " ")
		cmd := findCommand(path)
		if cmd == nil {
			return usagef("", "unknown command %q", path)
		}
		printHelp(w, cmd)
	}
	return nil
}

func printOverview(w io.Writer) {
	fmt.Fprint(w, overviewIntro+"\n")
	for _, g := range groups {
		fmt.Fprintf(w, "%s:\n", g.Title)
		printCommandList(w, g.Word)
		fmt.Fprintln(w)
	}
	fmt.Fprint(w, overviewShared)
}

func printGroup(w io.Writer, word string) {
	fmt.Fprintf(w, "Usage: wisp [--profile <name>] %s <command> [arguments] [flags]\n\n", word)
	printCommandList(w, word)
	fmt.Fprintf(w, "\nRun \"wisp help %s <command>\" for a command in full.\n", word)
}

func printCommandList(w io.Writer, word string) {
	tw := tabwriter.NewWriter(w, 0, 8, 3, ' ', 0)
	for _, c := range commandTable() {
		if groupOf(c) != word {
			continue
		}
		fmt.Fprintf(tw, "  %s\t%s\n", strings.TrimSpace(c.Path+" "+c.Usage), c.Summary)
	}
	tw.Flush()
}

// printHelp prints one command in full.
func printHelp(w io.Writer, c *command) {
	fmt.Fprintf(w, "Usage: wisp [--profile <name>] %s\n\n", strings.TrimSpace(c.Path+" "+c.Usage+flagsUsage(c)))
	fmt.Fprintf(w, "%s.\n\n%s\n", c.Summary, c.About)
	if len(c.Flags) > 0 {
		fmt.Fprintln(w, "\nFlags:")
		tw := tabwriter.NewWriter(w, 0, 8, 3, ' ', 0)
		for _, f := range c.Flags {
			fmt.Fprintf(tw, "  %s\t%s\n", strings.TrimSpace("--"+f.Name+" "+f.Value), f.Usage)
		}
		if c.TakesCommand {
			fmt.Fprintf(tw, "  -- <command> [args…]\tThe command the container runs, in place of the image's own: everything after --, each word one argument. Last on the line.\n")
		}
		tw.Flush()
	}
	fmt.Fprintf(w, "\nExample:\n  %s\n", strings.ReplaceAll(c.Example, "\n", "\n  "))
}

func flagsUsage(c *command) string {
	usage := ""
	if len(c.Flags) > 0 {
		usage = " [flags]"
	}
	if c.TakesCommand {
		usage += " [-- <command> [args…]]"
	}
	return usage
}
