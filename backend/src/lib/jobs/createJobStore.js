/**
 * In-memory store for VM create jobs. Progress is pushed to registered SSE streams.
 */
import { createJobStore as createJobStoreFactory } from './jobStore.js';

const store = createJobStoreFactory((result) => ({ name: result.name }));

export const getJob = store.getJob;
export const createJob = store.createJob;
export const listJobs = store.listJobs;
export const pushEvent = store.pushEvent;
export const completeJob = store.completeJob;
export const failJob = store.failJob;
export const registerStream = store.registerStream;
export const unregisterStream = store.unregisterStream;
