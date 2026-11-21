import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changedFields } from '../../hooks/formState.js';
import {
  expertForm, memoryText, sizeForm, sizeProblems, sizeSent, systemSummary, toggledBootDevice, withPreset,
} from './vmForms.js';

const vm = {
  name: 'archy', vcpus: 2, memoryMiB: 4096, firmware: 'uefi', machineType: 'pc-q35-9.2', cpuMode: 'host-passthrough',
  videoModel: 'virtio', graphics: { type: 'vnc' }, bootOrder: ['hd', 'cdrom'], bootMenu: false, guestAgent: true,
  memBalloon: true, virtioRng: true, vtpm: false, nestedVirt: false, osCategory: 'linux', features: { hyperv: false },
};

test('the size form picks the preset the stored size matches, else custom', () => {
  assert.equal(sizeForm(vm).preset, 'medium');
  assert.equal(sizeForm({ vcpus: 3, memoryMiB: 4096 }).preset, 'custom');
  assert.equal(sizeForm({ vcpus: 1, memoryMiB: 1536 }).memoryGB, '1.5');
});

test('a preset sets cores and memory; Save sends the fields that changed, in MiB', () => {
  const form = sizeForm(vm);
  const large = withPreset(form, 'large');
  assert.deepEqual(changedFields(sizeSent(large), sizeSent(form)), { vcpus: 4, memoryMiB: 8192 });
  assert.deepEqual(changedFields(sizeSent({ ...form, preset: 'custom', memoryGB: '6' }), sizeSent(form)), { memoryMiB: 6144 });
  assert.deepEqual(changedFields(sizeSent(form), sizeSent(sizeForm(vm))), {});
});

test('a size the server refuses is a problem', () => {
  assert.ok(sizeProblems({ preset: 'custom', vcpus: '0', memoryGB: '2' }).vcpus);
  assert.ok(sizeProblems({ preset: 'custom', vcpus: '2.5', memoryGB: '2' }).vcpus);
  assert.ok(sizeProblems({ preset: 'custom', vcpus: '2', memoryGB: '' }).memoryGB);
  assert.ok(sizeProblems({ preset: 'custom', vcpus: '2', memoryGB: '0.1' }).memoryGB);
  assert.deepEqual(sizeProblems(sizeForm(vm)), {});
});

test('memory reads in GB or MB', () => {
  assert.equal(memoryText(2048), '2 GB');
  assert.equal(memoryText(1536), '1.5 GB');
  assert.equal(memoryText(512), '512 MB');
});

test('expert settings: the stored machine version reads as its kind; one change sends that alone', () => {
  const form = expertForm(vm);
  assert.equal(form.machineType, 'q35');
  assert.equal(form.osType, 'Linux');
  assert.deepEqual(changedFields({ ...form, videoDriver: 'qxl' }, form), { videoDriver: 'qxl' });
  assert.deepEqual(changedFields({ ...form, osType: 'Windows' }, form), { osType: 'Windows' });
});

test('the boot order keeps one device and adds at the end', () => {
  assert.deepEqual(toggledBootDevice(['hd'], 'hd'), ['hd']);
  assert.deepEqual(toggledBootDevice(['hd'], 'network'), ['hd', 'network']);
  assert.deepEqual(toggledBootDevice(['hd', 'cdrom'], 'hd'), ['cdrom']);
});

test('the System line says what the settings are', () => {
  assert.equal(systemSummary(vm), 'UEFI, Q35, host CPU, VirtIO video, guest agent');
  assert.equal(
    systemSummary({ ...vm, firmware: 'uefi-secure', vtpm: true, features: { hyperv: true }, guestAgent: false }),
    'UEFI with Secure Boot, Q35, host CPU, VirtIO video, TPM, Windows tuning',
  );
});
