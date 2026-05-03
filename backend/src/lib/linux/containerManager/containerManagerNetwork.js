/**
 * CNI-based bridge networking for containers.
 * Invokes the bridge CNI plugin to attach containers as veth ports on a host Linux bridge
 * (br0 or a VLAN sub-bridge br0-vlanN), so containers look like VMs on the wire and the host
 * can reach them directly.
 *
 * Network namespace creation and CNI require privileges. As the deploy user (systemd
 * `User=`), the backend uses **`sudo -n`** with **`wisp-netns`** and **`wisp-cni`**
 * installed by `install-helpers.sh` (same pattern as `wisp-mount`).
 */
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  access, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { containerError, containerState } from './containerManagerConnection.js';
import { CONTAINER_NETNS_DIR, getContainerDir, getContainerNetnsPath } from './containerPaths.js';
import { writeContainerConfig } from './containerManagerConfigIo.js';
import { ipv4CidrFromProcFibTrie } from '../../networking/index.js';

const execFile = promisify(execFileCb);

/** Unicast locally administered MAC (same idea as VM NICs). */
export function generateContainerMac() {
  const b = randomBytes(3);
  const h = (n) => n.toString(16).padStart(2, '0');
  return `52:54:00:${h(b[0])}:${h(b[1])}:${h(b[2])}`;
}

/**
 * Normalize and validate a MAC for the CNI bridge plugin `mac` field.
 * Returns lowercase `aa:bb:...` or null.
 */
export function normalizeContainerMac(input) {
  if (input == null || input === '') return null;
  const s = String(input).trim().toLowerCase();
  if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(s)) return null;
  return s;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const CNI_BIN_DIR = process.env.WISP_CNI_BIN_DIR || '/opt/cni/bin';
const CNI_CONF_DIR = process.env.WISP_CNI_CONF_DIR || '/etc/cni/net.d';
const CNI_CONF_NAME = '10-wisp-bridge.conflist';
const NETNS_INSTALLED = '/usr/local/bin/wisp-netns';
const CNI_INSTALLED = '/usr/local/bin/wisp-cni';

function bundledScript(name) {
  return join(__dirname, '../../scripts', name);
}

async function resolveNetnsScript() {
  const override = process.env.WISP_NETNS_SCRIPT;
  if (override) return override;
  try {
    await access(NETNS_INSTALLED);
    return NETNS_INSTALLED;
  } catch {
    try {
      await access(bundledScript('wisp-netns'));
      return bundledScript('wisp-netns');
    } catch {
      return null;
    }
  }
}

