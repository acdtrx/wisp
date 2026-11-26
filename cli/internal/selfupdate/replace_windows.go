//go:build windows

package selfupdate

import (
	"fmt"
	"os"
)

// Windows refuses to write over a running program, but lets it be renamed:
// the running one moves aside to <exe>.old, the new one takes its name, and
// the next run removes the old one.
func leftover(exe string) string { return exe + ".old" }

// Replace puts the file at next in place of exe; on a failure exe is as it
// was.
func Replace(exe, next string) error {
	old := leftover(exe)
	_ = os.Remove(old) // a leftover of an earlier update, if any: the rename below says if it is in the way
	if err := os.Rename(exe, old); err != nil {
		return fmt.Errorf("move %s aside: %w", exe, err)
	}
	if err := os.Rename(next, exe); err != nil {
		if back := os.Rename(old, exe); back != nil {
			return fmt.Errorf("put the new binary in place of %s: %w (and the old one is now %s: %v)", exe, err, old, back)
		}
		return fmt.Errorf("put the new binary in place of %s: %w", exe, err)
	}
	return nil
}

// RemoveLeftover removes the binary an update moved aside, once it no longer
// runs.
func RemoveLeftover(exe string) {
	_ = os.Remove(leftover(exe)) // none there, or still in use by a program that runs: the next run tries again
}
