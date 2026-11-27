package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

func runImagesList(ctx context.Context, c *call) error {
	client, err := c.client()
	if err != nil {
		return err
	}
	var images []struct {
		Name    string  `json:"name"`
		Digest  string  `json:"digest"`
		Size    float64 `json:"size"`
		Updated *string `json:"updated"`
	}
	body, err := client.GetJSON(ctx, "/api/containers/images", nil, &images)
	if err != nil {
		return err
	}
	if c.switches["json"] {
		printJSON(c.env.Stdout, body)
		return nil
	}
	if len(images) == 0 {
		fmt.Fprintln(c.env.Stdout, "No images.")
		return nil
	}
	t := newTable(c.env.Stdout, "NAME", "SIZE", "UPDATED", "DIGEST")
	for _, img := range images {
		updated := "—"
		if img.Updated != nil {
			updated = timeText(*img.Updated)
		}
		t.row(img.Name, bytesText(img.Size), updated, shortDigest(img.Digest))
	}
	return t.flush()
}

// shortDigest is a digest's first 12 hex digits, as image tools show it.
func shortDigest(d string) string {
	_, hex, found := strings.Cut(d, ":")
	if !found || len(hex) < 12 {
		return d
	}
	return hex[:12]
}

func runImagesCheck(ctx context.Context, c *call) error {
	result, waited, err := runJobRequest(ctx, c, http.MethodPost, "/api/containers/images/check-updates", nil)
	if err != nil || !waited || c.switches["json"] {
		return err
	}
	var r struct {
		Checked           int `json:"checked"`
		Updated           int `json:"updated"`
		FlaggedContainers int `json:"flaggedContainers"`
	}
	if err := json.Unmarshal(result, &r); err != nil {
		return fmt.Errorf("read the job's result: %w", err)
	}
	fmt.Fprintf(c.env.Stdout, "Checked %s: %s a newer one, and %s an older one.\n", counted(r.Checked, "image", "images"),
		counted(r.Updated, "has", "have"), counted(r.FlaggedContainers, "container runs", "containers run"))
	if r.FlaggedContainers > 0 {
		fmt.Fprintln(c.env.Stdout, "\"wisp overview\" shows which; \"wisp containers update <name>\" moves one to the newer image.")
	}
	return nil
}

// counted is n and the word for it: one or many.
func counted(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}
