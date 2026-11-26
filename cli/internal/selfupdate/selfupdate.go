// Package selfupdate puts a new binary in place of the running one, in one
// step that leaves the old binary in place when it fails (docs/specs/CLI.md,
// Version check). How a running program is replaced is per platform.
package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
)

// Executable is the running program's file, its links followed: the file an
// update replaces.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find the running program: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("find the running program %s: %w", exe, err)
	}
	return resolved, nil
}

// TempBeside makes the file a download goes to, in exe's folder, so the
// replace is a rename on one file system.
func TempBeside(exe string) (*os.File, error) {
	f, err := os.CreateTemp(filepath.Dir(exe), ".wisp-update-*")
	if err != nil {
		return nil, fmt.Errorf("make a file for the download beside %s: %w", exe, err)
	}
	return f, nil
}
