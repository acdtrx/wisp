//go:build darwin || linux

package term

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func getState(fd int) (*syscall.Termios, error) {
	var t syscall.Termios
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), ioctlGetTermios, uintptr(unsafe.Pointer(&t))); errno != 0 {
		return nil, errno
	}
	return &t, nil
}

func setState(fd int, t *syscall.Termios) error {
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), ioctlSetTermios, uintptr(unsafe.Pointer(t))); errno != 0 {
		return errno
	}
	return nil
}

// IsTerminal says whether f is a terminal.
func IsTerminal(f *os.File) bool {
	_, err := getState(int(f.Fd()))
	return err == nil
}

// ReadHidden reads one line from the terminal f with its echo off.
func ReadHidden(f *os.File) (string, error) {
	fd := int(f.Fd())
	old, err := getState(fd)
	if err != nil {
		return "", fmt.Errorf("read the terminal: %w", err)
	}
	hidden := *old
	hidden.Lflag &^= syscall.ECHO
	hidden.Lflag |= syscall.ICANON | syscall.ISIG
	hidden.Iflag |= syscall.ICRNL
	if err := setState(fd, &hidden); err != nil {
		return "", fmt.Errorf("turn the terminal's echo off: %w", err)
	}
	return readLineRestoring(f, func() { _ = setState(fd, old) }) // restoring is best effort: the line is read either way
}
