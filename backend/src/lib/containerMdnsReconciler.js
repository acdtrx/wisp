/**
 * Periodic reconciler for container mDNS records when the netns IP changes
 * out from under us — typically a DHCP lease renewal that hands out a
 * different address. The initial network setup persists `network.ip` once at
 * container start; without this loop the mDNS A record would advertise the
 * stale IP forever after a renewal.
 *
 * Cadence: 60 s. Skips containers without `localDns: true` and avoids any
 * mDNS churn when the IP hasn't actually changed.
 */
import {
  listContainers,
  getContainerConfig,
  discoverIpv4InNetnsOnce,
  writeContainerConfig,
} from './containerManager.js';
import { registerAddress, sanitizeHostname } from './mdns/index.js';

const RECONCILE_INTERVAL_MS = 60 * 1000;

let intervalHandle = null;

async function reconcileOne(name, log) {
  let config;
  try {
    config = await getContainerConfig(name);
  } catch {
    return;
  }
  if (!config || config.localDns !== true) return;
  if (config.network?.type !== 'bridge') return;

  let liveIp;
  try {
    liveIp = await discoverIpv4InNetnsOnce(name, 'eth0');
  } catch {
    return;
  }
  if (!liveIp) return;
  if (liveIp === config.network?.ip) return;

  log?.info?.(
    { container: name, oldIp: config.network?.ip, newIp: liveIp },
    'Container IP changed; refreshing mDNS A record',
  );
  config.network = { ...(config.network || {}), ip: liveIp };
  try {
    await writeContainerConfig(name, config);
  } catch (err) {
    log?.warn?.({ err: err.message, container: name }, 'Failed to persist new container IP');
    return;
  }
  try {
    await registerAddress(name, sanitizeHostname(name), liveIp);
  } catch (err) {
    log?.warn?.({ err: err.message, container: name, ip: liveIp }, 'Failed to refresh mDNS A record');
  }
}

async function tick(log) {
  let list;
  try {
    list = await listContainers();
  } catch {
    return;
  }
  for (const entry of list) {
    if (entry.state !== 'running') continue;
    await reconcileOne(entry.name, log);
  }
}

export function startContainerMdnsReconciler(log) {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { void tick(log); }, RECONCILE_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopContainerMdnsReconciler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
