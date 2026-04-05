/**
 * Job store for container creation progress (SSE).
 */
import { createJobStore } from './jobStore.js';

export const containerJobStore = createJobStore((result) => ({ name: result.name }));
