// Package folderzip writes a folder as a zip, as it is read, so a folder is
// sent to a folder mount with nothing installed beside the CLI
// (docs/specs/CLI.md, containers upload).
package folderzip

import (
	"archive/zip"
	"fmt"
	"io"
	"io/fs"
)

// Entry is one thing the zip holds: a folder, or a file's content.
type Entry struct {
	Path string // slash-separated, relative to the folder: io/fs's own form, whatever the platform
	Dir  bool
}

// List walks fsys, the folder, and answers what its zip holds: every folder
// (an empty one too) and every file, a symbolic link to a file as that
// file. Anything else (a link to a folder, a device, a socket) is an error
// that names it, before anything is sent.
func List(fsys fs.FS) ([]Entry, error) {
	var entries []Entry
	err := fs.WalkDir(fsys, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == "." {
			return nil
		}
		mode := d.Type()
		if mode&fs.ModeSymlink != 0 {
			info, err := fs.Stat(fsys, path)
			if err != nil {
				return fmt.Errorf("%s: %w", path, err)
			}
			mode = info.Mode().Type()
			if mode.IsDir() {
				return fmt.Errorf("%s is a symbolic link to a folder, which a zip cannot hold: copy the folder in its place", path)
			}
		}
		switch {
		case mode.IsDir():
			entries = append(entries, Entry{Path: path, Dir: true})
		case mode.IsRegular():
			entries = append(entries, Entry{Path: path})
		default:
			return fmt.Errorf("%s is not a file or a folder (%s), and is not sent", path, mode)
		}
		return nil
	})
	return entries, err
}

// Write writes entries of fsys to w as a zip, each file's content read from
// what read answers for its path, as it is written: a folder's entry ends
// with "/", and each keeps its mode and its time.
func Write(w io.Writer, fsys fs.FS, entries []Entry, read func(path string) io.Reader) error {
	zw := zip.NewWriter(w)
	for _, e := range entries {
		if err := writeEntry(zw, fsys, e, read); err != nil {
			return err
		}
	}
	return zw.Close()
}

func writeEntry(zw *zip.Writer, fsys fs.FS, e Entry, read func(path string) io.Reader) error {
	info, err := fs.Stat(fsys, e.Path)
	if err != nil {
		return fmt.Errorf("%s: %w", e.Path, err)
	}
	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return fmt.Errorf("%s: %w", e.Path, err)
	}
	header.Name = e.Path
	if e.Dir {
		header.Name += "/"
		header.Method = zip.Store
		_, err := zw.CreateHeader(header)
		return err
	}
	header.Method = zip.Deflate
	dst, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}
	n, err := io.Copy(dst, read(e.Path))
	if err != nil {
		return fmt.Errorf("%s: %w", e.Path, err)
	}
	if n != info.Size() {
		return fmt.Errorf("%s changed while it was sent: %d bytes read of %d", e.Path, n, info.Size())
	}
	return nil
}