async function resolveCniScript() {
  const override = process.env.WISP_CNI_SCRIPT;
  if (override) return override;
  try {
    await access(CNI_INSTALLED);
    return CNI_INSTALLED;
  } catch {
    try {
      await access(bundledScript('wisp-cni'));
      return bundledScript('wisp-cni');
    } catch {
      return null;
    }
  }
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

/**
 * Reject anything that isn't an existing Linux bridge.
 * `/sys/class/net/<iface>/bridge` is a directory that exists only on bridges — not on
 * macvlan/bond/veth/physical — so a pair of sysfs access() calls is enough.
 *
 * Without this, the bridge CNI plugin will happily create an orphan bridge under that name.
 */
async function assertIsLinuxBridge(iface) {
  if (!iface || typeof iface !== 'string') {
    throw containerError('CONTAINERD_ERROR', 'Container bridge interface is not set');
  }
  try {
    await access(`/sys/class/net/${iface}`);
  } catch {
    throw containerError(
      'CONTAINERD_ERROR',
      `Container bridge "${iface}" does not exist on the host`,
    );
  }
  try {
    await access(`/sys/class/net/${iface}/bridge`);
  } catch {
    throw containerError(
      'CONTAINERD_ERROR',
      `Container interface "${iface}" is not a Linux bridge`,
    );
  }
}

/**
 * Build stdin JSON for a single CNI plugin invocation.
 * A .conflist stores `cniVersion` and `name` at the top level only; each `plugins[]`
 * entry is missing those fields. The bridge (and DHCP IPAM) plugins require a full
 * netconf — without `name`, ADD fails immediately with an opaque exit code.
 */
function executablePluginNetconf(cniDoc, pluginIndex = 0) {
  if (cniDoc.plugins?.length) {
    const p = { ...cniDoc.plugins[pluginIndex] };
    return {
      ...p,
      cniVersion: cniDoc.cniVersion || p.cniVersion || '1.0.0',
      name: cniDoc.name || p.name || 'wisp-bridge',
      type: p.type || 'bridge',
    };
  }
  const copy = { ...cniDoc };
  if (!copy.cniVersion) copy.cniVersion = '1.0.0';
  if (!copy.name) copy.name = 'wisp-bridge';
  if (!copy.type) copy.type = 'bridge';
  return copy;
}

function buildPluginConfig(cniConfig, networkConfig = {}) {
  const pluginConfig = executablePluginNetconf(cniConfig, 0);

  if (networkConfig.interface) {
    pluginConfig.bridge = String(networkConfig.interface).trim();
  }

  // The CNI bridge plugin does NOT read a top-level `mac` field (unlike macvlan).
  // It reads from `args.cni.mac` or `runtimeConfig.mac`. Without this, every
  // container start gets a fresh kernel-generated random MAC on eth0, so DHCP
  // leases never stabilize and the router accumulates orphaned lease rows.
  const macNorm = normalizeContainerMac(networkConfig.mac);
  if (macNorm) {
    pluginConfig.args = {
      ...(pluginConfig.args || {}),
      cni: { ...(pluginConfig.args?.cni || {}), mac: macNorm },
    };
  }

  return pluginConfig;
}

/**
 * Read the Wisp bridge CNI config. Creates a default one if it doesn't exist.
 */
async function getCNIConfig() {
  const confPath = join(CNI_CONF_DIR, CNI_CONF_NAME);
  try {
    const raw = await readFile(confPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {
      cniVersion: '1.0.0',
      name: 'wisp-bridge',
      plugins: [
        {
          type: 'bridge',
          bridge: 'br0',
          isGateway: false,
          isDefaultGateway: false,
          ipMasq: false,
          hairpinMode: false,
          promiscMode: false,
          forceAddress: false,
          ipam: { type: 'dhcp' },
        },
      ],
    };
  }
}

/**
 * Execute a CNI plugin (via wisp-cni + sudo when not root).
 */
async function execCNI(plugin, command, containerID, netns, config) {
  const cniScript = await resolveCniScript();
  const tmpDir = await mkdtemp(join(tmpdir(), 'wisp-cni-'));
  const confPath = join(tmpDir, 'plugin.json');
  await writeFile(confPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });

  const env = {
    ...process.env,
    CNI_PATH: CNI_BIN_DIR,
  };

  try {
    if (cniScript) {
      const tail = [command, plugin, containerID, netns, confPath, CNI_BIN_DIR];
      const execOpts = {
        env,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      };
      const { stdout } = isRoot()
        ? await execFile(cniScript, tail, execOpts)
        : await execFile('sudo', ['-n', cniScript, ...tail], execOpts);
      try {
        return stdout ? JSON.parse(stdout) : {};
      } catch {
        /* CNI stdout not JSON — treat as empty result */
        return {};
      }
    }

    // Fallback: direct plugin (dev as root only; usually fails for deploy user)
    const binPath = join(CNI_BIN_DIR, plugin);
    const { stdout } = await execFile(binPath, [], {
      env: {
        ...env,
        CNI_COMMAND: command,
        CNI_CONTAINERID: containerID,
        CNI_NETNS: netns,
        CNI_IFNAME: 'eth0',
        CNI_PATH: CNI_BIN_DIR,
      },
      input: JSON.stringify(config),
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    try {
      return stdout ? JSON.parse(stdout) : {};
    } catch {
      /* CNI stdout not JSON — treat as empty result */
      return {};
    }
  } catch (err) {
    const se = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString() || '');
    const sx = typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString() || '');
    const detail = `${se} ${sx} ${err.message || ''}`.trim();
    throw containerError(
      'CONTAINERD_ERROR',
      `CNI ${command} failed for "${containerID}": ${detail || err.message}`,
      detail || err.message,
    );
  } finally {
    /* Best-effort cleanup of temp CNI config dir; ignore if already removed */
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Create a network namespace for a container (privileged via wisp-netns when needed).
 */
async function ensureNetNS(name) {
  const nsPath = getContainerNetnsPath(name);
  const netnsScript = await resolveNetnsScript();

  try {
    await access(nsPath);
    return nsPath;
  } catch {
    /* need to create */
  }

  if (netnsScript) {
    try {
      if (isRoot()) {
        await execFile(netnsScript, ['add', name], { timeout: 15000 });
      } else {
        await execFile('sudo', ['-n', netnsScript, 'add', name], { timeout: 15000 });
      }
    } catch (err) {
      throw containerError(
        'CONTAINERD_ERROR',
        `Failed to create netns for "${name}" (${err.message || 'sudo or helper failed'}). Install helpers: sudo scripts/linux/setup/install-helpers.sh or ./scripts/wispctl.sh helpers`,
        err.stderr?.toString() || err.message,
      );
    }
    try {
      await access(nsPath);
      return nsPath;
    } catch {
      throw containerError('CONTAINERD_ERROR', `Netns path missing after create: ${nsPath}`);
    }
  }

  // No helper: try unprivileged mkdir + ip (fails for typical deploy user)
  try {
    await access(CONTAINER_NETNS_DIR);
  } catch {
    throw containerError(
      'CONTAINERD_ERROR',
      `Cannot use ${CONTAINER_NETNS_DIR} without wisp-netns. Run server setup (install-helpers.sh) as root.`,
      'EACCES or missing helper',
    );
  }

  try {
    await execFile('ip', ['netns', 'add', name], { timeout: 15000 });
    return nsPath;
  } catch (err) {
    const msg = `${err.message || ''} ${err.stderr?.toString() || ''}`;
    if (/file exists|already exists/i.test(msg)) {
      return nsPath;
    }
    throw containerError(
      'CONTAINERD_ERROR',
      `Failed to create netns for "${name}". Install wisp-netns (see DEPLOYMENT.md).`,
      msg.trim(),
    );
  }
}

/**
 * Remove a network namespace.
 */
async function removeNetNS(name) {
  const netnsScript = await resolveNetnsScript();
  if (netnsScript) {
    try {
      if (isRoot()) {
        await execFile(netnsScript, ['delete', name], { timeout: 15000 });
      } else {
        await execFile('sudo', ['-n', netnsScript, 'delete', name], { timeout: 15000 });
      }
    } catch {
      /* best effort */
    }
    return;
  }
  /* Best-effort netns delete without helper; ignore if namespace already gone */
  await execFile('ip', ['netns', 'delete', name], { timeout: 15000 }).catch(() => {});
}

/**
 * First IPv4 address from a CNI ADD `ips` array (e.g. `"192.168.1.50/24"`).
 */
export function primaryIPv4FromCni(ips) {
  if (!Array.isArray(ips)) return null;
  for (const e of ips) {
    if (e && String(e.version) === '4' && typeof e.address === 'string' && e.address.length) {
      return e.address;
    }
  }
  return null;
}

function pickMacFromCniResult(result) {
  const ifs = result?.interfaces;
  if (!Array.isArray(ifs) || !ifs.length) return null;
  const v4 = result.ips?.find((x) => String(x.version) === '4');
  if (v4 && typeof v4.interface === 'number' && ifs[v4.interface]?.mac) {
    return ifs[v4.interface].mac;
  }
  const withSandbox = ifs.find((i) => i.sandbox && i.mac);
  return withSandbox?.mac || ifs.find((i) => i.mac)?.mac || null;
}

/**
 * Parse first `inet a.b.c.d/len` from `ip -4 addr show` output.
 */
export function parseIpv4FromIpAddrText(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/inet\s+([\d.]+\/\d+)/);
  return m ? m[1] : null;
}

const DEFAULT_IPV4_POLL = { maxAttempts: 80, sleepMs: 250 };

/**
 * Read IPv4 on `eth0` inside the netns. Used after CNI ADD (DHCP often lags the CNI result)
 * and lazily when loading config if `network.ip` was never persisted.
 *
 * @param {object} [pollOpts] — `{ maxAttempts, sleepMs }` (default ~20s total at start)
 * @param {number|null} [taskPid] — when set, try `/proc/<pid>/net/fib_trie` first (no sudo)
 */
async function discoverIpv4InNetns(name, ifname = 'eth0', pollOpts = DEFAULT_IPV4_POLL, taskPid = null) {
  const netnsScript = await resolveNetnsScript();
  if (!netnsScript && !taskPid) return null;

  const maxAttempts = pollOpts.maxAttempts ?? DEFAULT_IPV4_POLL.maxAttempts;
  const sleepMs = pollOpts.sleepMs ?? DEFAULT_IPV4_POLL.sleepMs;

  const runOnce = async () => {
    if (taskPid) {
      const fromProc = await ipv4CidrFromProcFibTrie(taskPid);
      if (fromProc) return { ip: fromProc, fatal: false };
    }
    if (!netnsScript) return { ip: null, fatal: false };
    try {
      const opts = { timeout: 8000, maxBuffer: 65536, encoding: 'utf8' };
      const { stdout } = isRoot()
        ? await execFile(netnsScript, ['ipv4', name, ifname], opts)
        : await execFile('sudo', ['-n', netnsScript, 'ipv4', name, ifname], opts);
      const ip = parseIpv4FromIpAddrText(stdout);
      return { ip, fatal: false };
    } catch (err) {
      const se = `${err.stderr || ''} ${err.message || ''}`;
      // Old wisp-netns without `ipv4` — do not poll for seconds; upgrade install-helpers.
      if (/Usage/i.test(se)) {
        containerState.logger?.warn(
          'wisp-netns has no "ipv4" command — re-run install-helpers.sh to persist container IPs (DHCP).',
        );
        return { ip: null, fatal: true };
      }
      return { ip: null, fatal: false };
    }
  };

  // Exponential backoff (matches waitForStop / waitUntilTaskStoppedOrGone in
  // this module). Total budget is preserved at maxAttempts * sleepMs so
  // existing callers see roughly the same upper bound. Initial 250 ms catches
  // fast LAN/dnsmasq leases; doubling capped at 1 s avoids busy-polling when
  // a slow DHCP exchange is genuinely going to take seconds.
  const deadline = Date.now() + maxAttempts * sleepMs;
  let nextSleep = sleepMs;
  while (Date.now() < deadline) {
    const { ip, fatal } = await runOnce();
    if (fatal) return null;
    if (ip) return ip;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(nextSleep, remaining)));
    nextSleep = Math.min(nextSleep * 2, 1000);
  }
  return null;
}

