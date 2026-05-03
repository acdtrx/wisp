/**
 * Container lifecycle operations: start, stop, restart, kill.
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import grpc from '@grpc/grpc-js';
import {
  containerError, containerState, getClient, callUnary,
} from './containerManagerConnection.js';
import { deregisterAddress, deregisterServicesForContainer } from '../../mdns/index.js';
import { findCurrentRunId, finalizeRun } from './containerManagerLogs.js';
import { getContainerDir } from './containerPaths.js';

const SIGTERM = 15;
const SIGKILL = 9;

/** containerd.types.task.Status enum order (proto3) */
const TASK_STATUS_NAMES = ['UNKNOWN', 'CREATED', 'RUNNING', 'STOPPED', 'PAUSED', 'PAUSING'];

const CANON_TO_UI = {
  UNKNOWN: 'unknown',
  CREATED: 'created',
  RUNNING: 'running',
  STOPPED: 'stopped',
  PAUSED: 'paused',
  PAUSING: 'pausing',
};

/**
 * Normalize task status from gRPC.
 * Handles numeric enums, string digits (`"2"` → RUNNING), bigint, and case-insensitive names.
 * Some loaders expose enums as indices; returning them as raw strings broke list/stats mapping.
 */
export function normalizeTaskStatus(status) {
  if (status == null || status === '') return 'UNKNOWN';
  if (typeof status === 'bigint') {
    const n = Number(status);
    if (Number.isFinite(n) && n >= 0 && n < TASK_STATUS_NAMES.length) {
      return TASK_STATUS_NAMES[Math.floor(n)];
    }
    return 'UNKNOWN';
  }
  if (typeof status === 'number' && Number.isFinite(status)) {
    const i = Math.floor(status);
    if (i >= 0 && i < TASK_STATUS_NAMES.length) return TASK_STATUS_NAMES[i];
    return 'UNKNOWN';
  }
  if (typeof status === 'string') {
    const t = status.trim();
    if (/^\d+$/.test(t)) {
      const i = parseInt(t, 10);
      if (i >= 0 && i < TASK_STATUS_NAMES.length) return TASK_STATUS_NAMES[i];
      return 'UNKNOWN';
    }
    const upper = t.toUpperCase();
    if (TASK_STATUS_NAMES.includes(upper)) return upper;
  }
  return 'UNKNOWN';
}

/**
 * UI / API state string for a container task (list row, detail, stats SSE).
 */
export function containerTaskStatusToUi(task) {
  if (!task) return 'stopped';
  const canon = normalizeTaskStatus(task.status);
  return CANON_TO_UI[canon] || 'unknown';
}

/**
 * Get the task state for a container. Returns null if no task exists.
 * `status` is always a string (e.g. STOPPED, CREATED) for reliable comparisons.
 */
export async function getTaskState(name) {
  try {
    const res = await callUnary(getClient('tasks'), 'get', { containerId: name });
    const proc = res.process;
    if (!proc) return null;
    return { ...proc, status: normalizeTaskStatus(proc.status) };
  } catch (err) {
    if (err.code === 'CONTAINER_NOT_FOUND' || err.raw?.includes('not found')) return null;
    throw err;
  }
}

export async function startContainer(name) {
  const task = await getTaskState(name);
  const st = task ? normalizeTaskStatus(task.status) : null;

  if (task && st === 'RUNNING') {
    throw containerError('CONTAINER_ALREADY_RUNNING', `Container "${name}" is already running`);
  }

  if (task && st === 'PAUSED') {
    await callUnary(getClient('tasks'), 'resume', { containerId: name });
    containerState.containerStartTimes.set(name, Date.now());
    return;
  }

  if (task && st === 'CREATED') {
    await callUnary(getClient('tasks'), 'start', { containerId: name });
    containerState.containerStartTimes.set(name, Date.now());
    return;
  }

  // STOPPED (and similar) tasks still exist in containerd until Tasks.Delete.
  // Without deleting first, startExistingContainer → Tasks.Create returns "already exists".
  if (task && (st === 'STOPPED' || st === 'PAUSING' || st === 'UNKNOWN')) {
    await cleanupTask(name);
  }

  // No task (or just removed stale one) — create and start a new task.
  const { startExistingContainer } = await import('./containerManagerCreate.js');
  await startExistingContainer(name);
  containerState.containerStartTimes.set(name, Date.now());
}

