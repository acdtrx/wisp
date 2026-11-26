package term

import (
	"os"
	"strings"
	"testing"
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