/**
 * Single-shot wrapper around `discoverIpv4InNetns`. Used by the periodic
 * mDNS reconciler — a 60s tick can't afford to sit on the default 20s poll
 * budget, but one quick lookup per container is fine.
 */
export async function discoverIpv4InNetnsOnce(name, ifname = 'eth0') {
  return discoverIpv4InNetns(name, ifname, { maxAttempts: 1, sleepMs: 0 });
}

/**
 * If the container has no persisted `network.ip` yet, read the live address from the netns
 * and save `container.json`. Call from GET config when the task is running — DHCP often
 * appears after the initial start-time poll.
 */
export async function persistContainerIpFromNetnsIfMissing(name, config, taskPid = 0) {
  if (config.network?.type !== 'bridge' || config.network?.ip) return config;
  const pid = taskPid > 0 ? taskPid : null;
  const ip = await discoverIpv4InNetns(name, 'eth0', { maxAttempts: 30, sleepMs: 200 }, pid);
  if (!ip) return config;
  return mergeNetworkLeaseIntoConfig(name, config, {
    ips: [],
    discoveredIp: ip,
  });
}

/**
 * Persist CNI ADD lease (IP, MAC) into `container.json` so the API/UI can show them.
 */
export async function mergeNetworkLeaseIntoConfig(name, config, lease) {
  if (!lease || config.network?.type !== 'bridge') return config;
  const ip = primaryIPv4FromCni(lease.ips) || lease.discoveredIp || null;
  const next = {
    ...config,
    network: { ...config.network },
  };
  if (ip) next.network.ip = ip;
  if (lease.mac && !next.network.mac) next.network.mac = lease.mac;
  await writeContainerConfig(name, next);
  return next;
}

