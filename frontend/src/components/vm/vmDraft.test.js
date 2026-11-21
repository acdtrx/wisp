import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVmBody, defaultVmDraft, draftProblem, generalProblems, withGeneral } from './vmDraft.js';

/* The anchor's create request (CreateVMPanel before the draft), over its flat form, as
 * the oracle: for the same input the body must be the same. Its cloud-init section
 * pushed these fields, the hostname following the VM's name until typed. */
function anchorSpec(form, bridges) {
  return {
    name: form.name.trim(),
    osType: form.osType,
    osVariant: form.osVariant ?? 'generic',
    vcpus: form.vcpus,
    memoryMiB: form.memoryMiB,
    autostart: form.autostart,
    firmware: form.firmware,
    machineType: form.machineType,
    cpuMode: form.cpuMode,
    videoDriver: form.videoDriver,
    graphicsType: form.graphicsType,
    bootOrder: form.bootOrder,
    bootMenu: form.bootMenu,
    memBalloon: form.memBalloon,
    guestAgent: form.guestAgent,
    vtpm: form.vtpm,
    virtioRng: form.virtioRng,
    nestedVirt: form.nestedVirt,
    nics: form.nics.map((n) => ({
      type: n.type || 'bridge',
      source: n.source || bridges[0] || undefined,
      model: n.model || 'virtio',
      mac: n.mac || undefined,
    })),
    disk:
      form.disk?.type === 'none'
        ? { type: 'none', bus: form.disk?.bus || 'virtio' }
        : {
            type: form.disk?.type || 'new',
            sizeGB: form.disk?.sizeGB ?? 32,
            bus: form.disk?.bus || 'virtio',
            sourcePath: form.disk?.sourcePath || undefined,
            resizeGB: form.disk?.resizeGB != null && form.disk.resizeGB > 0 ? form.disk.resizeGB : undefined,
          },
    disk2: form.disk2?.type && form.disk2.type !== 'none' ? {
      type: form.disk2.type,
      sizeGB: form.disk2.sizeGB ?? 32,
      bus: form.disk2.bus || 'virtio',
      sourcePath: form.disk2.type === 'existing' ? form.disk2.sourcePath : undefined,
      resizeGB: form.disk2.resizeGB != null && form.disk2.resizeGB > 0 ? form.disk2.resizeGB : undefined,
    } : undefined,
    cdrom1Path: form.cdrom1Path || undefined,
    cdrom2Path: form.cdrom2Path || undefined,
    cloudInit:
      form.osType !== 'Windows' && form.cloudInit && (form.disk?.type === 'existing' || form.disk2?.type === 'existing')
        ? form.cloudInit
        : undefined,
  };
}

/** The anchor's flat form for the same input as `draft` (a hostname left as the anchor
 *  prefilled it is the VM's name as typed). */
function anchorForm(draft) {
  const { general, advanced, nics, disks, cloudInit: c } = draft;
  return {
    ...general, osVariant: 'generic', ...advanced, nics: nics.map(({ id: _id, ...n }) => n), ...disks,
    cloudInit: {
      enabled: c.enabled, hostname: c.hostname || general.name, username: c.username, password: c.password, sshKey: c.sshKey,
      growPartition: c.growPartition, packageUpgrade: c.packageUpgrade, installQemuGuestAgent: c.installQemuGuestAgent,
      installAvahiDaemon: c.installAvahiDaemon,
    },
  };
}

const wire = (body) => JSON.parse(JSON.stringify(body));
const BRIDGES = ['br0', 'br1'];

function sameAsAnchor(draft) {
  assert.deepEqual(wire(createVmBody(draft, BRIDGES)), wire(anchorSpec(anchorForm(draft), BRIDGES)));
}

test('the default draft sends what the anchor sent', () => {
  const d = defaultVmDraft();
  d.general.name = 'p4-a';
  sameAsAnchor(d);
  const body = wire(createVmBody(d, BRIDGES));
  assert.equal(body.nics[0].source, 'br0');
  assert.equal(body.cloudInit, undefined);
  assert.deepEqual(body.disk, { type: 'none', bus: 'virtio' });
});

