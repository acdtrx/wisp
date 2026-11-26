//go:build windows

package config

import (
	"errors"
	"path/filepath"
)

// Dir is the configuration folder: %AppData%\wisp.
func Dir(getenv func(string) string) (string, error) {
	appData := getenv("APPDATA")
	if !filepath.IsAbs(appData) {
		return "", errors.New("find the configuration folder: %AppData% is not set")
	}
	return filepath.Join(appData, "wisp"), nil
}
