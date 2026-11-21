import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CUSTOM_TYPE, OTHER_PORT, serviceForm, serviceProblem, serviceSent, serviceTypeText, unannouncedPorts, withPortChoice, withType,
} from './containerServices.js';

test('the Add form offers the exposed ports no service announces, once each', () => {
  assert.deepEqual(unannouncedPorts(['80/tcp', '443/tcp', '80/udp', 'junk'], [{ port: 443 }]), [80]);
  assert.deepEqual(unannouncedPorts(undefined, undefined), []);
});

test('a new service starts on the first offered port with its suggested type', () => {
  const form = serviceForm(null, [443]);
  assert.equal(form.port, '443');
  assert.equal(form.typeSelect, '_https._tcp');
  assert.deepEqual(serviceSent(form), { port: 443, type: '_https._tcp', txt: { path: '/' } });
});

test('with no port offered, the port is typed', () => {
  const form = serviceForm(null, []);
  assert.equal(form.portChoice, OTHER_PORT);
  assert.equal(serviceProblem(form, []), 'The port is a whole number from 1 to 65535.');
  assert.equal(serviceProblem({ ...form, port: '8080' }, []), null);
  assert.equal(serviceProblem({ ...form, port: '8080x' }, []), 'The port is a whole number from 1 to 65535.');
});

test('a port another service announces is refused', () => {
  assert.equal(serviceProblem({ ...serviceForm(null, []), port: '22' }, [22]), 'Port 22 is announced already.');
});

test('picking a port suggests its type; a typed TXT record stays', () => {
  const form = withPortChoice(serviceForm(null, [80, 22]), '22');
  assert.equal(form.typeSelect, '_ssh._tcp');
  const typed = { ...serviceForm(null, [80]), txt: [{ id: 0, k: 'path', v: '/app' }] };
  assert.deepEqual(withType(typed, '_https._tcp').txt, [{ id: 0, k: 'path', v: '/app' }]);
});

test('a custom type is sent as typed', () => {
  const form = { ...withType(serviceForm(null, [9000]), CUSTOM_TYPE), customType: ' _thing._udp ' };
  assert.equal(serviceSent(form).type, '_thing._udp');
  assert.equal(serviceProblem({ ...form, customType: 'thing' }, []), 'The type looks like _name._tcp or _name._udp.');
});

test('an existing service opens on its own values', () => {
  const form = serviceForm({ port: 445, type: '_smb._tcp', txt: { a: 'b' } }, []);
  assert.deepEqual(serviceSent(form), { port: 445, type: '_smb._tcp', txt: { a: 'b' } });
  assert.equal(serviceTypeText('_smb._tcp'), 'SMB / CIFS');
  assert.equal(serviceTypeText('_odd._tcp'), '_odd._tcp');
});
