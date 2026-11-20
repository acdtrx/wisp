/**
 * The OS package check and the container image update check as jobs (Wisp
 * glue: lib/host and containerManager run the checks and cannot start a job),
 * and their hourly trigger. Each check is a shared job: a start from any
 * trigger — a route, an MCP tool, the hour — joins a running check that
 * covers it (docs/specs/API.md, Background jobs). Both are interruptible: a
 * shutdown cuts them, and the next hour checks again.
 */
import { checkForUpdates, isUpgradeInProgress, supportsOsUpdateChecks } from './host/index.js';
import { checkAllImagesForUpdates, checkSingleImageForUpdates, supportsImageUpdateChecks } from './containerManager/index.js';
import { createAppError, errorBody } from './appErrors.js';
import {
  startJob,
  isJobRunning,
  TITLE_OS_UPDATE_CHECK,
  TITLE_IMAGE_UPDATE_CHECK_ALL,
  titleForImageUpdateCheckSingle,
} from './jobs/index.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const HOURLY_MS = 60 * 60 * 1000;
const OS_CHECK_FIRST_DELAY_MS = 30_000;
const IMAGE_CHECK_FIRST_DELAY_MS = 60_000;

/** An upgrade runs, or its job was started and has not reached it yet. */
export function isOsUpgradeRunning() {
  return isUpgradeInProgress() || isJobRunning(JOB_KIND.OS_UPGRADE);
}

/**
 * Start the OS package check, or join the running one. Its result is the
 * count; the list is then read from GET /api/host/updates/packages. Refused
 * with UPDATE_BUSY while an upgrade runs.
 */
export function startOsUpdateCheckJob(log) {
  return startJob({
    kind: JOB_KIND.OS_UPDATE_CHECK,
    title: TITLE_OS_UPDATE_CHECK,
    shared: true,
    interruptible: true,
    check: () => {
      if (isOsUpgradeRunning()) {
        throw createAppError('UPDATE_BUSY', 'An OS upgrade is in progress on the host', 'Wait for the upgrade to finish before checking again');
      }
    },
    log,
    run: (_report, signal) => checkForUpdates(signal),
  });
}

/**
 * Image check runs take turns: a run started while another runs waits for it
 * to end. Two runs pulling the same image at once would let one read the
 * other's pull as its "before" digest and report a changed image unchanged.
 */
let imageCheckRuns = Promise.resolve();

function queueImageCheckRun(runCheck) {
  const mine = imageCheckRuns.then(runCheck);
  imageCheckRuns = mine.catch(() => { /* the job reports it; the next run starts regardless */ });
  return mine;
}

/**
 * Start the image update check — every image, or `ref` alone — or join a
 * running one that covers it: a check of `ref` joins a running check of every
 * image or of `ref`; a check of every image joins only another such check.
 * Its result: `{ checked, updated, flaggedContainers, lastCheckedAt }`.
 * @param {{ ref?: string | null, log: object }} opts
 */
export function startImageUpdateCheckJob({ ref = null, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK,
    title: ref ? titleForImageUpdateCheckSingle(ref) : TITLE_IMAGE_UPDATE_CHECK_ALL,
    shared: true,
    scope: ref,
    interruptible: true,
    log,
    run: (report, signal) => {
      // The manager reports a skipped image with its error; the event carries the error body.
      const onProgress = (ev) => report(ev.step === 'skipped' ? { step: 'skipped', ref: ev.ref, ...errorBody(ev.cause) } : ev);
      return queueImageCheckRun(() => {
        signal.throwIfAborted(); // cut while it waited its turn
        return ref
          ? checkSingleImageForUpdates(ref, onProgress, signal)
          : checkAllImagesForUpdates(onProgress, signal);
      });
    },
  });
}

/** @type {Array<{ first: ReturnType<typeof setTimeout>, hourly: ReturnType<typeof setInterval> }>} */
let schedules = [];

function scheduleHourly(firstDelayMs, label, start, log) {
  const fire = () => {
    start().catch((err) => log.warn({ code: err?.code, err: err?.message }, `Hourly ${label} not started`));
  };
  schedules.push({ first: setTimeout(fire, firstDelayMs), hourly: setInterval(fire, HOURLY_MS) });
}

/**
 * Idempotent. Each check's first run comes shortly after the start, then one
 * an hour — only for a check this host can run (the macOS dev stubs run none).
 */
export function startHourlyUpdateChecks(log) {
  if (schedules.length) return;
  const hourlyLog = log.child({ trigger: 'hourly' });
  if (supportsOsUpdateChecks) {
    scheduleHourly(OS_CHECK_FIRST_DELAY_MS, 'OS update check', () => startOsUpdateCheckJob(hourlyLog), hourlyLog);
  }
  if (supportsImageUpdateChecks) {
    scheduleHourly(IMAGE_CHECK_FIRST_DELAY_MS, 'image update check', () => startImageUpdateCheckJob({ log: hourlyLog }), hourlyLog);
  }
}

/** Clear the timers; a running check is cut with the other interruptible jobs (cancelInterruptibleJobs). */
export function stopHourlyUpdateChecks() {
  for (const { first, hourly } of schedules) {
    clearTimeout(first);
    clearInterval(hourly);
  }
  schedules = [];
}