const WISP_MDNS_STUB_IP = '169.254.53.53';
const WISP_CONTAINER_RESOLV_CONF = '/var/lib/wisp/container-resolv.conf';

/**
 * Check if a bridge carries the Wisp mDNS stub IP. Written by
 * `scripts/linux/setup/container-dns.sh` to br0 as a stable link-local address
 * that wisp's in-process DNS forwarder (mdnsForwarder.js) listens on.
 * If present, containers on this bridge can query 169.254.53.53 to reach the
 * forwarder, which resolves `.local` via avahi DBus and relays everything else
 * to the host's upstream DNS.
 */
async function bridgeHasMdnsStubIp(bridgeInterface) {
  if (!bridgeInterface) return false;
  try {
    const { stdout } = await execFile('ip', ['-4', 'addr', 'show', 'dev', bridgeInterface], {
      timeout: 5000, encoding: 'utf8', maxBuffer: 65536,
    });
    return stdout.includes(`${WISP_MDNS_STUB_IP}/`);
  } catch {
    return false;
  }
}

/**
 * Install an on-link /32 route for the mDNS stub IP inside the container's netns.
 *
 * Why: the container gets its default route via DHCP (LAN gateway). Without a specific
 * route for 169.254.53.53, the kernel forwards DNS queries to the LAN gateway, which
 * black-holes them (3-second timeout). Adding `169.254.53.53/32 dev eth0` makes the
 * container ARP directly on its veth; the host br0 (which carries that IP) answers
 * and wisp's DNS forwarder handles the query.
 *
 * Best-effort: a failure here logs a warning but does not block the container start.
 */
