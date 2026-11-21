import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UNKNOWN, renameStep } from './renameFollow.js';

const list = (...items) => items.map(([name, uuid]) => ({ name, uuid }));

/** Run events through the step; the answers, in order. */
function run(events) {
  let known = UNKNOWN;
  return events.map((event) => {
    const step = renameStep(known, event);
    known = step.known;
    return { renamedTo: step.renamedTo, uuid: known.uuid };
  });
}

test("the old name's 404 first, then the list frame: the kept uuid follows to the new name", () => {
  const out = run([
    { name: 'a', recordUuid: 'u1', list: list(['a', 'u1']) },
    { name: 'a', recordUuid: null, list: list(['a', 'u1']) }, // the 404 drops the record's data
    { name: 'a', recordUuid: null, list: list(['b', 'u1']) }, // then the list shows the rename
  ]);
  assert.deepEqual(out, [
    { renamedTo: null, uuid: 'u1' },
    { renamedTo: null, uuid: 'u1' },
    { renamedTo: 'b', uuid: 'u1' },
  ]);
});

test('the list frame first, then the 404: followed on the frame, and still after the 404', () => {
  const out = run([
    { name: 'a', recordUuid: 'u1', list: list(['a', 'u1']) },
    { name: 'a', recordUuid: 'u1', list: list(['b', 'u1']) },
    { name: 'a', recordUuid: null, list: list(['b', 'u1']) },
  ]);
  assert.deepEqual(out.map((o) => o.renamedTo), [null, 'b', 'b']);
});

test('another name shown forgets the uuid; a list without the uuid is no rename', () => {
  const out = run([
    { name: 'a', recordUuid: 'u1', list: list(['a', 'u1']) },
    { name: 'c', recordUuid: null, list: list(['b', 'u1']) },
    { name: 'c', recordUuid: null, list: list(['d', 'u4']) },
  ]);
  assert.deepEqual(out, [
    { renamedTo: null, uuid: 'u1' },
    { renamedTo: null, uuid: null },
    { renamedTo: null, uuid: null },
  ]);
});

test("a name just renamed to here, its record read before the list's frame: the page stays", () => {
  const stale = list(['a', 'u1']);
  const out = run([
    { name: 'b', recordUuid: null, list: stale }, // the new name's page, loading
    { name: 'b', recordUuid: 'u1', list: stale }, // its record lands; the list still says "a"
    { name: 'b', recordUuid: 'u1', list: list(['b', 'u1']) }, // then the frame
  ]);
  assert.deepEqual(out.map((o) => o.renamedTo), [null, null, null]);
});

test('a rename elsewhere after that is followed, from the frame that shows it', () => {
  const stale = list(['a', 'u1']);
  const out = run([
    { name: 'b', recordUuid: 'u1', list: stale },
    { name: 'b', recordUuid: 'u1', list: list(['c', 'u1']) },
  ]);
  assert.deepEqual(out.map((o) => o.renamedTo), [null, 'c']);
});
