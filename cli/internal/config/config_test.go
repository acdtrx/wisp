package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLoadMissingIsEmpty(t *testing.T) {
	f, err := Load(filepath.Join(t.TempDir(), "wisp", FileName))
	if err != nil {
		t.Fatal(err)
	}
	if f.Version != FileVersion || len(f.Profiles) != 0 || f.Default != "" {
		t.Fatalf("got %+v", f)
	}
}

func TestSaveThenLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wisp", FileName)
	f := &File{Version: FileVersion, Default: "home", Profiles: map[string]Profile{
		"home": {URL: "http://home:8080", Token: "wisp_agent_a"},
		"tini": {URL: "http://tini.local:8080", Token: "wisp_read_b"},
	}}
	if err := f.Save(path); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got.Default != "home" || got.Profiles["tini"].Token != "wisp_read_b" || strings.Join(got.Names(), ",") != "home,tini" {
		t.Fatalf("got %+v", got)
	}
	if runtime.GOOS == "windows" {
		return
	}
	for p, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
		st, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != want {
			t.Errorf("%s: mode %v, want %v", p, st.Mode().Perm(), want)
		}
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("the folder holds %d files, want config.json alone", len(entries))
	}
}

func TestSaveTightensAWiderFolder(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no Unix modes")
	}
	dir := filepath.Join(t.TempDir(), "wisp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := (&File{Version: FileVersion, Profiles: map[string]Profile{}}).Save(Path(dir)); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(dir)
	if st.Mode().Perm() != 0o700 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}

func TestLoadIsStrict(t *testing.T) {
	cases := map[string]string{
		"unknown key":     `{"version":1,"profiles":{},"extra":true}`,
		"other version":   `{"version":2,"profiles":{}}`,
		"profile no url":  `{"version":1,"profiles":{"a":{"url":"","token":"t"}}}`,
		"profile bad key": `{"version":1,"profiles":{"a":{"url":"u","token":"t","scope":"read"}}}`,
		"missing default": `{"version":1,"default":"b","profiles":{"a":{"url":"u","token":"t"}}}`,
		"bad name":        `{"version":1,"profiles":{"-a":{"url":"u","token":"t"}}}`,
		"not json":        `version: 1`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), FileName)
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("loaded")
			}
		})
	}
}

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"default": true, "tini": true, "home.lab": true, "a_b-c": true, "9": true,
		"": false, "-x": false, ".x": false, "a b": false, "a/b": false, strings.Repeat("a", 65): false,
	} {
		if ValidName(name) != want {
			t.Errorf("ValidName(%q) = %v", name, !want)
		}
	}
}
