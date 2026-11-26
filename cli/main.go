// Command wisp is the command-line client of a Wisp's REST API, of the same
// version as the Wisp it talks to (docs/specs/CLI.md).
package main

import (
	"context"
	"os"
	"os/signal"

	"github.com/acdtrx/wisp/cli/internal/cmd"
)

// version is stamped at build from the root package.json, the version's one
// source (scripts/stage-release.sh).
var version = "dev"

func main() {
	// An interrupt ends a wait or a stream through the context; the command
	// then says what it left running.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	code := cmd.Main(ctx, cmd.System(version), os.Args[1:])
	stop()
	os.Exit(code)
}
