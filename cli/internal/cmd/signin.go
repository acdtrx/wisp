package cmd

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/config"
	"github.com/acdtrx/wisp/cli/internal/term"
)

// cliInfo is GET /api/cli's answer: what tells a Wisp from another server.
type cliInfo struct {
	Version   *string  `json:"version"`
	Platforms []string `json:"platforms"`
}

// fetchCLIInfo asks client's Wisp for its version and platforms. An answer
// without them is not a Wisp's.
func fetchCLIInfo(ctx context.Context, client *api.Client) (*cliInfo, error) {
	var info cliInfo
	if _, err := client.GetJSON(ctx, "/api/cli", nil, &info); err != nil {
		var refused *api.Error
		if errors.As(err, &refused) {
			return nil, &api.NotWispError{URL: client.Base() + "/api/cli", Status: refused.Status, Reason: refused.Error()}
		}
		return nil, err
	}
	if info.Version == nil || *info.Version == "" || info.Platforms == nil {
		return nil, &api.NotWispError{URL: client.Base() + "/api/cli", Reason: "its answer has no version and platforms"}
	}
	return &info, nil
}

func runLogin(ctx context.Context, c *call) error {
	base, err := parseWispURL(c.args[0])
	if err != nil {
		return usagef(c.cmd.Path, "%s", err)
	}
	name := c.profile
	if name == "" {
		name = "default"
	}
	f, path, err := c.loadConfig()
	if err != nil {
		return err
	}
	token, err := c.readToken(base)
	if err != nil {
		return err
	}

	// The address first, with no token: a token goes only to a Wisp.
	if _, err := fetchCLIInfo(ctx, api.New(base, "", c.env.Version)); err != nil {
		return fmt.Errorf("nothing saved: %w", err)
	}
	// Then the token, on a route any scope may read. The Wisp checks the
	// token before the CLI's version, so a version refusal means the token
	// was taken: the profile is saved, and the refusal says to update.
	_, checkErr := api.New(base, token, c.env.Version).Get(ctx, "/api/jobs", nil)
	var refused *api.Error
	mismatch := errors.As(checkErr, &refused) && refused.Code == "CLI_VERSION_MISMATCH"
	if checkErr != nil && !mismatch {
		if errors.As(checkErr, &refused) {
			return fmt.Errorf("nothing saved: the Wisp refused the token: %w", checkErr)
		}
		return fmt.Errorf("nothing saved: %w", checkErr)
	}

	f.Profiles[name] = config.Profile{URL: base, Token: token}
	if f.Default == "" {
		f.Default = name
	}
	if err := f.Save(path); err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Signed in to %s as profile %q (%s token)%s.\n", base, name, tokenScope(token), defaultNote(f, name))
	if mismatch {
		c.profile = name
		return checkErr
	}
	return nil
}

func defaultNote(f *config.File, name string) string {
	if f.Default == name {
		return ", the default one"
	}
	return ""
}

// readToken reads the token: at a prompt with the typing hidden, or from
// standard input when it is not a terminal.
func (c *call) readToken(base string) (string, error) {
	var token string
	var err error
	if c.env.StdinIsTerminal {
		fmt.Fprintf(c.env.Stderr, "API token for %s (typing hidden): ", base)
		token, err = c.env.ReadHidden()
		fmt.Fprintln(c.env.Stderr)
	} else {
		token, err = term.ReadLineWithin(c.env.Stdin, c.env.TokenWait)
		if errors.Is(err, term.ErrNoLine) {
			return "", fmt.Errorf("no token on standard input within %s: give it there (printf '%%s\\n' \"$TOKEN\" | wisp login <url>), or run wisp login at a terminal", c.env.TokenWait)
		}
	}
	if err != nil {
		return "", fmt.Errorf("read the token: %w", err)
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", errors.New("no token given: type it at the prompt, or give it on standard input")
	}
	return token, nil
}

func runLogout(_ context.Context, c *call) error {
	f, path, err := c.loadConfig()
	if err != nil {
		return err
	}
	name := c.profile
	if name == "" {
		if f.Default == "" {
			return errors.New("no default profile to remove: name one with \"wisp --profile <name> logout\"")
		}
		name = f.Default
	}
	if _, ok := f.Profiles[name]; !ok {
		return fmt.Errorf("no profile %q", name)
	}
	delete(f.Profiles, name)
	if f.Default == name {
		f.Default = ""
	}
	if err := f.Save(path); err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Removed profile %q. Its token stays valid on the Wisp until it is revoked there.\n", name)
	return nil
}

func runProfiles(_ context.Context, c *call) error {
	f, _, err := c.loadConfig()
	if err != nil {
		return err
	}
	if len(f.Profiles) == 0 {
		fmt.Fprintln(c.env.Stdout, "No profiles: sign in with \"wisp login <url>\".")
		return nil
	}
	tw := tabwriter.NewWriter(c.env.Stdout, 0, 8, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tURL\tSCOPE\tDEFAULT")
	for _, name := range f.Names() {
		p := f.Profiles[name]
		mark := ""
		if name == f.Default {
			mark = "*"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", name, p.URL, tokenScope(p.Token), mark)
	}
	return tw.Flush()
}

func runDefault(_ context.Context, c *call) error {
	if c.profile == "" {
		return usagef(c.cmd.Path, "name the profile: \"wisp --profile <name> default\"")
	}
	f, path, err := c.loadConfig()
	if err != nil {
		return err
	}
	if _, ok := f.Profiles[c.profile]; !ok {
		return fmt.Errorf("no profile %q: sign in with \"wisp --profile %s login <url>\"", c.profile, c.profile)
	}
	f.Default = c.profile
	if err := f.Save(path); err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Profile %q is the default one.\n", c.profile)
	return nil
}
