// Package selfupdate puts a new binary in place of the running one, in one
// step that leaves the old binary in place when it fails (docs/specs/CLI.md,
// Version check). How a running program is replaced is per platform.
package selfupdate

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// VersionLinePrefix starts the first line `wisp version` prints, followed by
// the CLI's version: what proves a download is the CLI, and which one.
const VersionLinePrefix = "wisp CLI  "

// probeTimeout bounds the run that asks a download its version.
const probeTimeout = 10 * time.Second

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
// replace is a rename on one file system. It is executable, and named with
// exe's extension (Windows runs only a file named .exe), so it can be asked
// its version before it replaces exe.
func TempBeside(exe string) (*os.File, error) {
	f, err := os.CreateTemp(filepath.Dir(exe), ".wisp-update-*"+filepath.Ext(exe))
	if err != nil {
		return nil, fmt.Errorf("make a file for the download beside %s: %w", exe, err)
	}
	if err := f.Chmod(0o755); err != nil {
		f.Close()
		os.Remove(f.Name())
		return nil, fmt.Errorf("make %s executable: %w", f.Name(), err)
	}
	return f, nil
}

// VersionOf runs the binary at path as `wisp version`, with no environment
// (no profile, no Wisp to reach: it prints its own version and ends), and
// answers the version it says. Anything that does not say it is not the CLI.
func VersionOf(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Env = []string{}
	if root := os.Getenv("SYSTEMROOT"); root != "" {
		cmd.Env = append(cmd.Env, "SYSTEMROOT="+root) // what a Windows program needs to start
	}
	var out bytes.Buffer
	cmd.Stdout = &out
	runErr := cmd.Run() // it exits 1, having no Wisp: its first line is the answer
	line, _, _ := strings.Cut(out.String(), "\n")
	version, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), VersionLinePrefix)
	if !ok || version == "" || strings.ContainsAny(version, " \t") {
		if runErr != nil && out.Len() == 0 {
			return "", fmt.Errorf("the download does not run as the wisp CLI: %w", runErr)
		}
		return "", fmt.Errorf("the download does not answer as the wisp CLI: %q", firstLine(out.Bytes()))
	}
	return version, nil
}

func firstLine(b []byte) string {
	s := bufio.NewScanner(bytes.NewReader(b))
	if s.Scan() {
		return s.Text()
	}
	return ""
}
