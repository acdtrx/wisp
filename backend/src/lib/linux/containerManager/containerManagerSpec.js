/**
 * OCI runtime spec builder for containers.
 * Generates a linux container spec from a container.json config + image config.
 */
import { join } from 'node:path';

import { getContainerNetnsPath } from './containerPaths.js';
import { resolveMountHostPath, TMPFS_DEFAULT_SIZE_MIB } from './containerManagerMounts.js';

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
 * @param {Array<{ id: string, mountPath: string }>} [opts.storageMounts] - settings.mounts, required when any mount uses sourceId
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

  // By default match the backend deploy user so bind mounts under files/ remain owned by the same
  // uid/gid and the backend can delete them. When runAsRoot is set, use 0/0 — needed for images
  // that write to root-owned directories inside the container (e.g. OpenWebUI's /app). When the
  // chosen container UID for a Local mount differs from deployUid, attach a size:1 idmapping so
  // the in-container UID lands on disk as deployUid (and same for GID) — host backend can then
  // clean up the files without sudo.
  const deployUid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const deployGid = typeof process.getgid === 'function' ? process.getgid() : 0;

  const mounts = [...DEFAULT_MOUNTS];
  const storageMounts = opts.storageMounts || [];
  if (config.mounts) {
    for (const m of config.mounts) {
      if (!m?.name) continue;
      if (m.type === 'tmpfs') {
        const sizeMiB = Number.isInteger(m.sizeMiB) && m.sizeMiB > 0 ? m.sizeMiB : TMPFS_DEFAULT_SIZE_MIB;
        // mode=1777 mirrors /tmp semantics so any in-container UID can write — files only exist
        // for the lifetime of the task and are gone on stop, so the on-disk-ownership concerns
        // that drive idmap on Local mounts don't apply here.
        mounts.push({
          destination: m.containerPath,
          type: 'tmpfs',
          source: 'tmpfs',
          options: ['nosuid', 'nodev', 'mode=1777', `size=${sizeMiB}m`],
        });
        continue;
      }
      if (m.type !== 'file' && m.type !== 'directory') continue;
      const { hostPath, source } = resolveMountHostPath(m, containerFilesDir, storageMounts);
      const mountOpts = ['rbind'];
      if (m.readonly) mountOpts.push('ro');
      const entry = {
        destination: m.containerPath,
        type: 'bind',
        source: hostPath,
        options: mountOpts,
      };
      // Idmap is only applied to Local mounts when runAsRoot is on. Storage mounts often live on
      // filesystems (CIFS/SMB, NFS) that don't support idmapped mounts, so we never attach there.
      // The size:1 idmap is attached unconditionally — even when the chosen container UID equals
      // deployUid — so the mount contract is consistent: exactly the configured in-container
      // UID/GID writes cleanly to the host as deployUid/deployGid; writes by any other in-container
      // UID hit the unmapped path (kernel-dependent: stored as overflowuid on disk, or EOVERFLOW).
      //
      // OCI mount idmap field convention is the OPPOSITE of `linux.uidMappings` (full userns):
      //   - containerID = UID on the source file system (i.e. on-disk)
      //   - hostID      = UID at the destination mount point (i.e. what the container sees)
      // We want: container process running as `cUid` writes files stored on disk as `deployUid`,
      // so the mapping is { containerID: deployUid, hostID: cUid, size: 1 }.
      if (config.runAsRoot && source === 'local') {
        const cUid = Number.isInteger(m.containerOwnerUid) ? m.containerOwnerUid : 0;
        const cGid = Number.isInteger(m.containerOwnerGid) ? m.containerOwnerGid : 0;
        entry.uidMappings = [{ containerID: deployUid, hostID: cUid, size: 1 }];
        entry.gidMappings = [{ containerID: deployGid, hostID: cGid, size: 1 }];
      }
      mounts.push(entry);
    }
  }
  mounts.push({
    destination: '/etc/resolv.conf',
    type: 'bind',
    source: opts.resolvConfPath || '/etc/resolv.conf',
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