async function installMdnsStubRoute(name) {
  const netnsScript = await resolveNetnsScript();
  if (!netnsScript) return;
  const tail = ['route-add', name, 'eth0', WISP_MDNS_STUB_IP];
  const opts = { timeout: 8000, maxBuffer: 65536, encoding: 'utf8' };
  try {
    if (isRoot()) {
      await execFile(netnsScript, tail, opts);
    } else {
      await execFile('sudo', ['-n', netnsScript, ...tail], opts);
    }
  } catch (err) {
    const detail = `${err.stderr || ''} ${err.message || ''}`.trim();
    containerState.logger?.warn(
      `Failed to install mDNS stub route (169.254.53.53) in netns "${name}": ${detail}. ` +
      '.local resolution inside this container will not work until helpers are refreshed.',
    );
  }
}

/**
 * Determine the resolv.conf to bind-mount into a container.
 * When the container's bridge has the Wisp mDNS stub IP and the shared resolv.conf
 * exists (setup-server.sh ran `container-dns.sh`), use it so `.local` names resolve
 * through wisp's DNS forwarder. Otherwise fall back to the host's upstream
 * resolvers — on systemd-resolved hosts, `/etc/resolv.conf` points at the stub
 * (`127.0.0.53`) which is unreachable from a container netns, so prefer
 * `/run/systemd/resolve/resolv.conf` when present.
 */