/**
 * Start every container with autostart enabled that is not already running.
 * Best-effort: logs and continues on per-container failure (host boot / backend restart).
 */
export async function startAutostartContainersAtBackendBoot(log) {
  if (!containerState.connected) return;

  const { listContainers } = await import('./containerManagerList.js');
  let list;
  try {
    list = await listContainers();
  } catch (err) {
    log.warn({ err }, 'Container autostart: listContainers failed');
    return;
  }

  for (const c of list) {
    if (c.state === 'running') continue;

    let autostart = false;
    try {
      const raw = await readFile(join(getContainerDir(c.name), 'container.json'), 'utf8');
      autostart = JSON.parse(raw).autostart === true;
    } catch {
      continue;
    }
    if (!autostart) continue;

    try {
      await startContainer(c.name);
    } catch (err) {
      log.warn({ err, container: c.name }, 'Container autostart failed');
    }
  }
}

export async function stopContainer(name) {
  const task = await getTaskState(name);
  if (!task || task.status === 'STOPPED') {
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  try {
    await callUnary(getClient('tasks'), 'kill', {
      containerId: name,
      signal: SIGTERM,
      all: true,
    });
  } catch {
    // Task may have already exited
  }

  // Wait for graceful exit (up to 10s), then force kill — exponential backoff, not fixed polling
  const deadline = Date.now() + 10000;
  let sleepMs = 100;
  while (Date.now() < deadline) {
    const current = await getTaskState(name);
    if (!current || current.status === 'STOPPED') break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(sleepMs, remaining)));
    sleepMs = Math.min(sleepMs * 2, 2000);
  }

  const afterWait = await getTaskState(name);
  if (afterWait && afterWait.status !== 'STOPPED') {
    await killContainer(name);
  }

  await cleanupTask(name);
  containerState.containerStartTimes.delete(name);
  await deregisterServicesForContainer(name);
  await deregisterAddress(name);
}

export async function killContainer(name) {
  const task = await getTaskState(name);
  if (!task || task.status === 'STOPPED') {
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  try {
    await callUnary(getClient('tasks'), 'kill', {
      containerId: name,
      signal: SIGKILL,
      all: true,
    });
  } catch {
    // Task may have already exited
  }

  await waitForStop(name, 5000);
  await cleanupTask(name);
  containerState.containerStartTimes.delete(name);
  await deregisterServicesForContainer(name);
  await deregisterAddress(name);
}

export async function restartContainer(name) {
  const task = await getTaskState(name);
  if (task && (task.status === 'RUNNING' || task.status === 'PAUSED')) {
    try { await stopContainer(name); } catch { /* may already be stopped */ }
  }
  await startContainer(name);
}

async function waitForStop(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sleepMs = 100;
  while (Date.now() < deadline) {
    const task = await getTaskState(name);
    if (!task || task.status === 'STOPPED') return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise((r) => setTimeout(r, Math.min(sleepMs, remaining)));
    sleepMs = Math.min(sleepMs * 2, 2000);
  }
}

/**
 * Delete the containerd task record and finalize the currently-active log run.
 * Exit status comes from Tasks.Delete (uint32; non-finite values become null).
 * Finalizing is best-effort — missing/already-finalized runs are skipped.
 * Exported so containerManagerCreate can reuse the same flow before re-creating.
 */
export async function cleanupTask(name) {
  let exitCode = null;
  try {
    const res = await callUnary(getClient('tasks'), 'delete', { containerId: name });
    const raw = res?.exitStatus;
    if (typeof raw === 'number' && Number.isFinite(raw)) exitCode = raw;
    else if (typeof raw === 'bigint') exitCode = Number(raw);
    else if (typeof raw === 'string' && /^\d+$/.test(raw)) exitCode = parseInt(raw, 10);
  } catch {
    // Task may not exist (already deleted, or never created).
  }
  try {
    const runId = await findCurrentRunId(name);
    if (runId) await finalizeRun(name, runId, { exitCode });
  } catch { /* best effort — finalization is informational */ }
}
