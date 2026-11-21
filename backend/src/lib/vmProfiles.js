/**
 * What each VM profile sets at create (docs/specs/VM-MANAGEMENT.md, Profiles): the one
 * table. The create request names its profile; what it also sends wins over the
 * profile's values. The VM stores its profile's name; later edits change its settings,
 * never its profile. `firstBootSetup`: whether a VM of the profile takes a first boot
 * setup (cloud-init), at create and later; it is no VM setting.
 */
import { createAppError } from './appErrors.js';

/** Every profile sets these; a profile's own row changes some of them. */
const COMMON = {
  osType: 'Linux',
  firmware: 'uefi',
  machineType: 'q35',
  cpuMode: 'host-passthrough',
  videoDriver: 'virtio',
  graphicsType: 'vnc',
  bootOrder: ['hd', 'cdrom', 'network'],
  bootMenu: true,
  memBalloon: true,
  guestAgent: true,
  vtpm: false,
  virtioRng: true,
  nestedVirt: false,
  diskBus: 'virtio',
  firstBootSetup: false,
};

export const VM_PROFILES = Object.freeze({
  linux: Object.freeze({ ...COMMON, firstBootSetup: true }),
  'windows-11': Object.freeze({ ...COMMON, osType: 'Windows', firmware: 'uefi-secure', vtpm: true, diskBus: 'scsi' }),
  other: Object.freeze({ ...COMMON }),
});

export const PROFILE_NAMES = Object.freeze(Object.keys(VM_PROFILES));

/**
 * Refuse a first boot setup for a VM whose profile takes none: another profile's, or a
 * VM with no profile (`null`, defined outside Wisp or never given one).
 */
export function assertFirstBootSetupFits(profile, vmName) {
  if (VM_PROFILES[profile]?.firstBootSetup) return;
  throw createAppError(
    'INVALID_REQUEST',
    profile
      ? `VM "${vmName}" is made as ${profile}, which takes no first boot setup`
      : `VM "${vmName}" has no profile, so it takes no first boot setup`,
  );
}

/** A disk of the request with the profile's bus when it names none. */
const withBus = (disk, bus) => (disk && disk.type !== 'none' && !disk.bus ? { ...disk, bus } : disk);

/**
 * The create spec for a request: its profile's settings, and the request's own values
 * over them. `profile` stays on the spec (the VM stores it).
 */
export function createSpecForProfile(request) {
  const { diskBus, firstBootSetup, ...settings } = VM_PROFILES[request.profile];
  return {
    ...settings,
    ...request,
    ...(request.disk ? { disk: withBus(request.disk, diskBus) } : {}),
    ...(request.disk2 ? { disk2: withBus(request.disk2, diskBus) } : {}),
  };
}
