/**
 * Per-container mDNS service definitions: validation + row-scoped CRUD.
 * Services advertise SRV/TXT records (e.g. `_smb._tcp` on port 445) for the
 * container's `<name>.local` host record (which itself is published by
 * `registerAddress` when `localDns` is true).
 */
import { containerError } from './containerManagerConnection.js';
import { getTaskState } from './containerManagerLifecycle.js';
import {
  registerService, deregisterService, deregisterServicesForContainer, sanitizeHostname,
  isValidServiceType, isValidServicePort,
} from '../../mdns/index.js';
import { readContainerConfig as loadContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';

function taskIsRunning(task) {
  return task && (task.status === 'RUNNING' || task.status === 'PAUSED');
}

function serviceKey(containerName, port) {
  return `${containerName}#${port}`;
}

/**
 * Normalize a TXT map: drop empty keys, coerce values to strings, reject bad types.
 * @param {unknown} txt
 * @returns {object}
 */
function normalizeTxt(txt) {
  if (txt == null) return {};
  if (typeof txt !== 'object' || Array.isArray(txt)) {
    throw containerError('INVALID_CONTAINER_SERVICE', 'txt must be an object of key/value pairs');
  }
  const out = {};
  for (const [k, v] of Object.entries(txt)) {
    const key = typeof k === 'string' ? k.trim() : '';
    if (!key) continue;
    if (key.includes('=')) {
      throw containerError('INVALID_CONTAINER_SERVICE', `TXT key "${k}" must not contain "="`);
    }
    if (v != null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw containerError('INVALID_CONTAINER_SERVICE', `TXT value for "${key}" must be a primitive`);
    }
    out[key] = v == null ? '' : String(v);
  }
  return out;
}

/**
 * Validate a single service definition. Throws on invalid input.
 * @param {{ port?: unknown, type?: unknown, txt?: unknown }} raw
 * @returns {{ port: number, type: string, txt: object }}
 */
export function validateServiceDef(raw) {
  if (!raw || typeof raw !== 'object') {
    throw containerError('INVALID_CONTAINER_SERVICE', 'Service definition must be an object');
  }
  const port = typeof raw.port === 'string' ? Number(raw.port.trim()) : raw.port;
  if (!isValidServicePort(port)) {
    throw containerError('INVALID_CONTAINER_SERVICE', 'port must be an integer in [1, 65535]');
  }
  const type = typeof raw.type === 'string' ? raw.type.trim() : '';
  if (!isValidServiceType(type)) {
    throw containerError(
      'INVALID_CONTAINER_SERVICE',
      'type must match _<name>._tcp or _<name>._udp',
    );
  }
  const txt = normalizeTxt(raw.txt);
  return { port, type, txt };
}

function ensureLocalDns(config) {
  if (config.localDns !== true) {
    throw containerError(
      'CONTAINER_LOCAL_DNS_DISABLED',
      'Enable Local DNS before advertising services',
    );
  }
}

/** Register every persisted service for a running container — called after the address publish. */
export async function registerAllContainerServices(name, config) {
  if (!Array.isArray(config?.services) || config.services.length === 0) return;
  if (!config.localDns) return;
  if (!config.network?.ip) return;
  const host = `${sanitizeHostname(name)}.local`;
  for (const svc of config.services) {
    await registerService(serviceKey(name, svc.port), name, svc.type, svc.port, svc.txt || {}, host);
  }
}

/**
 * Append one service. Returns `{ requiresRestart: false }` (mDNS is live, no task restart needed).
 * @param {string} name
 * @param {{ port: number, type: string, txt?: object }} serviceDef
 */
export async function addContainerService(name, serviceDef) {
  const normalized = validateServiceDef(serviceDef);
  const config = await loadContainerConfig(name);
  ensureLocalDns(config);

  const list = Array.isArray(config.services) ? [...config.services] : [];
  if (list.some((s) => s.port === normalized.port)) {
    throw containerError(
      'CONTAINER_SERVICE_DUPLICATE',
      `A service is already configured on port ${normalized.port}`,
    );
  }
  list.push(normalized);
  config.services = list;
  await writeContainerConfig(name, config);

  const task = await getTaskState(name);
  if (taskIsRunning(task) && config.network?.ip) {
    const host = `${sanitizeHostname(name)}.local`;
    await registerService(
      serviceKey(name, normalized.port),
      name,
      normalized.type,
      normalized.port,
      normalized.txt,
      host,
    );
  }
  return { requiresRestart: false };
}

/**
 * Update one service identified by its current port.
 * Body may include `type` and/or `txt`. Port is not editable (delete + create instead).
 */
export async function updateContainerService(name, port, changes) {
  if (!changes || typeof changes !== 'object') {
    throw containerError('INVALID_CONTAINER_SERVICE', 'changes must be an object');
  }
  const portNum = Number(port);
  if (!isValidServicePort(portNum)) {
    throw containerError('INVALID_CONTAINER_SERVICE', 'Invalid port');
  }

  const config = await loadContainerConfig(name);
  ensureLocalDns(config);
  const list = Array.isArray(config.services) ? [...config.services] : [];
  const idx = list.findIndex((s) => s.port === portNum);
  if (idx < 0) {
    throw containerError(
      'CONTAINER_SERVICE_NOT_FOUND',
      `No service is configured on port ${portNum}`,
    );
  }
  const current = list[idx];
  const next = { port: current.port, type: current.type, txt: current.txt || {} };
  if (changes.type !== undefined) {
    if (typeof changes.type !== 'string' || !isValidServiceType(changes.type.trim())) {
      throw containerError(
        'INVALID_CONTAINER_SERVICE',
        'type must match _<name>._tcp or _<name>._udp',
      );
    }
    next.type = changes.type.trim();
  }
  if (changes.txt !== undefined) {
    next.txt = normalizeTxt(changes.txt);
  }

  const unchanged = next.type === current.type
    && JSON.stringify(next.txt) === JSON.stringify(current.txt || {});
  if (unchanged) return { requiresRestart: false };

  list[idx] = next;
  config.services = list;
  await writeContainerConfig(name, config);

  const task = await getTaskState(name);
  if (taskIsRunning(task) && config.network?.ip) {
    const host = `${sanitizeHostname(name)}.local`;
    await registerService(serviceKey(name, next.port), name, next.type, next.port, next.txt, host);
  }
  return { requiresRestart: false };
}

/**
 * Remove a service by its port.
 */
export async function removeContainerService(name, port) {
  const portNum = Number(port);
  if (!isValidServicePort(portNum)) {
    throw containerError('INVALID_CONTAINER_SERVICE', 'Invalid port');
  }
  const config = await loadContainerConfig(name);
  const list = Array.isArray(config.services) ? [...config.services] : [];
  const idx = list.findIndex((s) => s.port === portNum);
  if (idx < 0) {
    throw containerError(
      'CONTAINER_SERVICE_NOT_FOUND',
      `No service is configured on port ${portNum}`,
    );
  }
  list.splice(idx, 1);
  config.services = list;
  await writeContainerConfig(name, config);

  await deregisterService(serviceKey(name, portNum));
  return { requiresRestart: false };
}

export { deregisterServicesForContainer };