export async function resolveContainerResolvConf(bridgeInterface = null) {
  if (await bridgeHasMdnsStubIp(bridgeInterface)) {
    try {
      await access(WISP_CONTAINER_RESOLV_CONF);
      return WISP_CONTAINER_RESOLV_CONF;
    } catch {
      /* Stub IP exists but shared file is missing — fall through to host resolv.conf. */
    }
  }
  const upstream = '/run/systemd/resolve/resolv.conf';
  try {
    await access(upstream);
    return upstream;
  } catch {
    return '/etc/resolv.conf';
  }
}

/**
 * Normalize the container's network config so it is ready for a start.
 * Forces `network.type` to `"bridge"` (the only supported value) and assigns a
 * stable MAC if one is missing. `setupNetwork` guards on `type === 'bridge'`, so
 * any other value — legacy, empty, typo — would silently skip CNI and leave the
 * task in an empty netns.
 */
export async function ensureContainerNetworkConfig(name, config) {
  const needsTypeFix = config.network?.type !== 'bridge';
  const needsMac = !normalizeContainerMac(config.network?.mac);
  if (!needsTypeFix && !needsMac) return config;

  const next = {
    ...config,
    network: { ...(config.network || {}), type: 'bridge' },
  };
  if (needsMac) next.network.mac = generateContainerMac();
  await writeContainerConfig(name, next);
  return next;
}

/**
 * Set up bridge networking for a container.
 * Creates a network namespace and invokes the bridge CNI plugin to attach a veth
 * pair into the chosen host bridge (br0 or a VLAN sub-bridge).
 */
export async function setupNetwork(name, networkConfig = {}) {
  if (networkConfig.type !== 'bridge') return null;

  await assertIsLinuxBridge(networkConfig.interface);

  const cniConfig = await getCNIConfig();
  const pluginConfig = buildPluginConfig(cniConfig, networkConfig);

  const pluginName = pluginConfig.type || 'bridge';
  const nsPath = getContainerNetnsPath(name);

  // Reusing a netns that still has CNI's eth0 (e.g. after a failed stop) can make ADD fail.
  let hadNetns = false;
  try {
    await access(nsPath);
    hadNetns = true;
  } catch {
    /* will create below */
  }

  if (hadNetns) {
    try {
      await execCNI(pluginName, 'DEL', name, nsPath, pluginConfig);
    } catch {
      /* nothing to tear down or DEL failed — still try to drop netns */
    }
    await removeNetNS(name);
    let stillThere = false;
    try {
      await access(nsPath);
      stillThere = true;
    } catch {
      /* expected: path gone */
    }
    if (stillThere) {
      throw containerError(
        'CONTAINERD_ERROR',
        `Could not remove stale netns for "${name}" (busy or permission). On the host run: sudo ip netns delete ${name}`,
        nsPath,
      );
    }
  }

  const freshPath = await ensureNetNS(name);

  const result = await execCNI(
    pluginName,
    'ADD',
    name,
    freshPath,
    pluginConfig,
  );

  if (await bridgeHasMdnsStubIp(networkConfig.interface)) {
    await installMdnsStubRoute(name);
  }

  const fromCni = primaryIPv4FromCni(result.ips || []);
  const discoveredIp = fromCni ? null : await discoverIpv4InNetns(name, 'eth0', DEFAULT_IPV4_POLL);

  return {
    netns: freshPath,
    ips: result.ips || [],
    mac: pickMacFromCniResult(result),
    discoveredIp,
  };
}

/**
 * Tear down networking for a container.
 */
export async function teardownNetwork(name, networkConfig = {}) {
  if (networkConfig.type !== 'bridge') return;

  const nsPath = getContainerNetnsPath(name);
  const cniConfig = await getCNIConfig();
  const pluginConfig = buildPluginConfig(cniConfig, networkConfig);
  const pluginName = pluginConfig.type || 'bridge';

  try {
    await execCNI(pluginName, 'DEL', name, nsPath, pluginConfig);
  } catch {
    // Best effort
  }

  await removeNetNS(name);
}
