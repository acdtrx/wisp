package cmd

import (
	"context"
	"strings"
)

// command is one command of the CLI, with all its help: the help is what an
// agent learns the CLI from, so no command, flag or argument exists outside
// it (docs/specs/CLI.md, Commands).
type command struct {
	Path    string // "login", "containers list"
	Usage   string // the arguments, as the usage line shows them
	MinArgs int
	MaxArgs int // -1: no limit
	Summary string
	About   string
	Flags   []flagDef
	Example string
	run     func(ctx context.Context, c *call) error
}

// flagDef is one flag of a command: a switch when Value is empty, else a
// flag that takes the value Value names.
type flagDef struct {
	Name  string
	Value string
	Usage string
}

var jsonFlag = flagDef{Name: "json", Usage: "Print the API's JSON instead of text, unchanged."}

func (c *command) flag(name string) *flagDef {
	for i := range c.Flags {
		if c.Flags[i].Name == name {
			return &c.Flags[i]
		}
	}
	return nil
}

func (c *command) argsWanted() string {
	switch {
	case c.MaxArgs == 0:
		return "no arguments"
	case c.Usage == "":
		return "no arguments"
	default:
		return c.Usage
	}
}

// group is a heading of the overview, and for a word like `containers` the
// commands under it.
type group struct {
	Word  string // "" for the CLI's own commands
	Title string
}

var groups = []group{
	{Word: "", Title: "The CLI itself"},
	{Word: "containers", Title: "Containers"},
	{Word: "images", Title: "Images"},
	{Word: "jobs", Title: "Jobs"},
}

func isGroup(word string) bool {
	for _, g := range groups {
		if g.Word != "" && g.Word == word {
			return true
		}
	}
	return false
}

func groupOf(c *command) string {
	if word, _, found := strings.Cut(c.Path, " "); found {
		return word
	}
	return ""
}

func groupCommands(word string) []string {
	var names []string
	for _, c := range commandTable() {
		if groupOf(c) == word {
			names = append(names, strings.TrimPrefix(c.Path, word+" "))
		}
	}
	return names
}

func findCommand(path string) *command {
	for _, c := range commandTable() {
		if c.Path == path {
			return c
		}
	}
	return nil
}

