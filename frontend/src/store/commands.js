import { awaitJob } from './backgroundJobsStore.js';
import { records } from './records.js';

/**
 * How a command runs, pure of React so it can be tested (hooks/useCommand.js), made
 * over the job wait and the record re-read so a test can stand in for them:
 * `fn` sends the command and resolves once it answered — the ack, or for a command
 * whose new state arrives on the stream, the frame and its re-reads
 * (`sendAndAwaitChange` / `sendAndAwaitTopic`). A command that runs as a job (`job`)
 * answers its ack (`onAck` gets it: the job's id, for a view of its progress), and is
 * followed to the job's end. Then every record it names (`rereads`, `[kind, id]`
 * pairs) is read again — a read sent after the command ended, whether or not the
 * stream is up — and the command ends when those reads have landed, so its control
 * stays busy until the new state is on screen (docs/FRONTEND-RULES.md, Data).
 *
 * @param {{ awaitJob: (jobId: string) => Promise<unknown>, reread: (kind: string, id?: unknown) => Promise<unknown> }} deps
 */
export function createRunCommand({ awaitJob: waitForJob, reread }) {
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ job?: boolean, rereads?: Array<[string, unknown?]>, onAck?: (ack: any) => void }} [options]
   * @returns {Promise<T>} the answer (a job's result), or the command's error
   */
  return async function runCommand(fn, { job = false, rereads = [], onAck } = {}) {
    let result = await fn();
    if (job) {
      onAck?.(result);
      result = await waitForJob(result.jobId);
    }
    await Promise.all(rereads.map(([kind, id]) => reread(kind, id)));
    return result;
  };
}

export const runCommand = createRunCommand({ awaitJob, reread: (kind, id) => records.reread(kind, id) });
