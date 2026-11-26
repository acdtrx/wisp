package cmd

import (
	"context"
	"fmt"
	"os"
	"slices"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/selfupdate"
)

func runVersion(ctx context.Context, c *call) error {
	fmt.Fprintf(c.env.Stdout, "%s%s\n", selfupdate.VersionLinePrefix, c.env.Version)
	t, err := c.target()
	if err != nil {
		return err
	}
	info, err := fetchCLIInfo(ctx, api.New(t.url, t.token, c.env.Version))
	if err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Wisp      %s  (%s)\n", *info.Version, t.url)
	if *info.Version != c.env.Version {
		fmt.Fprintf(c.env.Stderr, "The two differ: run \"%s\" to get the CLI of that Wisp.\n", c.updateCommand())
	}
	return nil
}

func runUpdate(ctx context.Context, c *call) error {
	t, err := c.target()
	if err != nil {
		return err
	}
	client := api.New(t.url, t.token, c.env.Version)
	info, err := fetchCLIInfo(ctx, client)
	if err != nil {
		return err
	}
	if *info.Version == c.env.Version {
		fmt.Fprintf(c.env.Stdout, "wisp is %s already, the version of %s.\n", c.env.Version, t.url)
		return nil
	}
	if !slices.Contains(info.Platforms, c.env.Platform) {
		return fmt.Errorf("the Wisp at %s has no CLI for %s", t.url, c.env.Platform)
	}
	exe, err := c.env.Executable()
	if err != nil {
		return err
	}
	tmp, err := selfupdate.TempBeside(exe)
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // gone once renamed into place; what a failure left otherwise
	fmt.Fprintf(c.env.Stderr, "Downloading wisp %s for %s from %s …\n", *info.Version, c.env.Platform, t.url)
	size, err := client.Download(ctx, "/api/cli/wisp-"+c.env.Platform, tmp)
	if closeErr := tmp.Close(); err == nil && closeErr != nil {
		err = fmt.Errorf("write %s: %w", tmp.Name(), closeErr)
	}
	if err == nil && size == 0 {
		err = fmt.Errorf("the Wisp at %s sent an empty file", t.url)
	}
	// A 200 that is not the CLI (a captive portal's page) must not replace it.
	if err == nil {
		var got string
		if got, err = c.env.BinaryVersion(ctx, tmp.Name()); err == nil && got != *info.Version {
			err = fmt.Errorf("the download is the wisp CLI %s, not %s", got, *info.Version)
		}
	}
	if err != nil {
		return fmt.Errorf("wisp %s stays as it was: %w", c.env.Version, err)
	}
	if err := selfupdate.Replace(exe, tmp.Name()); err != nil {
		return fmt.Errorf("wisp %s stays as it was: %w", c.env.Version, err)
	}
	fmt.Fprintf(c.env.Stdout, "Updated wisp %s → %s (%s).\n", c.env.Version, *info.Version, exe)
	return nil
}
