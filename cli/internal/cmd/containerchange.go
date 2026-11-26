package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

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
	if len(body) == 0 {
		return usagef(c.cmd.Path, "nothing to change: give a setting's flag")
	}
	client, err := c.client()
	if err != nil {
		return err
	}
	if _, err := client.Send(ctx, http.MethodPatch, containerPath(name), body); err != nil {
		return err
	}
	fmt.Fprintf(c.env.Stdout, "Saved the settings of %s. A change a running container cannot take waits for its restart: \"wisp containers show\" says when one does.\n", name)
	return nil
}

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
