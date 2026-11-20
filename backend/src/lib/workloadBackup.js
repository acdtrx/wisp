/**
 * The one backup orchestration (app glue): a manual backup of a VM or a
 * container, a scheduled container backup and the safety backup before a
 * container restore in place all run through here — the destinations
 * resolved, one backup per destination (`backupToEachDestination`), the
 * attempt recorded (lib/backupStatus.js, whose write is the `backups` topic's
 * cue). A manual or scheduled backup is a job of its own; the safety backup
 * runs inside the restore's job, under the lock that job holds.
 */
import { resolveBackupDestinations, backupToEachDestination } from './backupDestinations.js';
import { recordBackupAttempt } from './backupStatus.js';
import { startJob } from './jobs/index.js';

/**
 * @typedef {{ id: string, path: string, label: string }} BackupDestination
 * @typedef {(dest: BackupDestination, onProgress: (ev: object) => void) => Promise<{ timestamp?: string }>} BackupOne
 */

/**
 * Back a workload up to each destination and record the attempt, success or
 * failure, before answering: run inside a job. Resolves `{ timestamp }`, the
 * last destination's backup folder name (its host path stays on the server).
 *
 * @param {object} opts
 * @param {{ type: 'vm' | 'container', name: string }} opts.subject
 * @param {'manual' | 'scheduled'} opts.origin
 * @param {BackupDestination[]} opts.destinations
 * @param {BackupOne} opts.backupOne - the workload's own backup to one destination
 * @param {(dest: BackupDestination) => Promise<void>} [opts.afterEach] - after a destination finished (retention)
 * @param {(event: object) => void} opts.report - the job's progress
 */
export async function backUpWorkload({ subject, origin, destinations, backupOne, afterEach, report }) {
  const attempt = { type: subject.type, name: subject.name, origin, destinationIds: destinations.map((d) => d.id) };
  let last;
  try {
    last = await backupToEachDestination(destinations, { push: report, backupOne, afterEach });
  } catch (err) {
    await recordBackupAttempt({ ...attempt, ok: false, error: err });
    throw err;
  }
  await recordBackupAttempt({ ...attempt, ok: true, timestamp: last?.timestamp });
  return { timestamp: last?.timestamp };
}

/**
 * Start a backup of one workload as a job holding its operation lock, and
 * answer the ack. Under the lock, before the job exists, `check` refuses what
 * the backup cannot start on and the destinations resolve: what they throw is
 * the caller's error (busy, not found, an unknown destination, a failed
 * mount), never a failed job, and no attempt is recorded for it.
 *
 * @param {object} opts
 * @param {string} opts.kind - the workload's backup kind
 * @param {string} opts.title
 * @param {{ type: 'vm' | 'container', name: string }} opts.subject
 * @param {'manual' | 'scheduled'} opts.origin
 * @param {string[] | undefined} opts.destinationIds
 * @param {() => Promise<void>} opts.check
 * @param {BackupOne} opts.backupOne
 * @param {(dest: BackupDestination) => Promise<void>} [opts.afterEach]
 * @param {import('fastify').FastifyBaseLogger} opts.log
 */
export function startWorkloadBackupJob({
  kind, title, subject, origin, destinationIds, check, backupOne, afterEach, log,
}) {
  let destinations;
  return startJob({
    kind,
    title,
    subject,
    check: async () => {
      await check();
      destinations = await resolveBackupDestinations(destinationIds);
    },
    log,
    run: (report) => backUpWorkload({ subject, origin, destinations, backupOne, afterEach, report }),
  });
}
