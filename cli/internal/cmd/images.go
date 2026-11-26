package cmd

import (
	"context"
	"fmt"
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
