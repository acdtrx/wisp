/**
 * What each VM profile sets at create (docs/specs/VM-MANAGEMENT.md, Profiles): the one
 * table. The create request names its profile; what it also sends wins over the
 * profile's values. The VM stores its profile's name; later edits change its settings,
 * never its profile.
 */

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
};

export const VM_PROFILES = Object.freeze({
  linux: Object.freeze({ ...COMMON }),
  'windows-11': Object.freeze({ ...COMMON, osType: 'Windows', firmware: 'uefi-secure', vtpm: true, diskBus: 'scsi' }),
  other: Object.freeze({ ...COMMON }),
});

export const PROFILE_NAMES = Object.freeze(Object.keys(VM_PROFILES));

/** A disk of the request with the profile's bus when it names none. */
const withBus = (disk, bus) => (disk && disk.type !== 'none' && !disk.bus ? { ...disk, bus } : disk);

/**
 * The create spec for a request: its profile's settings, and the request's own values
 * over them. `profile` stays on the spec (the VM stores it).
 */
export function createSpecForProfile(request) {
  const { diskBus, ...settings } = VM_PROFILES[request.profile];
  return {
    ...settings,
    ...request,
    ...(request.disk ? { disk: withBus(request.disk, diskBus) } : {}),
    ...(request.disk2 ? { disk2: withBus(request.disk2, diskBus) } : {}),
  };
}
