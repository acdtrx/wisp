//go:build !windows

package config

import "testing"

func TestDirFollowsXDG(t *testing.T) {
	env := map[string]string{"HOME": "/home/u", "XDG_CONFIG_HOME": "/xdg"}
	getenv := func(k string) string { return env[k] }
	if dir, _ := Dir(getenv); dir != "/xdg/wisp" {
		t.Fatalf("got %s", dir)
	}
	env["XDG_CONFIG_HOME"] = "relative"
	if dir, _ := Dir(getenv); dir != "/home/u/.config/wisp" {
		t.Fatalf("got %s", dir)
	}
	delete(env, "XDG_CONFIG_HOME")
	if dir, _ := Dir(getenv); dir != "/home/u/.config/wisp" {
		t.Fatalf("got %s", dir)
	}
	if _, err := Dir(func(string) string { return "" }); err == nil {
		t.Fatal("no HOME, and a folder anyway")
	}
}
