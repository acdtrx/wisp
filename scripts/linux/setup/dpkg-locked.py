"""dpkg-locked.py <secs> <cmd...>: cmd run holding dpkg's frontend lock, the
way apt runs dpkg, for the packages step; run as root with lib.sh's SETUP_PYTHON. dpkg
itself has no wait for a lock another package run holds (apt's
DPkg::Lock::Timeout is apt's own): this waits up to <secs> for it, then runs
cmd with DPKG_FRONTEND_LOCKED=1, which tells dpkg the lock is held for it.
Exits with cmd's status, or 75 when the lock stayed held.
"""
import fcntl
import os
import signal
import subprocess
import sys

LOCK = '/var/lib/dpkg/lock-frontend'


def timed_out(*_):
    raise TimeoutError


secs = int(sys.argv[1])
fd = os.open(LOCK, os.O_RDWR | os.O_CREAT, 0o640)
signal.signal(signal.SIGALRM, timed_out)
signal.alarm(secs)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX)
except TimeoutError:
    print(f'ERROR: another package run held {LOCK} for {secs} s', file=sys.stderr)
    sys.exit(75)
signal.alarm(0)
sys.exit(subprocess.run(sys.argv[2:], env={**os.environ, 'DPKG_FRONTEND_LOCKED': '1'}).returncode)
