package cmd

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/config"
)

// target is the Wisp a command talks to, and the token it sends.
type target struct {
	profile string // the profile's name; "" when it came from the environment
	url     string
	token   string
}

// errNotSignedIn is a command that needs a Wisp, with none to talk to.
var errNotSignedIn = errors.New("not signed in: run \"wisp login <url>\" (or set WISP_URL and WISP_TOKEN)")

func (c *call) configPath() (string, error) {
	dir, err := config.Dir(c.env.Getenv)
	if err != nil {
		return "", err
	}
	return config.Path(dir), nil
}

func (c *call) loadConfig() (*config.File, string, error) {
	path, err := c.configPath()
	if err != nil {
		return nil, "", err
	}
	f, err := config.Load(path)
	if err != nil {
		return nil, "", err
	}
	return f, path, nil
}

// target picks the Wisp, first match: --profile; WISP_URL with WISP_TOKEN;
// the default profile (docs/specs/CLI.md, The environment).
func (c *call) target() (*target, error) {
	if c.profile != "" {
		f, _, err := c.loadConfig()
		if err != nil {
			return nil, err
		}
		p, ok := f.Profiles[c.profile]
		if !ok {
			return nil, fmt.Errorf("no profile %q: sign in with \"wisp --profile %s login <url>\"", c.profile, c.profile)
		}
		return &target{profile: c.profile, url: p.URL, token: p.Token}, nil
	}
	envURL, envToken := c.env.Getenv("WISP_URL"), c.env.Getenv("WISP_TOKEN")
	switch {
	case envURL != "" && envToken != "":
		base, err := parseWispURL(envURL)
		if err != nil {
			return nil, fmt.Errorf("WISP_URL: %w", err)
		}
		return &target{url: base, token: envToken}, nil
	case envURL != "":
		return nil, errors.New("WISP_URL is set without WISP_TOKEN: set both, or neither")
	case envToken != "":
		return nil, errors.New("WISP_TOKEN is set without WISP_URL: set both, or neither")
	}
	f, _, err := c.loadConfig()
	if err != nil {
		return nil, err
	}
	if f.Default == "" {
		if len(f.Profiles) > 0 {
			return nil, errors.New("no default profile: choose one with \"wisp --profile <name> default\", or name one with --profile")
		}
		return nil, errNotSignedIn
	}
	p := f.Profiles[f.Default]
	return &target{profile: f.Default, url: p.URL, token: p.Token}, nil
}

// client is the API client of the call's Wisp.
func (c *call) client() (*api.Client, error) {
	t, err := c.target()
	if err != nil {
		return nil, err
	}
	return api.New(t.url, t.token, c.env.Version), nil
}

// parseWispURL takes a Wisp's address: http or https, a host and maybe a
// port, and nothing else. It answers it as scheme://host[:port].
func parseWispURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil ||
		(u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("%q is not a Wisp's address: give its scheme, host and port, like http://wisp.local:8080", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}

// tokenScope is the scope a token was made with, as its prefix says:
// `wisp_<scope>_…` (docs/specs/AUTH.md, API tokens), and a token keeps it.
func tokenScope(token string) string {
	for _, scope := range []string{"read", "agent", "admin"} {
		if strings.HasPrefix(token, "wisp_"+scope+"_") {
			return scope
		}
	}
	return "unknown"
}
