/**
 * Job store for OCI image update checks (bulk + single). SSE progress + final summary.
 */
import { createJobStore } from './jobStore.js';

/** `done` payload carries the full result verbatim. */
export const imageUpdateJobStore = createJobStore((result) => ({ ...result }));
