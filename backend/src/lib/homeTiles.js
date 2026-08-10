/**
 * Home page tile derivation — turns the live deployment plus the persisted
 * overlay into the `{ tiles, groups }` envelope the Home tab renders and the
 * `home` topic on /api/events pushes.
 *
 * Zero-config is the point: a Wisp with no `homepage` key still renders every
 * URL it can prove exists. Three sources in descending priority, deduped by
 * URL (CODING-RULES §4 — read each link from where its contract puts it, never
 * by scanning for URL-shaped strings):
 *
 *   1. App modules' `getPublishedLinks(appConfig)` — every container carrying
 *      `metadata.app`, never a hardcoded container name, so zero, one, or many
 *      Caddy instances all work.
 *   2. Declared `_http._tcp` / `_https._tcp` mDNS services on containers with
 *      Local DNS on.
 *   3. Manual links the user added.
 *
 * Each link then joins back to a workload by target/mDNS hostname, which is
 * what gives the tile its live state. A link with no matching workload (a Caddy
 * host fronting another machine) renders as a stateless external tile.
 */
import { getAppModule } from './containerApps/appRegistry.js';
import { gatherDeployment } from './deploymentOverview.js';
import { getHomepage, UNGROUPED_GROUP_ID } from './homepage.js';

const HTTP_SERVICE_TYPES = new Map([
  ['_http._tcp', 'http'],
  ['_https._tcp', 'https'],
]);

const DEFAULT_ICON_ID = 'globe';

/* Source priority, low wins. Ties are broken by "the backing container runs". */
const SOURCE_PRIORITY = { app: 0, mdns: 1, manual: 2 };

/**
 * Canonical form of a link URL — this doubles as the derived tile's id, so two
 * spellings of the same address must collapse to one string. `URL` already
 * lowercases the host and drops a default port; we additionally drop the
 * fragment and the bare trailing slash so `https://x/` and `https://x` match.
 *
 * @returns {string|null} null when the input isn't an absolute http(s) URL.
 */
function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.hash = '';
  const str = parsed.toString();
  if (parsed.pathname === '/' && !parsed.search) return str.slice(0, -1);
  return str;
}

/**
 * Hostname out of a Caddy-style target (`host`, `host:port`, or
 * `scheme://host[:port][/path]`). Used only for the workload join.
 */
function targetHostname(target) {
  if (typeof target !== 'string' || !target.trim()) return null;
  const trimmed = target.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).hostname || null;
  } catch {
    return null;
  }
}

/** First label of a hostname — the fallback display name for an unjoined link. */
function hostLabel(hostname) {
  if (!hostname) return '';
  const first = hostname.split('.')[0];
  return first || hostname;
}

/**
 * Every name a workload can be reached by → the workload. Feeds the join from a
 * derived link's target/host back to the thing that serves it.
 */
function buildWorkloadIndex(deployment) {
  const index = new Map();
  const add = (key, workload) => {
    if (typeof key !== 'string' || !key.trim()) return;
    const k = key.trim().toLowerCase();
    if (!index.has(k)) index.set(k, workload);
  };

  for (const { summary, config } of deployment.containers) {
    const workload = {
      type: 'container',
      name: summary.name,
      state: summary.state,
      updateAvailable: summary.updateAvailable === true,
      iconId: summary.iconId ?? null,
    };
    add(summary.name, workload);
    if (config?.localDns) add(config.mdnsHostname || `${summary.name}.local`, workload);
    // A stopped container's persisted IP is a stale DHCP lease — matching on it
    // could point a tile at whatever holds that address now.
    if (summary.state === 'running' && config?.network?.ip) add(config.network.ip, workload);
  }

  for (const { vm, net } of deployment.vms) {
    const workload = {
      type: 'vm',
      name: vm.name,
      state: vm.state,
      updateAvailable: false,
      iconId: vm.iconId ?? null,
    };
    add(vm.name, workload);
    if (vm.localDns) add(`${vm.name}.local`, workload);
    add(net.hostname, workload);
    add(net.ip, workload);
  }

  return index;
}

/** Links published by app modules — one pass over every container with an app. */
function collectAppLinks(deployment) {
  const candidates = [];
  for (const { summary, config } of deployment.containers) {
    const appId = config?.metadata?.app;
    if (!appId) continue;
    const appModule = getAppModule(appId);
    if (!appModule?.getPublishedLinks) continue;
    let links;
    try {
      links = appModule.getPublishedLinks(config.metadata.appConfig) || [];
    } catch {
      /* A malformed appConfig must not take the whole page down — the app's own
       * config screen is where that gets reported. */
      continue;
    }
    for (const link of links) {
      const url = canonicalUrl(link?.url);
      if (!url) continue;
      candidates.push({
        url,
        source: 'app',
        publisher: summary.name,
        publisherRunning: summary.state === 'running',
        target: link.target,
        label: typeof link.label === 'string' ? link.label.trim() : '',
      });
    }
  }
  return candidates;
}

/** Links implied by declared `_http._tcp` / `_https._tcp` mDNS services. */
function collectMdnsLinks(deployment) {
  const candidates = [];
  for (const { summary, config } of deployment.containers) {
    if (!config?.localDns || !Array.isArray(config.services)) continue;
    const hostname = config.mdnsHostname || `${summary.name}.local`;
    for (const service of config.services) {
      const scheme = HTTP_SERVICE_TYPES.get(service?.type);
      if (!scheme) continue;
      const url = canonicalUrl(`${scheme}://${hostname}:${service.port}`);
      if (!url) continue;
      candidates.push({
        url,
        source: 'mdns',
        publisher: summary.name,
        publisherRunning: summary.state === 'running',
        target: hostname,
        label: '',
      });
    }
  }
  return candidates;
}

