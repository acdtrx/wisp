/**
 * OCI runtime spec builder for containers.
 * Generates a linux container spec from a container.json config + image config.
 */
import { join } from 'node:path';

import { CONTAINER_SHARED_HOSTS_FILE, getContainerNetnsPath } from './containerPaths.js';

const DEFAULT_CAPS = [
  'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FSETID', 'CAP_FOWNER',
  'CAP_MKNOD', 'CAP_NET_RAW', 'CAP_SETGID', 'CAP_SETUID',
  'CAP_SETFCAP', 'CAP_SETPCAP', 'CAP_NET_BIND_SERVICE',
  'CAP_SYS_CHROOT', 'CAP_KILL', 'CAP_AUDIT_WRITE',
];

const DEFAULT_MOUNTS = [
  { destination: '/proc', type: 'proc', source: 'proc', options: ['nosuid', 'noexec', 'nodev'] },
  { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
  { destination: '/dev/pts', type: 'devpts', source: 'devpts', options: ['nosuid', 'noexec', 'newinstance', 'ptmxmode=0666', 'mode=0620', 'gid=5'] },
  { destination: '/dev/shm', type: 'tmpfs', source: 'shm', options: ['nosuid', 'noexec', 'nodev', 'mode=1777', 'size=65536k'] },
  { destination: '/dev/mqueue', type: 'mqueue', source: 'mqueue', options: ['nosuid', 'noexec', 'nodev'] },
  { destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
  { destination: '/sys/fs/cgroup', type: 'cgroup', source: 'cgroup', options: ['nosuid', 'noexec', 'nodev', 'relatime', 'ro'] },
  { destination: '/run', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=65536k'] },
];

const MASKED_PATHS = [
  '/proc/asound', '/proc/acpi', '/proc/kcore', '/proc/keys',
  '/proc/latency_stats', '/proc/timer_list', '/proc/timer_stats',
  '/proc/sched_debug', '/proc/scsi', '/sys/firmware', '/sys/devices/virtual/powercap',
];

const READONLY_PATHS = [
  '/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger',
];

/**
 * Build an OCI runtime spec from a Wisp container config and the OCI image config.
 * @param {object} config - Parsed container.json
 * @param {object} imageConfig - OCI image config (from manifest → config blob)
 * @param {string} containerFilesDir - Absolute path to the container's files/ directory
 * @param {object} [opts] - Extra options
 * @param {string} [opts.resolvConfPath] - Host resolv.conf to bind-mount (default: /etc/resolv.conf)
 * @param {string} [opts.hostsPath] - Host /etc/hosts to bind-mount (default: Wisp shared container hosts file)
 * @returns {object} OCI runtime spec (JSON-serializable)
 */
export function buildOCISpec(config, imageConfig = {}, containerFilesDir = '', opts = {}) {
  const imgCfg = imageConfig.config || imageConfig || {};

  const entrypoint = imgCfg.Entrypoint || [];
  const cmd = imgCfg.Cmd || [];
  const args = config.command?.length ? config.command : [...entrypoint, ...cmd];
  if (!args.length) args.push('/bin/sh');

  const baseEnv = imgCfg.Env || ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'];
  const userEnv = config.env
    ? Object.entries(config.env).map(([k, v]) => `${k}=${v?.value ?? ''}`)
    : [];
  const env = [...baseEnv, ...userEnv];

  const cwd = imgCfg.WorkingDir || '/';

  const mounts = [...DEFAULT_MOUNTS];
  if (config.mounts) {
    for (const m of config.mounts) {
      if (!m?.name || (m.type !== 'file' && m.type !== 'directory')) continue;
      const hostPath = join(containerFilesDir, m.name);
      const mountOpts = ['rbind'];
      if (m.readonly) mountOpts.push('ro');
      mounts.push({
        destination: m.containerPath,
        type: 'bind',
        source: hostPath,
        options: mountOpts,
      });
    }
  }
  mounts.push({
    destination: '/etc/resolv.conf',
    type: 'bind',
    source: opts.resolvConfPath || '/etc/resolv.conf',
    options: ['rbind', 'ro'],
  });
  mounts.push({
    destination: '/etc/hosts',
    type: 'bind',
    source: opts.hostsPath || CONTAINER_SHARED_HOSTS_FILE,
    options: ['rbind', 'ro'],
  });

  // CNI bridge configures `/var/run/netns/<name>`; runc must join that netns, not create a new one.
  const networkNamespace = config.network?.type === 'bridge' && config.name
    ? { type: 'network', path: getContainerNetnsPath(config.name) }
    : { type: 'network' };

  const resources = {};
  if (config.cpuLimit) {
    resources.cpu = {
      quota: Math.round(config.cpuLimit * 100000),
      period: 100000,
    };
  }
  if (config.memoryLimitMiB) {
    resources.memory = {
      limit: config.memoryLimitMiB * 1024 * 1024,
    };
  }

  // By default match the backend deploy user so bind mounts under files/ remain owned by the same
  // uid/gid and the backend can delete them. When runAsRoot is set, use 0/0 — needed for images
  // that write to root-owned directories inside the container (e.g. OpenWebUI's /app). Note that
  // bind-mount data created while running as root will be root-owned; delete may require sudo.
  const deployUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const deployGid = typeof process.getgid === 'function' ? process.getgid() : 0;
  const uid = config.runAsRoot ? 0 : deployUid;
  const gid = config.runAsRoot ? 0 : deployGid;

  return {
    ociVersion: '1.1.0',
    process: {
      terminal: false,
      user: { uid, gid },
      args,
      env,
      cwd,
      capabilities: {
        bounding: DEFAULT_CAPS,
        effective: DEFAULT_CAPS,
        permitted: DEFAULT_CAPS,
      },
      noNewPrivileges: true,
    },
    root: {
      path: 'rootfs',
      readonly: false,
    },
    hostname: config.name || 'container',
    mounts,
    linux: {
      resources,
      namespaces: [
        { type: 'pid' },
        { type: 'ipc' },
        { type: 'uts' },
        { type: 'mount' },
        networkNamespace,
        { type: 'cgroup' },
      ],
      maskedPaths: MASKED_PATHS,
      readonlyPaths: READONLY_PATHS,
    },
  };
}
