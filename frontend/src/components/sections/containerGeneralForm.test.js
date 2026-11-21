import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containerGeneralForm, containerGeneralProblems, containerGeneralSent } from './containerGeneralForm.js';

const config = { name: 'p4-c', image: 'example/p4:1', command: ['sh', '-c', 'echo p4'], cpuLimit: 1.5, memoryLimitMiB: 256 };
const form = containerGeneralForm(config);

test('the form shows the stored command as a command line; no command is an empty line', () => {
  assert.equal(form.command, "sh -c 'echo p4'");
  assert.equal(containerGeneralForm({}).command, '');
  assert.equal(containerGeneralForm({ command: 'not a list' }).command, '');
  assert.equal(containerGeneralForm({ command: ['sleep', 30, null] }).command, "sleep 30 ''");
});

test('Save sends the command as its argv, and a re-quoted identical command the same', () => {
  assert.deepEqual(containerGeneralSent(form).command, ['sh', '-c', 'echo p4']);
  assert.deepEqual(containerGeneralSent({ ...form, command: 'sh -c "echo p4"' }).command, ['sh', '-c', 'echo p4']);
  assert.equal(containerGeneralSent({ ...form, command: '   ' }).command, null);
});

test('a command that does not parse is sent as typed and is a problem, never a throw', () => {
  for (const text of ['sh -c "echo', "sh -c 'echo", 'echo \\', "$'abc"]) {
    const sent = containerGeneralSent({ ...form, command: text });
    assert.equal(sent.command, text);
    assert.ok(containerGeneralProblems({ ...form, command: text }).command, text);
  }
  assert.equal(containerGeneralProblems(form).command, undefined);
});

test('limits: numbers sent as numbers, none as null, anything else as typed and a problem', () => {
  assert.equal(containerGeneralSent(form).cpuLimit, 1.5);
  assert.equal(containerGeneralSent({ ...form, cpuLimit: '' }).cpuLimit, null);
  for (const value of ['-1', '0', 'abc', 'Infinity']) {
    assert.equal(containerGeneralSent({ ...form, cpuLimit: value }).cpuLimit, value);
    assert.ok(containerGeneralProblems({ ...form, cpuLimit: value }).cpuLimit, value);
  }
  for (const value of ['1.5', '-4', 'x']) assert.ok(containerGeneralProblems({ ...form, memoryLimitMiB: value }).memoryLimitMiB, value);
  assert.equal(containerGeneralSent({ ...form, memoryLimitMiB: '1e3' }).memoryLimitMiB, 1000);
});

test('an empty name is a problem', () => {
  assert.equal(containerGeneralProblems({ ...form, name: '  ' }).name, 'Name is required');
});