/** User-added links. Stateless by construction — no workload join. */
function collectManualLinks(homepage) {
  const candidates = [];
  for (const tile of homepage.manualTiles) {
    const url = canonicalUrl(tile.url);
    if (!url) continue;
    candidates.push({
      url,
      source: 'manual',
      publisher: tile.name || url,
      publisherRunning: false,
      manualTileId: tile.id,
      label: tile.name || '',
      iconId: tile.iconId || null,
    });
  }
  return candidates;
}

/**
 * Collapse same-URL candidates: source priority first, then "prefer the link
 * whose backing container runs". Losers are kept as `conflicts` on the winner
 * so edit mode can explain why a link the user configured isn't its own tile.
 */
function dedupeByUrl(candidates) {
  const byUrl = new Map();
  for (const candidate of candidates) {
    const existing = byUrl.get(candidate.url);
    if (!existing) {
      byUrl.set(candidate.url, { ...candidate, conflicts: [] });
      continue;
    }
    const beats =
      SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[existing.source] ||
      (SOURCE_PRIORITY[candidate.source] === SOURCE_PRIORITY[existing.source] &&
        candidate.publisherRunning &&
        !existing.publisherRunning);
    const [winner, loser] = beats ? [candidate, existing] : [existing, candidate];
    /* One publisher stating the same URL two ways — a Jellyfin container with a
     * published URL *and* an `_http._tcp` service on the same port — is not a
     * conflict, it is one fact said twice. Only cross-publisher collisions are
     * worth surfacing. */
    const conflicts = [...(existing.conflicts || [])];
    if (loser.publisher !== winner.publisher) {
      conflicts.push({
        source: loser.source,
        publisher: loser.publisher,
        manualTileId: loser.manualTileId ?? null,
      });
    }
    byUrl.set(candidate.url, { ...winner, conflicts });
  }
  return [...byUrl.values()];
}

/**
 * Derive the `{ tiles, groups }` envelope from an already-gathered deployment
 * and the persisted overlay. Pure — no IO — which is the seam that makes the
 * whole derivation exercisable from a fixture on a machine that has neither
 * libvirt nor containerd. `buildHomeEnvelope` below is the IO shell.
 *
 * Every tile is reported, hidden ones included, with `hidden` on the tile —
 * edit mode has to be able to bring one back, and one payload beats two.
 */
export function deriveHomeEnvelope(deployment, homepage) {
  const workloadIndex = buildWorkloadIndex(deployment);

  const candidates = dedupeByUrl([
    ...collectAppLinks(deployment),
    ...collectMdnsLinks(deployment),
    ...collectManualLinks(homepage),
  ]);

  const tiles = candidates.map((candidate) => {
    /* A link with a target names what it fronts, and only that: an unresolved
     * target means the service lives on another machine, so the tile is
     * stateless — falling back to the publisher there would light Caddy's
     * lantern for every host it proxies off-box. A link with no target (a
     * jellyfin/zot published URL, an mDNS service) *is* its publisher's own
     * address, so that is the workload. Manual links never join. */
    const workload =
      candidate.source === 'manual'
        ? null
        : candidate.target
          ? workloadIndex.get((targetHostname(candidate.target) || '').toLowerCase()) || null
          : workloadIndex.get(candidate.publisher.toLowerCase()) || null;

    const id = candidate.manualTileId ?? candidate.url;
    const override = homepage.overrides[id] || {};
    const host = new URL(candidate.url).host;

    return {
      id,
      kind: candidate.source === 'manual' ? 'manual' : 'derived',
      source: candidate.source,
      name: override.name || candidate.label || workload?.name || hostLabel(host),
      url: candidate.url,
      host,
      // A manual tile carries its own icon; a derived one inherits the icon the
      // user already picked for the workload it points at.
      iconId: override.iconId || candidate.iconId || workload?.iconId || DEFAULT_ICON_ID,
      hidden: override.hidden === true,
      workload: workload
        ? {
            type: workload.type,
            name: workload.name,
            state: workload.state,
            updateAvailable: workload.updateAvailable,
          }
        : null,
      conflicts: candidate.conflicts,
    };
  });

  const tileIds = new Set(tiles.map((t) => t.id));
  const groups = homepage.groups.map((group) => ({
    id: group.id,
    name: group.name,
    builtin: false,
    tileIds: group.tiles.filter((id) => tileIds.has(id)),
  }));

  /* Newly derived links land in Ungrouped until filed or hidden. It is
   * synthetic — never persisted — and always last, so named groups stay on top. */
  const grouped = new Set(groups.flatMap((g) => g.tileIds));
  groups.push({
    id: UNGROUPED_GROUP_ID,
    name: 'Ungrouped',
    builtin: true,
    tileIds: tiles.filter((t) => !grouped.has(t.id)).map((t) => t.id),
  });

  return { tiles, groups };
}

/** The live envelope: gather the deployment, read the overlay, derive. */
export async function buildHomeEnvelope() {
  const [deployment, homepage] = await Promise.all([gatherDeployment(), getHomepage()]);
  return deriveHomeEnvelope(deployment, homepage);
}
