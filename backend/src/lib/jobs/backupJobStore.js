/**
 * In-memory store for VM backup jobs. Progress is pushed to registered SSE streams.
 */
import { createJobStore as createJobStoreFactory } from './jobStore.js';

/* Only the backup folder name leaves the server: the absolute host path is
 * internal (API.md documents `{ step: 'done', timestamp }`). */
const store = createJobStoreFactory((result) => ({ timestamp: result?.timestamp }));

export const getJob = store.getJob;
export const createJob = store.createJob;
export const listJobs = store.listJobs;
export const pushEvent = store.pushEvent;
export const completeJob = store.completeJob;
export const failJob = store.failJob;
export const registerStream = store.registerStream;
export const unregisterStream = store.unregisterStream;
