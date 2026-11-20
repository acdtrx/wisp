import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assignmentsRenamed, assignmentsWithout } from './sections.js';

const settings = () => ({
  sections: [{ id: 's1', name: 'Infra', order: 0 }],
  assignments: { 'vm:web': 's1', 'container:web': 's1', 'vm:stale': 's1' },
});

test('a rename moves the assignment to the new name, of its own type only', () => {
  const before = settings();
  const after = assignmentsRenamed(before, 'vm', 'web', 'site');
  assert.deepEqual(after.assignments, { 'vm:site': 's1', 'container:web': 's1', 'vm:stale': 's1' });
  assert.deepEqual(after.sections, before.sections);
  assert.deepEqual(before, settings(), 'the settings it was given are unchanged');
});

test('a renamed workload in Main drops the assignment its new name kept', () => {
  assert.deepEqual(assignmentsRenamed(settings(), 'vm', 'unassigned', 'stale').assignments, {
    'vm:web': 's1', 'container:web': 's1',
  });
});

test('a rename that touches no assignment answers the settings themselves', () => {
  const before = settings();
  assert.equal(assignmentsRenamed(before, 'container', 'a', 'b'), before);
});

test('a delete removes the assignment, and a workload with none answers the settings themselves', () => {
  const before = settings();
  assert.deepEqual(assignmentsWithout(before, 'container', 'web').assignments, { 'vm:web': 's1', 'vm:stale': 's1' });
  assert.equal(assignmentsWithout(before, 'vm', 'nope'), before);
  assert.equal(assignmentsWithout({ sections: [] }, 'vm', 'web').assignments, undefined);
});
