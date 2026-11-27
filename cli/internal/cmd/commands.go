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
	// TakesCommand: what follows `--` is the command a container runs, not
	// arguments of this one.
	TakesCommand bool
	Example      string
	run          func(ctx context.Context, c *call) error
}

// flagDef is one flag of a command: a switch when Value is empty, else a
// flag that takes the value Value names.
type flagDef struct {
	Name   string
	Value  string
	Usage  string
	Repeat bool // may be given more than once
}

var jsonFlag = flagDef{Name: "json", Usage: "Print the API's JSON instead of text, unchanged."}

// jobJSONFlag is --json on a command that starts a job.
var jobJSONFlag = flagDef{Name: "json", Usage: "Print the API's JSON instead of text, unchanged: the job's result, or with --no-wait the job's ack."}

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
			Path: "containers create", Usage: "<name>", MinArgs: 1, MaxArgs: 1, TakesCommand: true,
			Summary: "Create a container, set it up and start it",
			About: "Creates a container on the Wisp's default bridge from --image, with the settings given,\n" +
				"and starts it: one job on the Wisp. The image is pulled, unless the Wisp holds one by\n" +
				"that name already (an image \"wisp images push\" uploaded is under localhost/). The\n" +
				"command prints the job's progress on standard error and ends when the job does, with\n" +
				"the container as \"wisp containers show\" prints it. When a setting, a mount or the\n" +
				"start fails, the container exists, stopped, and the error says so.\n\n" +
				"The mounts are kept on this host, under the container's own files, and start empty:\n" +
				"\"wisp containers upload\" fills them. Their names are what \"wisp containers upload\"\n" +
				"and \"wisp containers show\" call them.\n\n" +
				"The container has its own address on the LAN, by DHCP, and <name>.local unless\n" +
				"--local-dns off; there is no port mapping. Without --restart-policy it is\n" +
				"unless-stopped. --no-start leaves it stopped, for files to be uploaded first (\"wisp\n" +
				"containers upload\"); \"wisp containers start\" then starts it. An interrupt (Ctrl-C) ends\n" +
				"the wait, never the job.",
			Flags: []flagDef{
				imageFlag, envFlag, secretEnvFlag, mountFlag, fileMountFlag, tmpfsFlag, cpuFlag, memoryFlag, restartFlag,
				autostartFlag, backupFlag, localDNSFlag,
				{Name: "no-start", Usage: "Leave the container defined and stopped."},
				noWaitFlag, jobJSONFlag,
			},
			Example: "wisp containers create web --image nginx:1.27 --env MODE=prod --secret-env API_KEY=s3cret --memory 256\n" +
				"wisp containers create worker --image ghcr.io/me/worker:v3 --cpu 1 -- worker --queue jobs\n" +
				"wisp containers create site --image nginx:1.27 --mount site:/usr/share/nginx/html:ro --tmpfs cache:/var/cache/nginx:128 --no-start",
			run: runContainersCreate,
		},
		{
			Path: "containers set", Usage: "<name>", MinArgs: 1, MaxArgs: 1, TakesCommand: true,
			Summary: "Change a container's settings",
			About: "Changes the settings given and leaves the rest as they are: one request on the Wisp.\n" +
				"\"wisp containers show\" prints them after. A change a running container cannot take\n" +
				"(the image, the env, the command, the limits) waits for its restart, and the container\n" +
				"shows a restart pending; the restart policy, autostart, the backup and Local DNS apply at\n" +
				"once. A setting the token may not change is the Wisp's refusal.\n\n" +
				"--env sets a variable and keeps the others; --secret-env sets one stored write-only;\n" +
				"--unset-env removes one. --image points the container at another image for its next\n" +
				"start, which pulls it when the Wisp does not hold it; \"wisp containers update\n" +
				"--image\" pulls it and restarts at once.\n\n" +
				"--mount, --file-mount and --tmpfs add a mount; one whose name or path the container\n" +
				"has already is the Wisp's refusal. set never removes or changes a mount. The settings\n" +
				"and env go as one request, then each mount as one: the first that fails ends the\n" +
				"command, which says what was saved before it.\n\n" +
				"--app-config changes an app container's config (a Caddy's sites): the JSON object of\n" +
				"the fields to change, each replacing that field; \"wisp containers show\" prints the\n" +
				"config. It goes alone, as the Wisp saves an app's config with no other setting; an\n" +
				"app container's env and mounts come from its config. A field the token may not write\n" +
				"is the Wisp's refusal.",
			Flags: []flagDef{
				imageFlag, envFlag, secretEnvFlag, unsetEnvFlag, mountFlag, fileMountFlag, tmpfsFlag, cpuFlag, memoryFlag,
				restartFlag, autostartFlag, backupFlag, localDNSFlag, noCommandFlag, appConfigFlag,
			},
			Example: "wisp containers set web --env MODE=staging --unset-env DEBUG --memory none\n" +
				"wisp containers set worker -- worker --queue jobs --verbose\n" +
				"wisp containers set worker --no-command\n" +
				"wisp containers set web --mount data:/data --file-mount conf:/etc/app.conf:ro:secret\n" +
				"wisp containers set caddy --app-config sites.json   # {\"hosts\": [{\"subdomain\": \"app\", \"target\": \"web.local:8080\"}]}",
			run: runContainersSet,
		},
		{
			Path: "containers update", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Pull a container's image again and restart it",
			About: "Pulls the container's image again, or with --image the image given, points the\n" +
				"container at it and restarts it if it runs: one job on the Wisp, which holds the\n" +
				"container from the pull to the restart. A stopped container takes the image at its\n" +
				"next start. An image under localhost/ (one \"wisp images push\" uploaded) is not pulled:\n" +
				"the Wisp's own is used. The command prints the job's progress on standard error and\n" +
				"ends when it does. An interrupt (Ctrl-C) ends the wait, never the job.",
			Flags: []flagDef{
				{Name: "image", Value: "<ref>", Usage: "The image to move the container to, in place of pulling its own again."},
				noWaitFlag, jobJSONFlag,
			},
			Example: "wisp containers update web\nwisp containers update web --image nginx:1.29",
			run:     runContainersUpdate,
		},
		{
			Path: "containers start", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Start a stopped container",
			About: "Starts the container, a job on the Wisp: the command prints its progress on standard\n" +
				"error and ends when it does. A container already running, or busy with another\n" +
				"command, is the Wisp's refusal. An interrupt (Ctrl-C) ends the wait, never the job.",
			Flags:   []flagDef{noWaitFlag, jobJSONFlag},
			Example: "wisp containers start web",
			run:     lifecycleCommand("start", "Started"),
		},
		{
			Path: "containers stop", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Stop a running container",
			About: "Stops the container, a job on the Wisp: SIGTERM, then SIGKILL after its grace period. On\n" +
				"a stopped container whose restart policy has a restart scheduled, it cancels that\n" +
				"restart. The command prints the job's progress on standard error and ends when it\n" +
				"does. A container not running, or busy with another command, is the Wisp's refusal.\n" +
				"An interrupt (Ctrl-C) ends the wait, never the job.",
			Flags:   []flagDef{noWaitFlag, jobJSONFlag},
			Example: "wisp containers stop web",
			run:     lifecycleCommand("stop", "Stopped"),
		},
		{
			Path: "containers restart", Usage: "<name>", MinArgs: 1, MaxArgs: 1,
			Summary: "Restart a container",
			About: "Stops the container and starts it again, a job on the Wisp: the start applies what\n" +
				"waits for a restart (a changed image, env, command or mount). The command prints the\n" +
				"job's progress on standard error and ends when it does. A container busy with another\n" +
				"command is the Wisp's refusal. An interrupt (Ctrl-C) ends the wait, never the job.",
			Flags:   []flagDef{noWaitFlag, jobJSONFlag},
			Example: "wisp containers restart web",
			run:     lifecycleCommand("restart", "Restarted"),
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
			Path: "containers upload", Usage: "<name> <mount> <path>", MinArgs: 3, MaxArgs: 3,
			Summary: "Send a file or a folder to a container's mount",
			About: "Sends what <path> is to the mount named <mount>:\n" +
				"  - a file to a file mount, whose content it replaces;\n" +
				"  - a folder to a folder mount, zipped by the CLI as it is sent: the mount's content\n" +
				"    is replaced by the folder's, nested folders and empty ones included, and what the\n" +
				"    mount held before is gone;\n" +
				"  - a zip file to a folder mount, which the Wisp extracts into it, in place of its\n" +
				"    content.\n" +
				"The CLI reads the container to tell a folder mount from a file mount. A folder's\n" +
				"extract is a job on the Wisp: the command prints its progress on standard error and\n" +
				"ends when it does. A mount the token may not write, or the container busy with\n" +
				"another command, is the Wisp's refusal. A secret file mount takes a file too, and no\n" +
				"command reads it back.",
			Flags: []flagDef{
				{Name: "no-wait", Usage: "For a folder or a zip: print the extract's job id and end once the upload is sent."},
				{Name: "json", Usage: "Print the API's JSON instead of text, unchanged: the extract job's result, or with --no-wait its ack. A file's upload answers none."},
			},
			Example: "wisp containers upload site site ./dist\nwisp containers upload web conf ./app.conf\nwisp containers upload site site ./site.zip",
			run:     runContainersUpload,
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
			Path: "images push", Usage: "<archive>", MinArgs: 1, MaxArgs: 1,
			Summary: "Upload an image archive to the Wisp",
			About: "Uploads an image archive, the tar \"docker save\" or \"podman save\" writes, from a file\n" +
				"or, with -, from standard input, and waits for the Wisp to import it (a job, whose\n" +
				"progress the command prints on standard error). It then prints the name each image is\n" +
				"stored under, with localhost/ as its registry: give that name to \"wisp containers\n" +
				"create --image\". No registry is needed, and the Wisp never pulls a localhost/ image:\n" +
				"pushing the same name again replaces it, and \"wisp containers update\" or a restart\n" +
				"moves a container to it. An archive the host cannot run (another architecture) is\n" +
				"the import's error.",
			Flags:   []flagDef{{Name: "no-wait", Usage: "Print the import's job id and end once the archive is sent."}, jobJSONFlag},
			Example: "wisp images push ./myapp.tar\ndocker save myapp:v1 | wisp images push -",
			run:     runImagesPush,
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
