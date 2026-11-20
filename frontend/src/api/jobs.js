import { openStream } from './sse.js';

const TERMINAL_STEPS = new Set(['done', 'error', 'cancelled']);

/** A job's last event (`done`, `error`, `cancelled`): the server ends its progress stream after it. */
export function isTerminalJobEvent(ev) {
  return TERMINAL_STEPS.has(ev?.step);
}

/**
 * Stream a job's progress events, whatever its kind, to its last event.
 * @param {(ev: object) => void} onEvent
 * @param {(err: import('./errors.js').ApiError) => void} onRefused - the stream answered a 4xx and ended;
 *   a 404: the server no longer knows the job
 * @returns {() => void} close
 */
export function streamJobProgress(jobId, onEvent, onRefused) {
  return openStream(`/api/jobs/${encodeURIComponent(jobId)}/progress`, onEvent, {
    onDown: (refusal) => { if (refusal) onRefused(refusal); },
    endsAt: isTerminalJobEvent,
  });
}
