import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renamedElsewhere, renamedPath } from './renamedPath.js';

test("a rename's ack follows only from the workload's own page, on the tab it shows then", () => {
  assert.equal(renamedPath('/vm/p4-a/overview', 'vm', 'p4-a', 'p4-b'), '/vm/p4-b/overview');
  assert.equal(renamedPath('/vm/p4-a/console', 'vm', 'p4-a', 'p4-b'), '/vm/p4-b/console');
  assert.equal(renamedPath('/vm/p4-a', 'vm', 'p4-a', 'p4-b'), '/vm/p4-b');
  assert.equal(renamedPath('/vm/p4-ab/overview', 'vm', 'p4-a', 'p4-b'), null);
  assert.equal(renamedPath('/container/p4-a/logs', 'vm', 'p4-a', 'p4-b'), null);
  assert.equal(renamedPath('/host/overview', 'vm', 'p4-a', 'p4-b'), null);
  assert.equal(renamedPath('/container/p4%20c/logs', 'container', 'p4 c', 'p4 d'), '/container/p4%20d/logs');
});

test('a gone page follows its uuid to another name in the list, and only then', () => {
  const list = [{ name: 'p4-b', uuid: 'u1' }, { name: 'p4-x', uuid: 'u2' }];
  assert.equal(renamedElsewhere({ gone: true, uuid: 'u1', name: 'p4-a', list }), 'p4-b');
  assert.equal(renamedElsewhere({ gone: true, uuid: 'u9', name: 'p4-a', list }), null);
  assert.equal(renamedElsewhere({ gone: false, uuid: 'u1', name: 'p4-a', list }), null);
  assert.equal(renamedElsewhere({ gone: true, uuid: null, name: 'p4-a', list }), null);
  assert.equal(renamedElsewhere({ gone: true, uuid: 'u1', name: 'p4-b', list }), null);
});
