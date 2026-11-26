// Package config is the CLI's one file, its profiles (docs/specs/CLI.md,
// Profiles): written by the CLI only, read strictly.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

// FileVersion is the shape this CLI reads and writes.
const FileVersion = 1

// FileName is the file's name in the configuration folder.
const FileName = "config.json"

// Profile is one Wisp: its address and an API token.
type Profile struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

// File is config.json.
type File struct {
	Version  int                `json:"version"`
	Default  string             `json:"default,omitempty"`
	Profiles map[string]Profile `json:"profiles"`
}

var namePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidName says whether name may name a profile: letters, digits, dot,
// dash and underscore, starting with a letter or a digit, up to 64.
func ValidName(name string) bool { return namePattern.MatchString(name) }

// Path is config.json's path in dir.
func Path(dir string) string { return filepath.Join(dir, FileName) }

// Load reads the file at path; a missing file is an empty one. Anything
// but the shape this CLI writes is an error, never a guess.
func Load(path string) (*File, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return &File{Version: FileVersion, Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var f File
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	if f.Version != FileVersion {
		return nil, fmt.Errorf("read %s: version %d, and this CLI reads version %d", path, f.Version, FileVersion)
	}
	if f.Profiles == nil {
		f.Profiles = map[string]Profile{}
	}
	for name, p := range f.Profiles {
		if !ValidName(name) || p.URL == "" || p.Token == "" {
			return nil, fmt.Errorf("read %s: profile %q needs a name, a url and a token", path, name)
		}
	}
	if _, ok := f.Profiles[f.Default]; f.Default != "" && !ok {
		return nil, fmt.Errorf("read %s: the default profile %q is not in it", path, f.Default)
	}
	return &f, nil
}

// Names are the profiles' names, sorted.
func (f *File) Names() []string {
	names := make([]string, 0, len(f.Profiles))
	for name := range f.Profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Save writes the file at path, mode 0600 in a 0700 folder, by a rename
// over the old one: a failed write leaves the old file whole.
func (f *File) Save(path string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("make %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("set the mode of %s: %w", dir, err)
	}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode %s: %w", path, err)
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	defer os.Remove(tmp.Name()) // gone after the rename; removes what a failure left
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
