import { createJobSSE } from './sse.js';

/** The server's job kinds this client tells apart (docs/specs/API.md, Background jobs). */
export const JOB_KIND = Object.freeze({
  VM_BACKUP: 'vm-backup',
  CONTAINER_BACKUP: 'container-backup',
  CONTAINER_RESTORE: 'container-restore',
});

/**
 * Stream a job's progress events, whatever its kind, to its last event.
 * @param {(ev: object) => void} onEvent
 * @param {() => void} onGone - the server no longer knows the job (404)
 * @returns {() => void} close
 */
export function streamJobProgress(jobId, onEvent, onGone) {
  return createJobSSE(`/api/jobs/${encodeURIComponent(jobId)}/progress`, onEvent, onGone);
}
