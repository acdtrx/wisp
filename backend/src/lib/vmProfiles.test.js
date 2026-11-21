import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILE_NAMES, VM_PROFILES, createSpecForProfile } from './vmProfiles.js';

test('three profiles, Linux and Other the same settings, Windows 11 with Secure Boot, TPM and its tuning', () => {
  assert.deepEqual(PROFILE_NAMES, ['linux', 'windows-11', 'other']);
  assert.deepEqual(VM_PROFILES.other, VM_PROFILES.linux);
  assert.equal(VM_PROFILES.linux.firmware, 'uefi');
  assert.equal(VM_PROFILES.linux.vtpm, false);
  const w = VM_PROFILES['windows-11'];
  assert.deepEqual([w.osType, w.firmware, w.vtpm, w.diskBus], ['Windows', 'uefi-secure', true, 'scsi']);
});

test('a create takes its profile settings, and what the request sends wins', () => {
  const spec = createSpecForProfile({ name: 'w', profile: 'windows-11', vcpus: 4, memoryMiB: 8192, disk: { type: 'new', sizeGB: 64 }, bootMenu: false });
  assert.equal(spec.profile, 'windows-11');
  assert.equal(spec.firmware, 'uefi-secure');
  assert.equal(spec.bootMenu, false);
  assert.deepEqual(spec.disk, { type: 'new', sizeGB: 64, bus: 'scsi' });
  assert.equal('diskBus' in spec, false);
  assert.equal(createSpecForProfile({ name: 'l', profile: 'linux', firmware: 'bios' }).firmware, 'bios');
});

test('a disk that names its bus keeps it; no disk stays no disk', () => {
  const spec = createSpecForProfile({ name: 'l', profile: 'linux', disk: { type: 'existing', sourcePath: '/i.img', bus: 'sata' }, disk2: { type: 'none' } });
  assert.equal(spec.disk.bus, 'sata');
  assert.deepEqual(spec.disk2, { type: 'none' });
  assert.equal('disk' in createSpecForProfile({ name: 'x', profile: 'other' }), false);
});
