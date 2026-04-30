/**
 * Job store for the self-update install pipeline (download → stage → apply → restart).
 * One job at a time in practice; createJobStore allows more but the route refuses
 * a second start while one is in flight.
 */
import { createJobStore } from './jobStore.js';

export const wispUpdateJobStore = createJobStore((result) => ({ ...result }));
