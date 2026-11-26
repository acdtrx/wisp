//go:build windows

package term

import (
	"fmt"
	"os"
	"syscall"
)

var procSetConsoleMode = syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode")

// enableEchoInput is the console mode's ENABLE_ECHO_INPUT.
const enableEchoInput = 0x0004

func setConsoleMode(h syscall.Handle, mode uint32) error {
	if r, _, err := procSetConsoleMode.Call(uintptr(h), uintptr(mode)); r == 0 {
		return err
	}
	return nil
}

// IsTerminal says whether f is a console.
func IsTerminal(f *os.File) bool {
	var mode uint32
	return syscall.GetConsoleMode(syscall.Handle(f.Fd()), &mode) == nil
}

// ReadHidden reads one line from the console f with its echo off.
func ReadHidden(f *os.File) (string, error) {
	h := syscall.Handle(f.Fd())
	var old uint32
	if err := syscall.GetConsoleMode(h, &old); err != nil {
		return "", fmt.Errorf("read the console: %w", err)
	}
	if err := setConsoleMode(h, old&^enableEchoInput); err != nil {
		return "", fmt.Errorf("turn the console's echo off: %w", err)
	}
	return readLineRestoring(f, func() { _ = setConsoleMode(h, old) }) // restoring is best effort: the line is read either way
}
