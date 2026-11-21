/**
 * The VM page's group editors, pure: each group's values from the VM's config, what its
 * Save sends for them (the changed fields only: `changedFields`), and what keeps them
 * from being saved. Also what the System group says of the settings in one line.
 */

/* ---- Size ---- */

export const SIZE_PRESETS = [
  { value: 'small', label: 'Small', vcpus: 2, memoryMiB: 2048 },
  { value: 'medium', label: 'Medium', vcpus: 2, memoryMiB: 4096 },
  { value: 'large', label: 'Large', vcpus: 4, memoryMiB: 8192 },
];
export const CUSTOM_SIZE = 'custom';

/** What a memory size says on the page: GB to one decimal, or MB below 1 GB. */
export function memoryText(mib) {
  if (mib == null) return '—';
  if (mib < 1024) return `${mib} MB`;
  const gb = mib / 1024;
  return `${Number.isInteger(gb) ? gb : Math.round(gb * 10) / 10} GB`;
}

export const coresText = (n) => `${n} ${n === 1 ? 'core' : 'cores'}`;

/** The size form: the preset the stored size matches, else custom; memory typed in GB. */
export function sizeForm(config) {
  const vcpus = config.vcpus ?? 1;
  const memoryMiB = config.memoryMiB ?? 1024;
  const preset = SIZE_PRESETS.find((p) => p.vcpus === vcpus && p.memoryMiB === memoryMiB);
  return { preset: preset?.value ?? CUSTOM_SIZE, vcpus: String(vcpus), memoryGB: String(Math.round((memoryMiB / 1024) * 100) / 100) };
}

/** The form once a preset is picked: its cores and memory fill the fields. */
export function withPreset(form, preset) {
  const p = SIZE_PRESETS.find((x) => x.value === preset);
  if (!p) return { ...form, preset: CUSTOM_SIZE };
  return { preset: p.value, vcpus: String(p.vcpus), memoryGB: String(p.memoryMiB / 1024) };
}

/** What Save sends: whole cores, memory in MiB; a value that is not one is sent as typed. */
export function sizeSent(form) {
  const vcpus = Number(form.vcpus);
  const gb = Number(form.memoryGB);
  return {
    vcpus: Number.isInteger(vcpus) ? vcpus : form.vcpus,
    memoryMiB: form.memoryGB.trim() !== '' && Number.isFinite(gb) ? Math.round(gb * 1024) : form.memoryGB,
  };
}

/** Why the size cannot be saved, by field: the server takes 1 to 128 whole cores and at
 *  least 128 MiB. */
export function sizeProblems(form) {
  const problems = {};
  const { vcpus, memoryMiB } = sizeSent(form);
  if (!Number.isInteger(vcpus) || vcpus < 1 || vcpus > 128) problems.vcpus = 'Cores are a whole number from 1 to 128.';
  if (!Number.isInteger(memoryMiB) || memoryMiB < 128) problems.memoryGB = 'Memory is a number of GB, at least 0.125.';
  return problems;
}

/* ---- Expert settings ---- */

export const FIRMWARE = [
  { value: 'uefi', label: 'UEFI' },
  { value: 'uefi-secure', label: 'UEFI with Secure Boot' },
  { value: 'bios', label: 'BIOS' },
];
export const MACHINE_TYPES = [
  { value: 'q35', label: 'Q35' },
  { value: 'pc-i440fx', label: 'i440fx' },
];
export const CPU_MODELS = [
  { value: 'host-passthrough', label: 'The host’s CPU' },
  { value: 'host-model', label: 'A model like the host’s' },
  { value: 'qemu64', label: 'Generic x86-64' },
];
export const VIDEO = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'qxl', label: 'QXL' },
  { value: 'vga', label: 'VGA' },
];
export const CONSOLE = [
  { value: 'vnc', label: 'VNC' },
  { value: 'spice', label: 'SPICE' },
];
export const BOOT_DEVICES = [
  { value: 'hd', label: 'Disk' },
  { value: 'cdrom', label: 'CD' },
  { value: 'network', label: 'Network' },
];
export const OPERATING_SYSTEMS = [
  { value: 'Linux', label: 'Linux' },
  { value: 'Windows', label: 'Windows' },
];

/** The machine type as the form offers it (the stored one names a version: pc-q35-9.2). */
function machineChoice(raw) {
  const s = raw || '';
  if (s.includes('q35')) return 'q35';
  if (s.includes('440')) return 'pc-i440fx';
  return s || 'q35';
}

/** The operating system a VM's settings follow: Windows when its config reads as one. */
export const vmOperatingSystem = (config) => (config.osCategory === 'windows' ? 'Windows' : 'Linux');

export function expertForm(config) {
  return {
    bootOrder: config.bootOrder?.length ? [...config.bootOrder] : ['hd'],
    bootMenu: config.bootMenu === true,
    firmware: config.firmware || 'bios',
    machineType: machineChoice(config.machineType),
    cpuMode: config.cpuMode || 'host-passthrough',
    nestedVirt: config.nestedVirt === true,
    videoDriver: config.videoModel || 'virtio',
    graphicsType: config.graphics?.type || 'vnc',
    guestAgent: config.guestAgent ?? true,
    memBalloon: config.memBalloon ?? true,
    virtioRng: config.virtioRng ?? true,
    vtpm: config.vtpm === true,
    osType: vmOperatingSystem(config),
  };
}

/** The boot order with `dev` added at the end, or taken out (one device always stays). */
export function toggledBootDevice(order, dev) {
  if (!order.includes(dev)) return [...order, dev];
  return order.length > 1 ? order.filter((d) => d !== dev) : order;
}

/** The settings in one line, as the System group shows them. */
export function systemSummary(config) {
  const label = (list, value) => list.find((x) => x.value === value)?.label ?? value;
  const f = expertForm(config);
  return [
    label(FIRMWARE, f.firmware),
    label(MACHINE_TYPES, f.machineType),
    f.cpuMode === 'host-passthrough' ? 'host CPU' : label(CPU_MODELS, f.cpuMode),
    `${label(VIDEO, f.videoDriver)} video`,
    f.guestAgent ? 'guest agent' : null,
    f.vtpm ? 'TPM' : null,
    config.features?.hyperv ? 'Windows tuning' : null,
  ].filter(Boolean).join(', ');
}

/* ---- Network ---- */

/** The adapters as the PATCH takes them: an adapter defined outside Wisp may read back
 *  with no bridge, model or MAC, sent as an empty string, and VirtIO for the model. */
export const nicsForApi = (nics) => (nics ?? []).map((n) => ({
  type: n.type || 'bridge',
  mac: n.mac ?? '',
  source: n.source ?? '',
  model: n.model || 'virtio',
}));
