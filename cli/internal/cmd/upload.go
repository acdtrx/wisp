package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/folderzip"
	"github.com/acdtrx/wisp/cli/internal/term"
)

// stdinIdle bounds the wait for an archive on standard input, as the Wisp
// bounds an upload's.
const stdinIdle = 60 * time.Second

// copyFile is an upload's writer for the file at path.
func copyFile(path string) func(io.Writer) error {
	return func(w io.Writer) error {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		if _, err := io.Copy(w, f); err != nil {
			return fmt.Errorf("read %s: %w", path, err)
		}
		return nil
	}
}

func runContainersUpload(ctx context.Context, c *call) error {
	name, mount, path := c.args[0], c.args[1], c.args[2]
	info, err := os.Stat(path)
	if err != nil {
		return usagef(c.cmd.Path, "%s", err)
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	// A folder goes to the zip route, zipped as it is sent; a file to the
	// zip route when the mount is a folder, else to the file route. What the
	// mount takes is the Wisp's to refuse.
	toZip := info.IsDir()
	if !toZip {
		var d containerDetail
		if _, err := client.GetJSON(ctx, containerPath(name), nil, &d); err != nil {
			return err
		}
		for _, m := range d.Mounts {
			if m.Name == mount && m.Type == "directory" {
				toZip = true
			}
		}
	}
	if !toZip {
		if _, err := client.Upload(ctx, containerPath(name, "mounts", mount, "file"), filepath.Base(path), copyFile(path)); err != nil {
			return err
		}
		fmt.Fprintf(c.env.Stdout, "Wrote %s to mount %q of %s.\n", path, mount, name)
		return nil
	}
	write, fileName := copyFile(path), filepath.Base(path)
	if info.IsDir() {
		fsys := os.DirFS(path)
		entries, err := folderzip.List(fsys)
		if err != nil {
			return fmt.Errorf("nothing sent: %w", err)
		}
		write = func(w io.Writer) error { return folderzip.Write(w, fsys, entries) }
		fileName = filepath.Base(filepath.Clean(path)) + ".zip"
	}
	ack, err := client.Upload(ctx, containerPath(name, "mounts", mount, "zip"), fileName, write)
	if err != nil {
		return err
	}
	_, waited, err := startedJob(ctx, c, client, ack)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Replaced the content of mount %q of %s with %s.\n", mount, name, path)
	return nil
}

func runImagesPush(ctx context.Context, c *call) error {
	path := c.args[0]
	write, fileName := copyFile(path), filepath.Base(path)
	if path == "-" {
		stdin := term.ReaderWithin(ctx, c.env.Stdin, stdinIdle)
		write = func(w io.Writer) error {
			if _, err := io.Copy(w, stdin); err != nil {
				return fmt.Errorf("read the archive on standard input: %w", err)
			}
			return nil
		}
		fileName = "stdin.tar"
	} else if _, err := os.Stat(path); err != nil {
		return usagef(c.cmd.Path, "%s", err)
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	ack, err := client.Upload(ctx, "/api/containers/images/upload", fileName, write)
	if err != nil {
		return err
	}
	result, waited, err := startedJob(ctx, c, client, ack)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	var r struct {
		Images []struct {
			Name string `json:"name"`
		} `json:"images"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return &api.NotWispError{URL: client.Base(), Reason: "the import's result is not the images it stored"}
	}
	for _, img := range r.Images {
		fmt.Fprintln(c.env.Stdout, img.Name)
	}
	return nil
}
