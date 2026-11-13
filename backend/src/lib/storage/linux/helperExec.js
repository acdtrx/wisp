/**
 * Run the wisp-mount helper (through sudo unless already root) with a timeout
 * (CODING-RULES §6). execFile's `timeout` signals sudo, and the promise settles
 * once sudo exits. The extra timer is a fallback for a sudo that doesn't exit
 * on the signal: `graceMs` after the timeout it kills sudo and rejects. The
 * helper bounds its own mount and umount (backend/scripts/wisp-mount), so a
 * child it started never outlives it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function execHelper(scriptPath, args, { timeout, graceMs = 5_000 }) {
  const isRoot = process.getuid && process.getuid() === 0;
  const pending = isRoot
    ? execFileAsync(scriptPath, args, { timeout })
    : execFileAsync('sudo', ['-n', scriptPath, ...args], { timeout });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      pending.child?.kill('SIGKILL');
      const err = new Error(`${scriptPath} ${args[0]} did not finish within ${timeout} ms`);
      err.killed = true;
      reject(err);
    }, timeout + graceMs);
  });
  pending.catch(() => {}); // settled by the race below; a late rejection is not unhandled
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}
