package term

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func TestReadLine(t *testing.T) {
	for in, want := range map[string]string{
		"wisp_agent_x\nrest": "wisp_agent_x",
		"wisp_agent_x\r\n":   "wisp_agent_x",
		"no newline":         "no newline",
		"":                   "",
	} {
		r := strings.NewReader(in)
		got, err := ReadLine(r)
		if err != nil || got != want {
			t.Errorf("ReadLine(%q) = %q, %v", in, got, err)
		}
		if in == "wisp_agent_x\nrest" && r.Len() != 4 {
			t.Errorf("read past the line: %d bytes left", r.Len())
		}
	}
	if _, err := ReadLine(strings.NewReader(strings.Repeat("a", maxLine+1))); err == nil {
		t.Error("a line over the bound was read")
	}
}

func TestAFileIsNoTerminal(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "x")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if IsTerminal(f) {
		t.Fatal("a file is a terminal")
	}
	if _, err := ReadHidden(f); err == nil {
		t.Fatal("hidden read from a file")
	}
}

func TestReadLineWithinGivesUp(t *testing.T) {
	pr, pw := io.Pipe()
	defer pw.Close()
	if _, err := ReadLineWithin(pr, 50*time.Millisecond); !errors.Is(err, ErrNoLine) {
		t.Fatalf("got %v", err)
	}
	if got, err := ReadLineWithin(strings.NewReader("tok\n"), time.Second); got != "tok" || err != nil {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestReaderWithinReadsToTheEndOrGivesUp(t *testing.T) {
	got, err := io.ReadAll(ReaderWithin(context.Background(), strings.NewReader(strings.Repeat("x", 200<<10)), time.Second))
	if err != nil || len(got) != 200<<10 {
		t.Fatalf("read %d bytes, %v", len(got), err)
	}
	pr, pw := io.Pipe()
	defer pw.Close()
	go pw.Write([]byte("some"))
	r := ReaderWithin(context.Background(), pr, 50*time.Millisecond)
	got, err = io.ReadAll(r)
	var stalled *StalledError
	if string(got) != "some" || !errors.As(err, &stalled) {
		t.Fatalf("read %q, %v", got, err)
	}
}
