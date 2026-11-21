import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVmBody, defaultVmDraft, hostnameFromName, imagesFor, vmDraftProblems, withRuns } from './vmDraft.js';

const LIBRARY = [
  { name: 'ubuntu-26.04-server-cloudimg-amd64.img', type: 'disk' },
  { name: 'ubuntu-26.04-desktop-amd64.iso', type: 'iso' },
  { name: 'virtio-win-0.1.285.iso', type: 'iso' },
  { name: 'Win11_24H2.iso', type: 'iso' },
];

test('a Linux image: the cloud image (by its library name) copied and grown, first boot setup with package update off', () => {
  const draft = { ...defaultVmDraft(LIBRARY), name: 'my.vm_1', image: 'ubuntu-26.04-server-cloudimg-amd64.img', password: 'pw' };
  const body = createVmBody(draft, LIBRARY);
  assert.deepEqual(
    { ...body, cloudInit: undefined },
    {
      name: 'my.vm_1', profile: 'linux', vcpus: 2, memoryMiB: 2048, cloudInit: undefined,
      disk: { type: 'existing', sourcePath: 'ubuntu-26.04-server-cloudimg-amd64.img', resizeGB: 20 },
    },
  );
  assert.equal(body.cloudInit.hostname, 'my-vm-1');
  assert.equal(body.cloudInit.packageUpgrade, false);
  assert.equal(body.cloudInit.password, 'pw');
  assert.equal(body.cloudInit.enabled, true);
});

test('a Linux installer: the ISO in CD 1, a new disk, no first boot setup', () => {
  const draft = { ...withRuns(defaultVmDraft(LIBRARY), 'linux-installer', LIBRARY), name: 'desk', image: 'ubuntu-26.04-desktop-amd64.iso' };
  assert.deepEqual(createVmBody(draft, LIBRARY), {
    name: 'desk', profile: 'linux', vcpus: 2, memoryMiB: 2048,
    disk: { type: 'new', sizeGB: 32 }, cdrom1Path: 'ubuntu-26.04-desktop-amd64.iso',
  });
});

test('Windows 11: Large, 64 GB, the installer in CD 1 and the driver ISO preselected in CD 2', () => {
  const draft = { ...withRuns(defaultVmDraft(LIBRARY), 'windows-11', LIBRARY), name: 'win', image: 'Win11_24H2.iso' };
  assert.equal(draft.drivers, 'virtio-win-0.1.285.iso');
  assert.deepEqual(createVmBody(draft, LIBRARY), {
    name: 'win', profile: 'windows-11', vcpus: 4, memoryMiB: 8192,
    disk: { type: 'new', sizeGB: 64 },
    cdrom1Path: 'Win11_24H2.iso',
    cdrom2Path: 'virtio-win-0.1.285.iso',
  });
  assert.equal('cdrom2Path' in createVmBody({ ...draft, drivers: '' }, LIBRARY), false);
});

test('Other takes a disk image or an ISO, by the file picked', () => {
  const other = { ...withRuns(defaultVmDraft(LIBRARY), 'other', LIBRARY), name: 'x' };
  assert.equal(imagesFor('other', LIBRARY).length, 4);
  assert.equal(createVmBody({ ...other, image: 'ubuntu-26.04-server-cloudimg-amd64.img' }, LIBRARY).disk.type, 'existing');
  const iso = createVmBody({ ...other, image: 'ubuntu-26.04-desktop-amd64.iso' }, LIBRARY);
  assert.deepEqual([iso.profile, iso.disk.type, 'cloudInit' in iso], ['other', 'new', false]);
});

test('a Linux image takes disk images only; an installer, ISOs only', () => {
  assert.deepEqual(imagesFor('linux-image', LIBRARY).map((f) => f.type), ['disk']);
  assert.deepEqual([...new Set(imagesFor('linux-installer', LIBRARY).map((f) => f.type))], ['iso']);
});

test('the draft needs a name, an image, a size and a disk', () => {
  const problems = vmDraftProblems(defaultVmDraft(LIBRARY), LIBRARY);
  assert.deepEqual(Object.keys(problems).sort(), ['image', 'name']);
  const ok = { ...defaultVmDraft(LIBRARY), name: 'a', image: 'ubuntu-26.04-server-cloudimg-amd64.img' };
  assert.deepEqual(vmDraftProblems(ok, LIBRARY), {});
  assert.ok(vmDraftProblems({ ...ok, diskGB: '0' }, LIBRARY).diskGB);
  assert.ok(vmDraftProblems({ ...ok, username: 'Root' }, LIBRARY).username);
  assert.ok(vmDraftProblems({ ...ok, image: 'Win11_24H2.iso' }, LIBRARY).image);
});

test('a host name from any VM name', () => {
  assert.equal(hostnameFromName('web'), 'web');
  assert.equal(hostnameFromName('-a.b_c-'), 'a-b-c');
  assert.equal(hostnameFromName('x'.repeat(128)).length, 63);
  assert.equal(hostnameFromName('...'), 'vm');
});
