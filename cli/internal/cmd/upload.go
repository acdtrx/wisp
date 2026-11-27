package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/acdtrx/wisp/cli/internal/api"
	"github.com/acdtrx/wisp/cli/internal/folderzip"
	"github.com/acdtrx/wisp/cli/internal/term"
)

// fileSource reads the file at path under the upload's bound: a read that
// blocks (a FIFO, a process substitution, a stalled network share) ends the
// upload when the bound does (term.SourceWithin).
func (c *call) fileSource(ctx context.Context, path string) io.Reader {
	return term.SourceWithin(ctx, path, func() (io.ReadCloser, error) { return os.Open(path) }, c.env.UploadIdle)
}

// copyFile is an upload's writer for the file at path.
func (c *call) copyFile(path string) func(context.Context, io.Writer) error {
	return func(ctx context.Context, w io.Writer) error {
		if _, err := io.Copy(w, c.fileSource(ctx, path)); err != nil {
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
	var entries []folderzip.Entry
	if info.IsDir() {
		if entries, err = folderzip.List(os.DirFS(path)); err != nil {
			return fmt.Errorf("nothing sent: %w", err)
		}
		if len(entries) == 0 {
			return usagef(c.cmd.Path, "nothing to send: %s is an empty folder", path)
		}
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
		if _, err := client.Upload(ctx, containerPath(name, "mounts", mount, "file"), filepath.Base(path), c.copyFile(path)); err != nil {
			return err
		}
		fmt.Fprintf(c.env.Stdout, "Wrote %s to mount %q of %s.\n", path, mount, name)
		return nil
	}
	write, fileName := c.copyFile(path), filepath.Base(path)
	if info.IsDir() {
		fsys := os.DirFS(path)
		write = func(ctx context.Context, w io.Writer) error {
			return folderzip.Write(w, fsys, entries, func(rel string) io.Reader {
				return c.fileSource(ctx, filepath.Join(path, filepath.FromSlash(rel)))
			})
		}
		// The folder's own name, also for "." or "dir/".
		abs, err := filepath.Abs(path)
		if err != nil {
			return fmt.Errorf("nothing sent: %w", err)
		}
		fileName = filepath.Base(abs) + ".zip"
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
	write, fileName := c.copyFile(path), filepath.Base(path)
	if path == "-" {
		write = func(ctx context.Context, w io.Writer) error {
			if _, err := io.Copy(w, term.ReaderWithin(ctx, c.env.Stdin, c.env.UploadIdle)); err != nil {
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
