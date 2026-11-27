package folderzip

import (
	"archive/zip"
	"bytes"
	"io"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestAFolderIsZippedAsItIs(t *testing.T) {
	when := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	big := bytes.Repeat([]byte("0123456789abcdef"), 1<<16) // 1 MiB
	fsys := fstest.MapFS{
		"index.html":            {Data: []byte("<h1>hi</h1>"), Mode: 0o644, ModTime: when},
		"assets/css/site.css":   {Data: []byte("body{}"), Mode: 0o644, ModTime: when},
		"assets/img/big.bin":    {Data: big, Mode: 0o600, ModTime: when},
		"empty":                 {Mode: fs.ModeDir | 0o755, ModTime: when},
		"bin/run.sh":            {Data: []byte("#!/bin/sh\n"), Mode: 0o755, ModTime: when},
		"deep/a/b/c/d/leaf.txt": {Data: []byte("leaf"), Mode: 0o644, ModTime: when},
	}
	entries, err := List(fsys)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Write(&out, fsys, entries); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]*zip.File{}
	for _, f := range zr.File {
		if strings.Contains(f.Name, "\\") || strings.HasPrefix(f.Name, "/") || strings.HasPrefix(f.Name, ".") {
			t.Errorf("entry %q is not a relative, slash-separated path", f.Name)
		}
		got[f.Name] = f
	}
	for _, dir := range []string{"assets/", "assets/css/", "assets/img/", "empty/", "bin/", "deep/a/b/c/d/"} {
		if f, ok := got[dir]; !ok || !f.Mode().IsDir() {
			t.Errorf("no folder %s", dir)
		}
	}
	for name, file := range fsys {
		if file.Mode.IsDir() {
			continue
		}
		f, ok := got[name]
		if !ok {
			t.Errorf("no file %s", name)
			continue
		}
		rc, _ := f.Open()
		data, _ := io.ReadAll(rc)
		rc.Close()
		if !bytes.Equal(data, file.Data) || f.Mode().Perm() != file.Mode.Perm() || !f.Modified.Equal(when) {
			t.Errorf("%s: %d bytes, mode %v, time %v", name, len(data), f.Mode(), f.Modified)
		}
	}
	if len(zr.File) != len(fsys)+9 { // the files and the empty folder, and the nine folders the paths imply
		t.Errorf("%d entries", len(zr.File))
	}
}

func TestWhatAZipCannotHoldIsRefusedBeforeAnythingIsSent(t *testing.T) {
	fsys := fstest.MapFS{
		"ok.txt": {Data: []byte("x")},
		"fifo":   {Mode: fs.ModeNamedPipe},
	}
	if _, err := List(fsys); err == nil || !strings.Contains(err.Error(), "fifo") {
		t.Fatalf("got %v", err)
	}
}
