package selfupdate

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplacePutsTheNewFileInPlace(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "wisp.exe")
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	next, err := TempBeside(exe)
	if err != nil {
		t.Fatal(err)
	}
	next.WriteString("new")
	next.Close()
	if err := Replace(exe, next.Name()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new" {
		t.Fatalf("exe holds %q", got)
	}
	RemoveLeftover(exe)
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("%d files left beside the binary", len(entries))
	}
}

func TestAFailedReplaceLeavesTheOldFile(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "wisp.exe")
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := Replace(exe, filepath.Join(dir, "no-such-download")); err == nil {
		t.Fatal("replaced with nothing")
	}
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("exe holds %q", got)
	}
}
