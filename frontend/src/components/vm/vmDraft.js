import { sizeProblems, sizeSent, withPreset } from './vmForms.js';
import { setupProblem } from './firstBootSetup.js';

/**
 * The New VM form's draft: the only state of a VM being created. `createVmBody` turns
 * it into the create request once, at submit; the server fills in the rest from the
 * profile (docs/specs/UI-VM.md, New VM).
 */

/** What "Runs" offers: the profile it creates, what it takes from the library, and
 *  where the form starts its size and disk. */
export const RUNS = [
  { value: 'linux-image', label: 'Linux image', detail: 'Ready in a minute', profile: 'linux', takes: ['disk'], preset: 'small', diskGB: 20 },
  { value: 'linux-installer', label: 'Linux installer', detail: 'Install from an ISO', profile: 'linux', takes: ['iso'], preset: 'small', diskGB: 32 },
  { value: 'windows-11', label: 'Windows 11', detail: 'Secure Boot and TPM set', profile: 'windows-11', takes: ['iso'], preset: 'large', diskGB: 64 },
  { value: 'other', label: 'Other', detail: 'Plain defaults', profile: 'other', takes: ['disk', 'iso'], preset: 'small', diskGB: 32 },
];

const runsOf = (value) => RUNS.find((r) => r.value === value) ?? RUNS[0];

/** The library images "Runs" can take (`library`: the library record's files). */
export const imagesFor = (runs, library) => (library ?? []).filter((f) => runsOf(runs).takes.includes(f.type));

/** The library's VirtIO driver ISO, which a Windows 11 VM takes as its second CD. */
export const driverIso = (library) => (library ?? []).find((f) => f.type === 'iso' && /^virtio-win/i.test(f.name)) ?? null;

function draftFor(runs, library, base) {
  const r = runsOf(runs);
  const size = withPreset({ preset: r.preset, vcpus: '', memoryGB: '' }, r.preset);
  return {
    ...base,
    runs: r.value,
    image: '',
    drivers: r.value === 'windows-11' ? (driverIso(library)?.name ?? '') : '',
    ...size,
    diskGB: String(r.diskGB),
  };
}

export const defaultVmDraft = (library) => draftFor('linux-image', library, {
  name: '', username: 'wisp', password: '', sshKeys: null,
});

/** The draft once "Runs" changes: its image, drivers, size and disk start afresh. */
export const withRuns = (draft, runs, library) => draftFor(runs, library, draft);

/** A host name from the VM's name: what a host name cannot hold becomes a dash, cut to
 *  63 (the cloud-init host name is an RFC 1123 label). */
export function hostnameFromName(name) {
  const label = name.trim().replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 63).replace(/-+$/, '');
  return label || 'vm';
}

/** What keeps the draft from being created, by field (none: an empty object). */
export function vmDraftProblems(draft, library) {
  const problems = { ...sizeProblems(draft) };
  if (!draft.name.trim()) problems.name = 'A name is required.';
  if (!draft.image) {
    problems.image = runsOf(draft.runs).takes.includes('disk') && draft.runs !== 'other' ? 'Pick a disk image.' : 'Pick an image.';
  } else if (!imagesFor(draft.runs, library).some((f) => f.name === draft.image)) {
    problems.image = 'That image is not in the library any more.';
  }
  const gb = Number(draft.diskGB);
  if (!Number.isInteger(gb) || gb < 1) problems.diskGB = 'The disk is a whole number of GB.';
  if (draft.runs === 'linux-image') {
    const problem = setupProblem({ hostname: hostnameFromName(draft.name), username: draft.username }, draft.name);
    if (problem) problems.username = problem;
  }
  return problems;
}

/**
 * The create request (`POST /api/vms`) for the draft. A disk image is copied and grown
 * to the disk size; an ISO goes in CD 1 with a new disk of that size. A Linux image
 * takes its first boot setup (package update off), `sshKey` its keys, one per line.
 * Library files go by name: the server finds them in its image library, wherever that is.
 */
export function createVmBody(draft, library, sshKey = '') {
  const r = runsOf(draft.runs);
  const file = imagesFor(draft.runs, library).find((f) => f.name === draft.image);
  const { vcpus, memoryMiB } = sizeSent(draft);
  const diskGB = Number(draft.diskGB);
  const body = { name: draft.name.trim(), profile: r.profile, vcpus, memoryMiB };
  if (file?.type === 'disk') {
    body.disk = { type: 'existing', sourcePath: file.name, resizeGB: diskGB };
  } else {
    body.disk = { type: 'new', sizeGB: diskGB };
    if (file) body.cdrom1Path = file.name;
  }
  const drivers = r.value === 'windows-11' && draft.drivers ? (library ?? []).find((f) => f.name === draft.drivers) : null;
  if (drivers) body.cdrom2Path = drivers.name;
  if (r.value === 'linux-image') {
    body.cloudInit = {
      enabled: true,
      hostname: hostnameFromName(draft.name),
      username: draft.username.trim(),
      password: draft.password,
      sshKey,
      growPartition: true,
      packageUpgrade: false,
      installQemuGuestAgent: true,
      installAvahiDaemon: true,
    };
  }
  return body;
}
