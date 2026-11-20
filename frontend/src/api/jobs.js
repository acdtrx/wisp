import { createJobSSE } from './sse.js';

/** The server's job kinds this client tells apart (docs/specs/API.md, Background jobs). */
export const JOB_KIND = Object.freeze({
  VM_BACKUP: 'vm-backup',
  CONTAINER_BACKUP: 'container-backup',
  CONTAINER_RESTORE: 'container-restore',
  CONTAINER_STOP: 'container-stop',
});

/**
 * Stream a job's progress events, whatever its kind, to its last event.
 * @param {(ev: object) => void} onEvent
 * @param {(err: import('./errors.js').ApiError) => void} onRefused - the stream answered a 4xx and ended;
 *   a 404: the server no longer knows the job
 * @returns {() => void} close
 */
export function streamJobProgress(jobId, onEvent, onRefused) {
  return createJobSSE(`/api/jobs/${encodeURIComponent(jobId)}/progress`, onEvent, onRefused);
}