test('every field edited: the body is the anchor\'s, field by field', () => {
  let d = defaultVmDraft();
  d = withGeneral(d, { ...d.general, name: 'p4-full', vcpus: 3, memoryMiB: 16384, autostart: true });
  d.advanced = {
    firmware: 'bios', machineType: 'pc-i440fx', cpuMode: 'qemu64', videoDriver: 'qxl', graphicsType: 'spice',
    bootOrder: ['cdrom', 'hd'], bootMenu: false, memBalloon: false, guestAgent: false, vtpm: true, virtioRng: false, nestedVirt: true,
  };
  d.nics = [{ ...d.nics[0], source: 'br1', model: 'e1000', mac: '52:54:00:00:00:0a' }, { id: 'x', type: 'bridge', source: '', model: 'virtio', mac: '' }];
  d.disks = {
    disk: { type: 'existing', sizeGB: 32, bus: 'sata', sourcePath: '/images/p4.img', sourceName: 'p4.img', resizeGB: 40 },
    disk2: { type: 'new', sizeGB: 64, bus: 'scsi', sourcePath: null, sourceName: null, resizeGB: null },
    cdrom1Path: '/images/p4.iso', cdrom2Path: null, cdrom1Name: 'p4.iso', cdrom2Name: null,
  };
  d.cloudInit = { ...d.cloudInit, hostname: 'p4-host', username: 'p4', password: 'pw', sshKey: 'ssh-ed25519 AAAA p4', sshKeySource: 'github:p4', packageUpgrade: false };
  sameAsAnchor(d);
  const body = wire(createVmBody(d, BRIDGES));
  assert.equal(body.memoryMiB, 16384);
  assert.deepEqual(Object.keys(body.cloudInit).sort(), ['enabled', 'growPartition', 'hostname', 'installAvahiDaemon', 'installQemuGuestAgent', 'packageUpgrade', 'password', 'sshKey', 'username']);
  assert.equal(body.nics[1].source, 'br0');
});

test('an empty hostname sends the VM\'s name; a typed one as typed; no bridges leave the source to the server', () => {
  const d = defaultVmDraft();
  d.general.name = 'p4-name';
  d.disks.disk = { ...d.disks.disk, type: 'existing', sourcePath: '/images/a.img', sourceName: 'a.img' };
  assert.equal(createVmBody(d, BRIDGES).cloudInit.hostname, 'p4-name');
  assert.equal(createVmBody({ ...d, cloudInit: { ...d.cloudInit, hostname: 'p4-host' } }, BRIDGES).cloudInit.hostname, 'p4-host');
  sameAsAnchor(d);
  assert.equal(wire(createVmBody(d, [])).nics[0].source, undefined);
});

test('Windows brings its preset, and back; Windows sends no cloud-init', () => {
  let d = defaultVmDraft();
  d = withGeneral(d, { ...d.general, osType: 'Windows' });
  assert.deepEqual([d.general.vcpus, d.general.memoryMiB, d.advanced.firmware, d.advanced.vtpm, d.disks.disk.bus], [4, 8192, 'uefi-secure', true, 'scsi']);
  d.disks.disk = { ...d.disks.disk, type: 'existing', sourcePath: '/images/w.img', sourceName: 'w.img' };
  d.general.name = 'p4-win';
  sameAsAnchor(d);
  assert.equal(createVmBody(d, BRIDGES).cloudInit, undefined);
  d = withGeneral(d, { ...d.general, osType: 'Linux' });
  assert.deepEqual([d.general.vcpus, d.general.memoryMiB, d.advanced.firmware, d.advanced.vtpm, d.disks.disk.bus], [2, 2048, 'uefi', true, 'virtio']);
  // Another General edit keeps what was set: no preset without an OS change.
  d = withGeneral(d, { ...d.general, memoryMiB: 1000 });
  assert.equal(d.general.memoryMiB, 1000);
});

test('a draft with no name, or an existing disk with no image, is refused before it is sent', () => {
  const d = defaultVmDraft();
  assert.equal(draftProblem(d), 'VM name is required');
  d.general.name = 'p4';
  d.disks.disk = { ...d.disks.disk, type: 'existing' };
  assert.equal(draftProblem(d), 'Please select an existing disk image');
});

test("CPU and RAM the server refuses, or cleared, are problems; creating, the first is Create's", () => {
  assert.deepEqual(generalProblems({ vcpus: 2, memoryMiB: 128 }), {});
  for (const vcpus of [0, -5, 1.5, '']) assert.ok(generalProblems({ vcpus, memoryMiB: 2048 }).vcpus, String(vcpus));
  for (const memoryMiB of [127, -5120, 512.5, '']) assert.ok(generalProblems({ vcpus: 1, memoryMiB }).memoryMiB, String(memoryMiB));
  const d = defaultVmDraft();
  d.general = { ...d.general, name: 'p4-x', vcpus: '' };
  assert.equal(draftProblem(d), 'CPU must be a whole number above 0');
});
