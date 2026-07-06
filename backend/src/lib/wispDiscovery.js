/**
 * Wisp instance discovery — Wisp-glue between settings and the mDNS module.
 *
 * Announces this instance as a `_wisp._tcp` service (TXT: url/name/version)
 * and browses the LAN for peer instances, keeping a peer map that the
 * discovery SSE route pushes to the frontend. All DBus plumbing lives in the
 * mdns module — this file carries only Wisp policy: what to announce, how to
 * self-filter, and the peer-list change event.
 *
 * The settings PATCH route calls `refreshWispAnnouncement` after a successful
 * update so name/URL/toggle changes take effect without a restart.
 */
import { hostname } from 'node:os';

import {
  registerService,
  deregisterService,
  subscribeServiceBrowse,
} from './mdns/index.js';
import { getSettings } from './settings.js';
import { getCurrentVersion } from './wispUpdate.js';

const WISP_SERVICE_TYPE = '_wisp._tcp';
// Never put '#' in this key: deregisterServicesForContainer() prefix-matches
// `${containerName}#` and "wisp" is a legal container name.
const SERVICE_KEY = 'wisp:discovery';

let logger = null;
let started = false;
let port = 8080;
let selfInstanceName = null;
let stopBrowse = null;

/** instanceName -> { name, url, version, host } */
const peers = new Map();
const subscribers = new Set();

function log() {
  return logger || console;
}

function emitChange() {
  for (const handler of subscribers) {
    try {
      handler();
    } catch (err) {
      log().warn?.({ err: err?.message || err }, '[discovery] subscriber threw');
    }
  }
}

/**
 * Pick a navigable URL for a peer. TXT `url` is attacker-controllable (any
 * LAN device can announce _wisp._tcp), and it ends up as an <a href> in the
 * authenticated UI — accept only http/https, else fall back to the SRV
 * host/port. Returns null when nothing safe can be built.
 */
function safePeerUrl(svc) {
  const raw = typeof svc.txt?.url === 'string' ? svc.txt.url.trim() : '';
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return raw;
    } catch { /* not a URL — fall back to SRV */ }
  }
  return svc.host && svc.port ? `http://${svc.host}:${svc.port}` : null;
}

function onUp(svc) {
  // Skip our own announcement (isLocal: published by this host or this
  // connection). The name check is belt-and-braces for mDNS-reflector setups
  // that echo our records back without the local marking.
  if (svc.isLocal) return;
  if (svc.name === selfInstanceName) return;
  const url = safePeerUrl(svc);
  if (!url) return;
  peers.set(svc.name, {
    name: svc.txt?.name || svc.name,
    url,
    version: svc.txt?.version || null,
    host: svc.host,
  });
  emitChange();
}

function onDown(name) {
  if (peers.delete(name)) emitChange();
}

function onReset() {
  if (peers.size === 0) return;
  peers.clear();
  emitChange();
}

let version = null;
let announceChain = Promise.resolve();

/**
 * Reconcile announce + browse with current settings, serialized — concurrent
 * settings PATCHes must not interleave register/deregister and leave the
 * announcement contradicting the toggle. Best-effort: mdns failures are
 * logged and swallowed by callers — discovery must never break the app.
 */
function applyAnnouncementState() {
  const run = announceChain.then(reconcileAnnouncement);
  // Keep the chain alive past rejections; each caller awaits its own run.
  announceChain = run.catch(() => {});
  return run;
}

async function reconcileAnnouncement() {
  const settings = await getSettings();
  if (!settings.discoveryEnabled) {
    await deregisterService(SERVICE_KEY);
    if (stopBrowse) {
      stopBrowse();
      stopBrowse = null;
    }
    onReset();
    return;
  }

  version ??= getCurrentVersion(); // constant per process — self-update restarts wisp
  const url = settings.advertisedUrl || `http://${selfInstanceName}.local:${port}`;
  const txt = { url, name: settings.serverName, version };
  await registerService(
    SERVICE_KEY,
    selfInstanceName,
    WISP_SERVICE_TYPE,
    port,
    txt,
    `${selfInstanceName}.local`,
  );
  if (!stopBrowse) {
    stopBrowse = subscribeServiceBrowse(WISP_SERVICE_TYPE, { onUp, onDown, onReset });
  }
}

export async function startWispDiscovery(log_, opts = {}) {
  if (started) return;
  started = true;
  logger = log_ || null;
  if (Number.isInteger(opts.port)) port = opts.port;
  // Short hostname — os.hostname() may return an FQDN, and the mDNS name the
  // avahi daemon publishes for this box is `<shortname>.local`.
  selfInstanceName = hostname().split('.')[0];
  try {
    await applyAnnouncementState();
  } catch (err) {
    log().warn?.({ err: err?.message || err }, '[discovery] start failed');
  }
}

export async function stopWispDiscovery() {
  if (!started) return;
  started = false;
  if (stopBrowse) {
    stopBrowse();
    stopBrowse = null;
  }
  try {
    await deregisterService(SERVICE_KEY);
  } catch (err) {
    log().warn?.({ err: err?.message || err }, '[discovery] deregister on stop failed');
  }
  peers.clear();
}

/**
 * Re-announce with current settings (or withdraw + stop browsing when the
 * toggle is off). Called by the settings PATCH route after a successful save.
 */
export async function refreshWispAnnouncement() {
  if (!started) return;
  try {
    await applyAnnouncementState();
  } catch (err) {
    log().warn?.({ err: err?.message || err }, '[discovery] refresh failed');
  }
}

export function getDiscoveredPeers() {
  return [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Notify on any peer-list change. No replay — the SSE route sends its own
 * initial snapshot (same contract as vmManager.subscribeVMListChange).
 */
export function subscribeDiscoveredPeersChange(handler) {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
