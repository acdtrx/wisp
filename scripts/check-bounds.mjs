#!/usr/bin/env node
/**
 * The update's bounds, read from where each lives, tied together: run with
 * `npm run check` (or `node scripts/check-bounds.mjs`) from the repo root;
 * exits 1 when they do not add up.
 *
 * - setup's own stop bound, SETUP_STOP_SEC, from scripts/linux/setup/bounds.sh
 *   (evaluated by bash, as setup does);
 * - the updater's bounds, `NAME=<seconds>` lines in backend/scripts/wisp-updater;
 * - wisp-updater.service's TimeoutStartSec and TimeoutStopSec;
 * - the frontend's wait for an update, UPDATER_LIMIT_MS.
 *
 * The unit's stop budget must cover the worst case after its start times out:
 * the stopped setup ending (a setup can be stopped there, and in the rollback),
 * then the whole rollback, each part at its bound and its kill. The frontend
 * waits the unit's start timeout and its stop budget.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const problems = [];

function setupBound(name) {
  const script = `source scripts/linux/setup/bounds.sh && printf '%s' "\${${name}}"`;
  const out = execFileSync('bash', ['-c', script], { cwd: ROOT, encoding: 'utf8' });
  const n = Number(out);
  if (!Number.isInteger(n) || n <= 0) problems.push(`scripts/linux/setup/bounds.sh: ${name} is not a number of seconds ("${out}")`);
  return n;
}

function assignments(rel, names) {
  const text = read(rel);
  const found = {};
  for (const name of names) {
    const m = text.match(new RegExp(`^${name}=(\\d+)$`, 'm'));
    if (!m) problems.push(`${rel}: no ${name}=<seconds> line`);
    else found[name] = Number(m[1]);
  }
  return found;
}

const SETUP_STOP_SEC = setupBound('SETUP_STOP_SEC');
const u = assignments('backend/scripts/wisp-updater', ['KILL_GRACE_SEC', 'STOP_WISP_SEC', 'ROLLBACK_RESTORE_SEC',
  'ROLLBACK_SETUP_SEC', 'DAEMON_RELOAD_SEC', 'ROLLBACK_START_WAIT_SEC', 'STATUS_SEC']);
const unit = assignments('systemd/linux/wisp-updater.service', ['TimeoutStartSec', 'TimeoutStopSec']);

const FRONTEND = 'frontend/src/components/host/WispUpdateSection.jsx';
const limit = read(FRONTEND).match(/^const UPDATER_LIMIT_MS = \((\d+) \+ (\d+)\) \* 1000;$/m);
if (!limit) problems.push(`${FRONTEND}: no "const UPDATER_LIMIT_MS = (<start> + <stop>) * 1000;" line`);

if (problems.length === 0) {
  const g = u.KILL_GRACE_SEC;
  // The step running when the start times out, stopped: setup is the longest.
  const stopped = SETUP_STOP_SEC;
  const rollback = (u.STOP_WISP_SEC + g) + (u.ROLLBACK_RESTORE_SEC + g)
    + (u.ROLLBACK_SETUP_SEC + SETUP_STOP_SEC) + (u.DAEMON_RELOAD_SEC + g)
    + (u.ROLLBACK_START_WAIT_SEC + g) + (u.STATUS_SEC + g);
  const need = stopped + rollback;
  if (unit.TimeoutStopSec < need) {
    problems.push(`systemd/linux/wisp-updater.service: TimeoutStopSec=${unit.TimeoutStopSec} is below the worst case of a stopped update, ${need} s (setup stopped, ${stopped} s; then the rollback, ${rollback} s)`);
  }
  const start = Number(limit[1]);
  const stop = Number(limit[2]);
  if (start !== unit.TimeoutStartSec || stop !== unit.TimeoutStopSec) {
    problems.push(`${FRONTEND}: UPDATER_LIMIT_MS is (${start} + ${stop}) s, not the unit's TimeoutStartSec + TimeoutStopSec (${unit.TimeoutStartSec} + ${unit.TimeoutStopSec})`);
  }
  if (problems.length === 0) console.log(`bounds: a stopped update ends within ${need} s; the unit allows ${unit.TimeoutStopSec} s`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
