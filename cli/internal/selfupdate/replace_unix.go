//go:build !windows

package selfupdate

import (
	"fmt"
	"os"
)

// Replace puts the file at next in place of exe: made executable, then
// renamed over it, which a running program allows.
func Replace(exe, next string) error {
	if err := os.Chmod(next, 0o755); err != nil {
		return fmt.Errorf("make %s executable: %w", next, err)
	}
	if err := os.Rename(next, exe); err != nil {
		return fmt.Errorf("put the new binary in place of %s: %w", exe, err)
	}
	return nil
}

// RemoveLeftover has nothing to do here: a rename leaves no old binary.
func RemoveLeftover(string) {}
