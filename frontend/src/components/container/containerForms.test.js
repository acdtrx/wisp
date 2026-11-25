import { test } from 'node:test';
import assert from 'node:assert/strict';

import { changedFields } from '../../hooks/editorValues.js';
import {
  advancedForm, advancedProblems, advancedSent, limitsForm, limitsProblems, limitsSent, networkForm, networkProblems,
  networkSent, restartPolicyText, sameImage,
} from './containerForms.js';

const config = {
  name: 'c', image: 'example/c:1', command: ['sh', '-c', 'echo c'], cpuLimit: 1.5, memoryLimitMiB: 256,
  restartPolicy: 'always', runAsRoot: true, devices: [{ type: 'gpu', device: '/dev/dri/renderD128' }],
  network: { type: 'bridge', interface: 'br0', mac: '52:54:00:AA:BB:CC' },
};

test('the command shows as a command line; no command is an empty line', () => {
  assert.equal(advancedForm(config).command, "sh -c 'echo c'");
  assert.equal(advancedForm({}).command, '');
  assert.equal(advancedForm({ command: 'not a list' }).command, '');
  assert.equal(advancedForm({ command: ['sleep', 30, null] }).command, "sleep 30 ''");
});

test('Save sends the command as its argv, and a re-quoted identical command is no change', () => {
  const form = advancedForm(config);
  assert.deepEqual(advancedSent(form).command, ['sh', '-c', 'echo c']);
  assert.deepEqual(changedFields(advancedSent({ ...form, command: 'sh -c "echo c"' }), advancedSent(form)), {});
  assert.equal(advancedSent({ ...form, command: '   ' }).command, null);
});

test('a command that does not parse is sent as typed and is a problem, never a throw', () => {
  const form = advancedForm(config);
  for (const text of ['sh -c "echo', "sh -c 'echo", 'echo \\', "$'abc"]) {
    assert.equal(advancedSent({ ...form, command: text }).command, text);
    assert.ok(advancedProblems({ ...form, command: text }).command, text);
  }
  assert.deepEqual(advancedProblems(form), {});
});

test('the GPU is the device list: one device, or none', () => {
  const form = advancedForm(config);
  assert.equal(form.gpu, '/dev/dri/renderD128');
  assert.deepEqual(advancedSent({ ...form, gpu: '' }).devices, []);
  assert.deepEqual(changedFields(advancedSent({ ...form, runAsRoot: false }), advancedSent(form)), { runAsRoot: false });
});

test('limits: numbers sent as numbers, none as null, anything else as typed and a problem', () => {
  const form = limitsForm(config);
  assert.deepEqual(limitsSent(form), { cpuLimit: 1.5, memoryLimitMiB: 256, restartPolicy: 'always' });
  assert.equal(limitsSent({ ...form, cpuLimit: '' }).cpuLimit, null);
  for (const value of ['-1', '0', 'abc', 'Infinity']) {
    assert.equal(limitsSent({ ...form, cpuLimit: value }).cpuLimit, value);
    assert.ok(limitsProblems({ ...form, cpuLimit: value }).cpuLimit, value);
  }
  for (const value of ['1.5', '-4', 'x']) assert.ok(limitsProblems({ ...form, memoryLimitMiB: value }).memoryLimitMiB, value);
  assert.equal(limitsSent({ ...form, memoryLimitMiB: '1e3' }).memoryLimitMiB, 1000);
});

test('an unchanged limits form sends nothing; one change sends that field alone', () => {
  const form = limitsForm(config);
  assert.deepEqual(changedFields(limitsSent(form), limitsSent(limitsForm(config))), {});
  assert.deepEqual(changedFields(limitsSent({ ...form, restartPolicy: 'never' }), limitsSent(form)), { restartPolicy: 'never' });
  assert.equal(limitsForm({}).restartPolicy, 'unless-stopped');
});

test('the network sends the bridge and the MAC in lower case; a bad MAC is a problem', () => {
  const form = networkForm(config);
  assert.deepEqual(changedFields(networkSent(form), networkSent(form)), {});
  assert.deepEqual(changedFields(networkSent({ ...form, interface: 'br1' }), networkSent(form)), { interface: 'br1' });
  assert.equal(networkSent(form).mac, '52:54:00:aa:bb:cc');
  assert.ok(networkProblems({ ...form, mac: '52:54:00' }).mac);
  assert.deepEqual(networkProblems(form), {});
});

test('a restart policy reads as words', () => {
  assert.equal(restartPolicyText('on-failure'), 'After a failure');
  assert.equal(restartPolicyText(undefined), 'Unless I stopped it');
});

test('an image reference names the same image with or without Docker Hub, library/ and :latest', () => {
  assert.ok(sameImage('caddy:latest', 'docker.io/library/caddy:latest'));
  assert.ok(sameImage('caddy', 'docker.io/library/caddy:latest'));
  assert.ok(sameImage('jellyfin/jellyfin:latest', 'docker.io/jellyfin/jellyfin:latest'));
  assert.ok(sameImage('ghcr.io/acdtrx/tiny-samba:latest', 'ghcr.io/acdtrx/tiny-samba'));
  assert.ok(!sameImage('caddy:latest', 'zotty.anapana.trixbits.ro/acdtrx/caddy:latest'));
  assert.ok(!sameImage('caddy:2', 'caddy:latest'));
  assert.ok(!sameImage('localhost:5000/caddy:latest', 'caddy:latest'));
});
