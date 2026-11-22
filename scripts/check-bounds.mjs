#!/usr/bin/env node
/**
 * The update's bounds, read from where each lives, tied together: run with
 * `npm run check` (or `node scripts/check-bounds.mjs`) from the repo root;
 * exits 1 when they do not add up.
 *
 * - setup's own stop bound, SETUP_STOP_SEC, from scripts/linux/setup/bounds.sh
 *   (evaluated by bash, as setup does);
 * - the updater's bounds, `NAME=<seconds>` lines in backend/scripts/wisp-updater;
 * - wisp-updater.service's TimeoutStartSec and TimeoutStopSec, and
 *   wisp.service's TimeoutStopSec;
 * - the frontend's wait for an update, UPDATER_LIMIT_MS;
 * - the install lock's path, setup's WISP_LOCK (scripts/linux/setup/lib.sh) and
 *   the updater's, which is installed on its own and names it too;
 * - the push's directory, made by scripts/push.sh (PUSH_DIR_TEMPLATE) and the
 *   only one the installer removes for it (scripts/linux/install-root.sh,
 *   PUSH_DIR_PREFIX);
 * - setup's foreground calls with bounds of their own (UDEV_CALL_SEC), none
 *   longer than a network call's, NET_CMD_SEC, past which a step's stop would
 *   wait (scripts/linux/setup/step.sh, step_stop).
 *
 * The unit's stop budget must cover the worst case after its start times out:
 * the stopped install ending (scripts/linux/install-tree.sh, which ends within
 * setup's stop bound; one can be stopped there, and in the rollback), then the
 * whole rollback, each part at its bound and its kill. The frontend
 * waits the unit's start timeout and its stop budget. The updater's bound on
 * stopping wisp.service covers systemd's own stop of it — TimeoutStopSec for
 * the TERM, the same again after the KILL — and WISP_STOP_MARGIN_SEC more, so
 * that its "did not stop" never races systemd's second wait.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const problems = [];

function shellValue(rel, name) {
  const script = `source ${rel} && printf '%s' "\${${name}}"`;
  return execFileSync('bash', ['-c', script], { cwd: ROOT, encoding: 'utf8' });
}

function setupBound(name) {
  const out = shellValue('scripts/linux/setup/bounds.sh', name);
  const n = Number(out);
  if (!Number.isInteger(n) || n <= 0) problems.push(`scripts/linux/setup/bounds.sh: ${name} is not a number of seconds ("${out}")`);
  return n;
}

function assignments(rel, names, pattern = '\\d+') {
  const text = read(rel);
  const found = {};
  for (const name of names) {
    const m = text.match(new RegExp(`^${name}=(${pattern})$`, 'm'));
    if (!m) problems.push(`${rel}: no ${name}=<${pattern === '\\d+' ? 'seconds' : 'value'}> line`);
    else found[name] = pattern === '\\d+' ? Number(m[1]) : m[1];
  }
  return found;
}

// What systemctl's stop of wisp.service takes beyond systemd's two waits (the
// stop job queued and reported, the cgroup's last exit seen).
const WISP_STOP_MARGIN_SEC = 10;

const SETUP_STOP_SEC = setupBound('SETUP_STOP_SEC');
const NET_CMD_SEC = setupBound('NET_CMD_SEC');
const UDEV_CALL_SEC = setupBound('UDEV_CALL_SEC');
const u = assignments('backend/scripts/wisp-updater', ['KILL_GRACE_SEC', 'STOP_WISP_SEC', 'ROLLBACK_RESTORE_SEC',
  'ROLLBACK_INSTALL_SEC', 'ROLLBACK_START_SEC', 'STATUS_SEC']);
const unit = assignments('systemd/linux/wisp-updater.service', ['TimeoutStartSec', 'TimeoutStopSec']);
const wisp = assignments('systemd/linux/wisp.service', ['TimeoutStopSec']);
const updaterLock = assignments('backend/scripts/wisp-updater', ['WISP_LOCK'], '\\S+');
const setupLock = shellValue('scripts/linux/setup/lib.sh', 'WISP_LOCK');
const pushTemplate = assignments('scripts/push.sh', ['PUSH_DIR_TEMPLATE'], '\\S+');
const pushPrefix = assignments('scripts/linux/install-root.sh', ['PUSH_DIR_PREFIX'], '\\S+');

const FRONTEND = 'frontend/src/components/host/WispUpdateSection.jsx';
const limit = read(FRONTEND).match(/^const UPDATER_LIMIT_MS = \((\d+) \+ (\d+)\) \* 1000;$/m);
if (!limit) problems.push(`${FRONTEND}: no "const UPDATER_LIMIT_MS = (<start> + <stop>) * 1000;" line`);

if (problems.length === 0) {
  const g = u.KILL_GRACE_SEC;
  // The install running when the start times out, stopped: it ends within
  // setup's stop bound (scripts/linux/install-tree.sh passes the TERM to
  // setup's leader, and to any other phase's whole group, which ends at once).
  const stopped = SETUP_STOP_SEC;
  // Then the rollback: stop wisp, restore the tree, the restored tree's install
  // (past its limit, a TERM, and setup's stop bound again), the read of wisp's
  // state, the start made when that install did not start it, and the read of
  // its state for the last line.
  const rollback = (u.STOP_WISP_SEC + g) + (u.ROLLBACK_RESTORE_SEC + g)
    + (u.ROLLBACK_INSTALL_SEC + SETUP_STOP_SEC) + (u.STATUS_SEC + g)
    + (u.ROLLBACK_START_SEC + g) + (u.STATUS_SEC + g);
  const need = stopped + rollback;
  if (unit.TimeoutStopSec < need) {
    problems.push(`systemd/linux/wisp-updater.service: TimeoutStopSec=${unit.TimeoutStopSec} is below the worst case of a stopped update, ${need} s (the install stopped, ${stopped} s; then the rollback, ${rollback} s)`);
  }
  if (u.STOP_WISP_SEC < 2 * wisp.TimeoutStopSec + WISP_STOP_MARGIN_SEC) {
    problems.push(`backend/scripts/wisp-updater: STOP_WISP_SEC=${u.STOP_WISP_SEC} is below systemd's own stop of wisp.service, 2 × its TimeoutStopSec=${wisp.TimeoutStopSec}, and a margin of ${WISP_STOP_MARGIN_SEC} s`);
  }
  if (pushTemplate.PUSH_DIR_TEMPLATE !== `${pushPrefix.PUSH_DIR_PREFIX}XXXXXX`) {
    problems.push(`scripts/push.sh: PUSH_DIR_TEMPLATE=${pushTemplate.PUSH_DIR_TEMPLATE} is not the installer's PUSH_DIR_PREFIX=${pushPrefix.PUSH_DIR_PREFIX} and XXXXXX (scripts/linux/install-root.sh)`);
  }
  if (UDEV_CALL_SEC > NET_CMD_SEC) {
    problems.push(`scripts/linux/setup/bounds.sh: UDEV_CALL_SEC=${UDEV_CALL_SEC} is above NET_CMD_SEC=${NET_CMD_SEC}, the longest a step runs a call in the foreground`);
  }
  if (updaterLock.WISP_LOCK !== setupLock) {
    problems.push(`backend/scripts/wisp-updater: WISP_LOCK=${updaterLock.WISP_LOCK} is not setup's, ${setupLock} (scripts/linux/setup/lib.sh)`);
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
