package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
)

// printJSON prints an API answer as it came, ending with a newline.
func printJSON(w io.Writer, body []byte) {
	fmt.Fprintln(w, string(bytes.TrimSpace(body)))
}

// table writes rows under a header, columns aligned.
type table struct {
	tw *tabwriter.Writer
}

func newTable(w io.Writer, header ...string) *table {
	t := &table{tw: tabwriter.NewWriter(w, 0, 8, 2, ' ', 0)}
	t.row(header...)
	return t
}

func (t *table) row(cells ...string) {
	fmt.Fprintln(t.tw, strings.Join(cells, "\t"))
}

func (t *table) flush() error { return t.tw.Flush() }

// labelled writes `Label:  value` lines, values aligned.
type labelled struct {
	tw *tabwriter.Writer
}

func newLabelled(w io.Writer) *labelled {
	return &labelled{tw: tabwriter.NewWriter(w, 0, 8, 2, ' ', 0)}
}

func (l *labelled) line(label, value string) {
	fmt.Fprintf(l.tw, "%s:\t%s\n", label, value)
}

func (l *labelled) flush() error { return l.tw.Flush() }

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

// bytesText is a size in bytes, for reading.
func bytesText(n float64) string {
	units := []string{"B", "KiB", "MiB", "GiB", "TiB"}
	i := 0
	for n >= 1024 && i < len(units)-1 {
		n /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f %s", n, units[i])
	}
	return fmt.Sprintf("%.1f %s", n, units[i])
}

// durationText is a length of time in seconds, to the minute past an hour.
func durationText(seconds float64) string {
	d := time.Duration(seconds) * time.Second
	switch {
	case d < time.Minute:
		return d.String()
	case d < time.Hour:
		return d.Truncate(time.Second).String()
	default:
		return d.Truncate(time.Minute).String()
	}
}

// timeText is an ISO-8601 time, in local time.
func timeText(iso string) string {
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		return iso
	}
	return t.Local().Format("2006-01-02 15:04:05")
}

// epochText is an epoch-milliseconds time, in local time.
func epochText(ms float64) string {
	return time.UnixMilli(int64(ms)).Local().Format("2006-01-02 15:04:05")
}

// indentedJSON is a JSON value, indented by prefix, for a block of its own.
func indentedJSON(raw json.RawMessage, prefix string) string {
	var out bytes.Buffer
	if err := json.Indent(&out, raw, prefix, "  "); err != nil {
		return prefix + string(raw)
	}
	return prefix + out.String()
}

// shellWords joins a command's argv as a shell would read it back.
func shellWords(argv []string) string {
	words := make([]string, len(argv))
	for i, a := range argv {
		if a != "" && !strings.ContainsAny(a, " \t\n'\"\\$`;&|<>()*?[]{}!#~") {
			words[i] = a
			continue
		}
		words[i] = "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
	}
	return strings.Join(words, " ")
}