// commandTable is every command, in the order the overview lists them.
func commandTable() []*command {
	return []*command{
		{
			Path: "login", Usage: "<url>", MinArgs: 1, MaxArgs: 1,
			Summary: "Sign in to a Wisp with an API token, as a profile",
			About: "Saves a profile: the Wisp's address and an API token, made in the Wisp's page under\n" +
				"Host → App Config → API tokens. The token is asked for with the typing hidden, or read\n" +
				"from standard input when that is not a terminal; it is never an argument. The address\n" +
				"and the token are checked against the Wisp before anything is saved.\n\n" +
				"Without --profile the profile is named \"default\". The first profile saved becomes the\n" +
				"default one. Logging in again under a name replaces that profile.",
			Example: "wisp login http://wisp.local:8080\n" +
				"wisp --profile lab login https://wisp.lab.example.com\n" +
				"printf '%s\\n' \"$TOKEN\" | wisp login http://wisp.local:8080",
			run: runLogin,
		},
		{
			Path: "logout", MaxArgs: 0,
			Summary: "Remove a profile",
			About: "Removes the profile named by --profile, or else the default one. The token stays valid\n" +
				"on the Wisp until it is revoked there.",
			Example: "wisp --profile lab logout",
			run:     runLogout,
		},
		{
			Path: "profiles", MaxArgs: 0,
			Summary: "List the profiles",
			About:   "Lists each profile: its name, its Wisp's address, its token's scope, and which is the\ndefault. Never a token.",
			Example: "wisp profiles",
			run:     runProfiles,
		},
		{
			Path: "default", MaxArgs: 0,
			Summary: "Make a profile the default one",
			About:   "Makes the profile named by --profile the one commands use when no --profile is given\nand WISP_URL and WISP_TOKEN are not set.",
			Example: "wisp --profile lab default",
			run:     runDefault,
		},
		{
			Path: "version", MaxArgs: 0,
			Summary: "Print the CLI's version and the Wisp's",
			About:   "Prints this CLI's version, then the version of the Wisp it talks to. The two must be the\nsame: \"wisp update\" fetches the Wisp's own CLI when they are not.",
			Example: "wisp version",
			run:     runVersion,
		},
		{
			Path: "update", MaxArgs: 0,
			Summary: "Replace this CLI with the Wisp's own",
			About: "Downloads the CLI for this platform from the Wisp it talks to and puts it in place of\n" +
				"this one, in one step: when the download fails, this CLI stays as it was.",
			Example: "wisp update\nwisp --profile lab update",
			run:     runUpdate,
		},
		{
			Path: "help", Usage: "[<command>]", MaxArgs: 2,
			Summary: "Print the commands, or one command in full",
			About:   "With no argument, lists every command. With a command, prints it in full: its\narguments, its flags and an example. \"wisp <command> --help\" does the same.",
			Example: "wisp help containers logs",
			run:     runHelp,
		},
		{
			Path: "containers list", MaxArgs: 0,
			Summary: "List the containers",
			About:   "Lists every container: its name, its state, its image, and whether an image update is\navailable or a restart is pending or scheduled.",
			Flags:   []flagDef{jsonFlag},
			Example: "wisp containers list",
			run:     runContainersList,
		},
		{
			Path: "containers show", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Print everything about a container",
			About: "Prints a container's state, its settings, its env, its mounts, its devices and mDNS\n" +
				"services and, for an app container, the app's config. A secret env value, a secret file\n" +
				"and an app's secret fields are masked, as the API sends them.",
			Flags:   []flagDef{jsonFlag},
			Example: "wisp containers show web",
			run:     runContainersShow,
		},
		{
			Path: "containers logs", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Print a container's log",
			About: "Prints the last lines of the newest run (the one running, or else the last one), then\n" +
				"ends. Each start of the container is a run; the Wisp keeps the last 500 lines of each\n" +
				"of the newest 10 runs.",
			Flags: []flagDef{
				{Name: "lines", Value: "<n>", Usage: "How many of the last lines to print (default 100; at most the 500 the Wisp sends)."},
				{Name: "run", Value: "<id>", Usage: "The run to print, by its id, instead of the newest."},
				{Name: "follow", Usage: "Keep printing new lines as they come, until interrupted (Ctrl-C)."},
			},
			Example: "wisp containers logs web --lines 20\nwisp containers logs web --follow",
			run:     runContainersLogs,
		},
		{
			Path: "images list", MaxArgs: 0,
			Summary: "List the container images",
			About:   "Lists the images the Wisp's containers run from: name, size, when it was last updated,\nand digest. An uploaded image's name is under localhost/.",
			Flags:   []flagDef{jsonFlag},
			Example: "wisp images list",
			run:     runImagesList,
		},
		{
			Path: "jobs list", MaxArgs: 0,
			Summary: "List the background jobs",
			About:   "Lists the Wisp's background jobs, newest first: running ones, and those that ended in\nthe last 5 minutes. Each has an id for \"wisp jobs wait\".",
			Flags:   []flagDef{jsonFlag},
			Example: "wisp jobs list",
			run:     runJobsList,
		},
		{
			Path: "jobs wait", Usage: "<id>", MinArgs: 1, MaxArgs: 1,
			Summary: "Wait for a job, printing its progress",
			About: "Prints a job's progress as it comes (on standard error), and ends when the job does:\n" +
				"with its result (exit 0), or with its error (exit 1). A job that ended is answered at\n" +
				"once, for 5 minutes after its end. An interrupt (Ctrl-C) ends the wait, never the job.",
			Flags:   []flagDef{jsonFlag},
			Example: "wisp jobs wait 3f2c9a1e-…",
			run:     runJobsWait,
		},
	}
}
