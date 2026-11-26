//go:build !windows

package config

import (
	"errors"
	"path/filepath"
)

// Dir is the configuration folder: $XDG_CONFIG_HOME/wisp, by default
// ~/.config/wisp, on macOS as on Linux.
func Dir(getenv func(string) string) (string, error) {
	if xdg := getenv("XDG_CONFIG_HOME"); filepath.IsAbs(xdg) {
		return filepath.Join(xdg, "wisp"), nil
	}
	home := getenv("HOME")
	if !filepath.IsAbs(home) {
		return "", errors.New("find the configuration folder: neither XDG_CONFIG_HOME nor HOME is set")
	}
	return filepath.Join(home, ".config", "wisp"), nil
}
