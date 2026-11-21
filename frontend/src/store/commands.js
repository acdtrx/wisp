import { awaitJob } from './backgroundJobsStore.js';

/**
 * How a command runs, pure of React so it can be tested (hooks/useCommand.js), made
 * over the job wait so a test can stand in for it: `fn` sends the command and resolves
 * with its answer, the ack. A command that runs as a job (`job`) answers its ack
 * (`onAck` gets it: the job's id, for a view of its progress), and is followed to the
 * job's end (a failed or cancelled job is the command's failure). Nothing waits for a
 * stream frame: the screen follows through the stream as it always does.
 *
 * @param {{ awaitJob: (jobId: string) => Promise<unknown> }} deps
 */
export function createRunCommand({ awaitJob: waitForJob }) {
  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{ job?: boolean, onAck?: (ack: any) => void }} [options]
   * @returns {Promise<T>} the answer (a job's result), or the command's error
   */
  return async function runCommand(fn, { job = false, onAck } = {}) {
    const ack = await fn();
    if (!job) return ack;
    onAck?.(ack);
    return waitForJob(ack.jobId);
  };
}

export const runCommand = createRunCommand({ awaitJob });
