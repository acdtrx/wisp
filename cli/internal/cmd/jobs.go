package cmd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/acdtrx/wisp/cli/internal/api"
)

func runJobsList(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var list struct {
		Jobs []struct {
			JobID   string `json:"jobId"`
			Kind    string `json:"kind"`
			Title   string `json:"title"`
			Status  string `json:"status"`
			Subject *struct {
				Type string `json:"type"`
				Name string `json:"name"`
			} `json:"subject"`
			CreatedAt float64 `json:"createdAt"`
		} `json:"jobs"`
	}
	body, err := client.GetJSON(ctx, "/api/jobs", nil, &list)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	if len(list.Jobs) == 0 {
		fmt.Fprintln(c.env.Stdout, "No jobs.")
		return nil
	}
	t := newTable(c.env.Stdout, "ID", "STATUS", "KIND", "SUBJECT", "STARTED", "TITLE")
	for _, j := range list.Jobs {
		subject := "—"
		if j.Subject != nil {
			subject = j.Subject.Type + " " + j.Subject.Name
		}
		t.row(j.JobID, j.Status, j.Kind, subject, epochText(j.CreatedAt), j.Title)
	}
	return t.flush()
}

// jobError is a job that ended with an error: its error event's code and
// message.
type jobError struct {
	code    string
	message string
}

func (e *jobError) Error() string { return e.code + ": " + e.message }

// errJobCancelled is a job a shutdown of the Wisp cut.
var errJobCancelled = errors.New("the job was cancelled: the Wisp stopped it as it shut down")

// jobEvent is one event of a job's progress stream (docs/specs/API.md, Job
// store contract).
type jobEvent struct {
	Step string `json:"step"`
	// What the step is about, for a job of many: an image's ref, a container's name.
	Ref     string          `json:"ref"`
	Name    string          `json:"name"`
	Percent *float64        `json:"percent"`
	Detail  string          `json:"detail"`
	Result  json.RawMessage `json:"result"`
	Error   string          `json:"error"`
}

// waitForJob prints the job's progress on standard error and answers its
// result when it is done.
func waitForJob(ctx context.Context, c *call, client *api.Client, jobID string) (json.RawMessage, error) {
	var result json.RawMessage
	var end error
	err := client.Stream(ctx, "/api/jobs/"+url.PathEscape(jobID)+"/progress", nil, func(data []byte) (bool, error) {
		var e jobEvent
		if err := json.Unmarshal(data, &e); err != nil {
			return false, fmt.Errorf("read the job's progress: %w", err)
		}
		switch e.Step {
		case "done":
			result = e.Result
			return true, nil
		case "error":
			end = &jobError{code: e.Error, message: e.Detail}
			return true, nil
		case "cancelled":
			end = errJobCancelled
			return true, nil
		}
		line := strings.Join(strings.Fields(e.Step+" "+e.Ref+" "+e.Name), " ")
		if e.Percent != nil {
			line += fmt.Sprintf(" %.0f%%", *e.Percent)
		}
		if e.Detail != "" {
			line += " " + e.Detail
		}
		fmt.Fprintln(c.env.Stderr, line)
		return false, nil
	})
	if err != nil && ctx.Err() != nil {
		return nil, fmt.Errorf("stopped waiting: the job %s goes on (\"wisp jobs wait %s\" waits again)", jobID, jobID)
	}
	if errors.Is(err, api.ErrStreamEnded) {
		return nil, fmt.Errorf("the Wisp ended the job's stream before the job's end: \"wisp jobs wait %s\" waits again", jobID)
	}
	if err != nil {
		return nil, err
	}
	return result, end
}

func runJobsWait(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	result, err := waitForJob(ctx, c, client, c.args[0])
	if err != nil {
		return err
	}
	if c.switches["json"] {
		if len(result) == 0 {
			result = json.RawMessage("null")
		}
		printJSON(c.env.Stdout, result)
		return nil
	}
	if len(result) == 0 || string(result) == "null" {
		fmt.Fprintln(c.env.Stdout, "Done.")
		return nil
	}
	fmt.Fprintln(c.env.Stdout, "Done:")
	fmt.Fprintln(c.env.Stdout, indentedJSON(result, "  "))
	return nil
}
