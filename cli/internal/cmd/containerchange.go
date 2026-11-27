package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/acdtrx/wisp/cli/internal/api"
)

// jobAck is the answer of a request that starts a job (docs/specs/API.md,
// Background jobs).
type jobAck struct {
	JobID string `json:"jobId"`
	Title string `json:"title"`
}

// startedJob reads a job's ack, the answer of a request that started one.
// With --no-wait it prints the job's id (with --json, the ack) and answers
// a nil result and false; else it waits for the job, printing its progress,
// and answers its result and true. With --json the result is printed as it
// came.
func startedJob(ctx context.Context, c *call, client *api.Client, body []byte) (json.RawMessage, bool, error) {
	var ack jobAck
	if err := json.Unmarshal(body, &ack); err != nil || ack.JobID == "" {
		return nil, false, &api.NotWispError{URL: client.Base(), Reason: "its answer is not a job's ack"}
	}
	if c.switches["no-wait"] {
		if c.switches["json"] {
			printJSON(c.env.Stdout, body)
		} else {
			fmt.Fprintln(c.env.Stdout, ack.JobID)
		}
		return nil, false, nil
	}
	fmt.Fprintf(c.env.Stderr, "%s: job %s\n", ack.Title, ack.JobID)
	result, err := waitForJob(ctx, c, client, ack.JobID)
	if err != nil {
		return nil, false, err
	}
	if c.switches["json"] {
		if len(result) == 0 {
			result = json.RawMessage("null")
		}
		printJSON(c.env.Stdout, result)
	}
	return result, true, nil
}

// runJobRequest sends the request that starts a job, then as startedJob.
func runJobRequest(ctx context.Context, c *call, method, path string, v any) (json.RawMessage, bool, error) {
	client, err := c.client()
	if err != nil {
		return nil, false, err
	}
	body, err := client.Send(ctx, method, path, v)
	if err != nil {
		return nil, false, err
	}
	return startedJob(ctx, c, client, body)
}

func runContainersCreate(ctx context.Context, c *call) error {
	body, err := c.deployBody()
	if err != nil {
		return err
	}
	result, waited, err := runJobRequest(ctx, c, http.MethodPost, "/api/containers/deploy", body)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	var d containerDetail
	if err := json.Unmarshal(result, &d); err != nil {
		return fmt.Errorf("read the job's result: %w", err)
	}
	printContainer(c, &d)
	return nil
}

// lifecycleCommand is `containers start`, `stop` or `restart`: the route's
// job, and what the command prints once it is done.
func lifecycleCommand(route, done string) func(ctx context.Context, c *call) error {
	return func(ctx context.Context, c *call) error {
		name := c.args[0]
		result, waited, err := runJobRequest(ctx, c, http.MethodPost, containerPath(name, route), nil)
		if err != nil || !waited || c.switches["json"] {
			return err
		}
		var r struct {
			RestartCancelled bool `json:"restartCancelled"`
		}
		_ = json.Unmarshal(result, &r) // the line below needs only the name: a result without the flag still says it
		if r.RestartCancelled {
			fmt.Fprintf(c.env.Stdout, "%s was not running: its scheduled restart is cancelled.\n", name)
			return nil
		}
		fmt.Fprintf(c.env.Stdout, "%s %s.\n", done, name)
		return nil
	}
}

func runContainersSet(ctx context.Context, c *call) error {
	name := c.args[0]
	body, err := c.patchBody()
	if err != nil {
		return err
	}
	mounts, err := c.mounts()
	if err != nil {
		return err
	}
	if _, ok := c.values["app-config"]; ok && (len(body) > 0 || len(mounts) > 0) {
		return usagef(c.cmd.Path, "--app-config goes alone: the Wisp saves an app's config with no other setting")
	}
	appConfig, err := c.appConfig(ctx)
	if err != nil {
		return err
	}
	if len(body) == 0 && len(mounts) == 0 && appConfig == nil {
		return usagef(c.cmd.Path, "nothing to change: give a setting's flag")
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	if appConfig != nil {
		if _, err := client.Send(ctx, http.MethodPatch, containerPath(name), map[string]any{"appConfig": appConfig}); err != nil {
			return err
		}
		fmt.Fprintf(c.env.Stdout, "Saved the app config of %s.\n", name)
		return nil
	}
	// The settings and env as one request, then each mount: the first that
	// fails ends the command, which says what was saved before it.
	var saved []string
	if len(body) > 0 {
		if _, err := client.Send(ctx, http.MethodPatch, containerPath(name), body); err != nil {
			return err
		}
		saved = append(saved, "the settings")
		fmt.Fprintf(c.env.Stdout, "Saved the settings of %s.\n", name)
	}
	for _, m := range mounts {
		if _, err := client.Send(ctx, http.MethodPost, containerPath(name, "mounts"), m); err != nil {
			if len(saved) == 0 {
				return err
			}
			return &partialError{saved: saved, failed: fmt.Sprintf("mount %q", m["name"]), err: err}
		}
		saved = append(saved, fmt.Sprintf("mount %q", m["name"]))
		fmt.Fprintf(c.env.Stdout, "Added mount %q to %s.\n", m["name"], name)
	}
	fmt.Fprintln(c.env.Stdout, "A change a running container cannot take waits for its restart: \"wisp containers show\" says when one does.")
	return nil
}

// partialError is a command of several requests that failed after some were
// done: what was saved, then the request that failed and its error.
type partialError struct {
	saved  []string
	failed string
	err    error
}

func (e *partialError) Error() string {
	return fmt.Sprintf("saved before the failure: %s; then %s: %v", strings.Join(e.saved, ", "), e.failed, e.err)
}

func (e *partialError) Unwrap() error { return e.err }

func runContainersUpdate(ctx context.Context, c *call) error {
	name := c.args[0]
	body := map[string]any{}
	if image, ok := c.values["image"]; ok {
		body["image"] = image
	}
	result, waited, err := runJobRequest(ctx, c, http.MethodPost, containerPath(name, "image-update"), body)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	var r struct {
		Image string `json:"image"`
		Note  string `json:"note"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return fmt.Errorf("read the job's result: %w", err)
	}
	fmt.Fprintf(c.env.Stdout, "%s is on %s. %s\n", name, r.Image, r.Note)
	return nil
}
