import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyLocks, beginSave, editForm, writeHeld, endSave, failSave, followRecord, initialFormState, isDirty, resetForm, rowId, saveForm, standingProblems } from './formState.js';

const edit = (state, form) => ({ ...state, form });

test('a form starts from its record, not dirty; an edit makes it dirty, by value', () => {
  const s = initialFormState({ a: 1, b: 'x' });
  assert.equal(isDirty(s), false);
  assert.equal(isDirty(edit(s, { a: 2, b: 'x' })), true);
  assert.equal(isDirty(edit(s, { a: 1, b: 'x' })), false);
});

test('a re-read that changes what the form shows resets it; one that leaves those values keeps the edit', () => {
  const s = edit(initialFormState({ a: 1 }), { a: 5 });
  assert.equal(followRecord(s, { a: 1 }), s);
  const reset = followRecord(s, { a: 2 });
  assert.deepEqual(reset.form, { a: 2 });
  assert.equal(isDirty(reset), false);
});

test('a save: no following while it runs; a failure keeps the edit, dirty; a success shows the saved record', () => {
  let s = beginSave(edit(initialFormState({ a: 1 }), { a: 2 }));
  // A record update lands mid-save with the old values, then one with others: neither moves the form.
  s = followRecord(s, { a: 1 });
  s = followRecord(s, { a: 7 });
  assert.deepEqual(s.form, { a: 2 });
  // The save fails: the form keeps what was typed, dirty against the record as it now is.
  s = followRecord(failSave(s), { a: 7 });
  assert.deepEqual(s.form, { a: 2 });
  assert.deepEqual(s.saved, { a: 7 });
  assert.equal(isDirty(s), true);
  // Saved again: the form shows the record as it is when the save ends, normalised.
  s = followRecord(endSave(beginSave(s)), { a: 2.5 });
  assert.deepEqual(s.form, { a: 2.5 });
  assert.equal(isDirty(s), false);
});

test('after the save ends the form follows by value again', () => {
  let s = followRecord(endSave(beginSave(edit(initialFormState({ a: 1 }), { a: 2 }))), { a: 2 });
  s = edit(s, { a: 3 });
  assert.equal(followRecord(s, { a: 2 }), s);
});

test('a save re-reads its record after the command, with no stream: the form shows the re-read record', async () => {
  let state = edit(initialFormState({ a: 1 }), { a: 2 });
  const update = (step) => { state = step(state); };
  const order = [];
  let record = { a: 1 };
  /* The events stream is refused: no frame comes. Only the save's own re-read moves the record. */
  const ok = await saveForm(async () => { order.push('command'); return true; },
    async () => { order.push('reread'); record = { a: 2 }; return true; }, update);
  state = followRecord(state, record);
  assert.equal(ok, true);
  assert.deepEqual(order, ['command', 'reread']);
  assert.deepEqual(state.form, { a: 2 });
  assert.equal(isDirty(state), false);
});

test('a failed re-read after the save leaves the form as typed; a failed command reads nothing', async () => {
  let state = edit(initialFormState({ a: 1 }), { a: 2 });
  const update = (step) => { state = step(state); };
  await saveForm(async () => true, async () => false, update);
  state = followRecord(state, { a: 1 });
  assert.deepEqual(state.form, { a: 2 });
  assert.equal(isDirty(state), true);
  let reread = false;
  const ok = await saveForm(async () => false, async () => { reread = true; return true; }, update);
  assert.equal(ok, false);
  assert.equal(reread, false);
  assert.deepEqual(followRecord(state, { a: 1 }).form, { a: 2 });
});

/* A form with rows: the record's rows take new ids each time (`toForm`), and Save sends
 * the rows without them, the name trimmed. */
const toForm = (record) => ({ name: record.name, rows: record.rows.map((r) => ({ id: rowId(), ...r })) });
const toSend = (form) => ({ name: form.name.trim(), rows: form.rows.map(({ id: _id, ...r }) => r) });
const record = { name: 'a', rows: [{ v: 1 }, { v: 2 }] };

test('an edit that normalises to the saved value is not dirty', () => {
  const s = initialFormState(toForm(record), toSend);
  assert.equal(isDirty(edit(s, { ...s.form, name: 'a  ' }), toSend), false);
  assert.equal(isDirty(edit(s, { ...s.form, name: 'b' }), toSend), true);
});

test('a row removed and added again the same is not dirty; its identity is not compared', () => {
  const s = initialFormState(toForm(record), toSend);
  const [, second] = s.form.rows;
  const readded = { ...s.form, rows: [{ id: rowId(), v: 1 }, second] };
  assert.notEqual(readded.rows[0].id, s.form.rows[0].id);
  assert.equal(isDirty(edit(s, readded), toSend), false);
});

test('the record re-read with new row ids is no change; a reset gives the rows new identities', () => {
  const s = edit(initialFormState(toForm(record), toSend), { ...toForm(record), name: 'typed' });
  // Re-read: same values, new ids — the edit stays.
  assert.equal(followRecord(s, toForm(record), toSend), s);
  // Reset: the form takes the record afresh, so what a view kept by the old row ids finds nothing.
  const kept = new Set([s.saved.rows[0].id]);
  const reset = followRecord(resetForm(s), toForm(record), toSend);
  assert.equal(reset.form.name, 'a');
  assert.equal(reset.form.rows.some((r) => kept.has(r.id)), false);
  assert.equal(isDirty(reset, toSend), false);
});

test("an editor's save re-reads its parent record with the stream refused, and the form shows the entity as stored", async () => {
  // The editor opened on entity `b` of its parent record; the form is that entity.
  const pick = (parent) => parent.items.find((i) => i.id === 'b') ?? null;
  let parent = { items: [{ id: 'a', v: 1 }, { id: 'b', v: 1 }] };
  let state = edit(initialFormState(pick(parent)), { id: 'b', v: 2 });
  const update = (step) => { state = step(state); };
  const ok = await saveForm(async () => true,
    async () => { parent = { items: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] }; return true; }, update);
  assert.equal(ok, true);
  state = followRecord(state, pick(parent));
  assert.deepEqual(state.form, { id: 'b', v: 2 });
  assert.equal(isDirty(state), false);
  // The entity is removed elsewhere while it is open: the form has nothing.
  state = followRecord(state, pick({ items: [{ id: 'a', v: 1 }] }));
  assert.equal(state.form, null);
});

test('a reset starts a new generation, a failed save does not; the form keeps the record it was taken from', () => {
  const first = { a: 1, other: 'x' };
  let s = initialFormState({ a: 1 }, first);
  assert.equal(s.generation, 0);
  assert.equal(s.taken, first);
  // A re-read with the same values: no reset, the record as taken stays.
  s = edit(s, { a: 2 });
  assert.equal(followRecord(s, { a: 1 }, undefined, { a: 1, other: 'y' }), s);
  // A failed save: no new generation.
  s = followRecord(failSave(beginSave(s)), { a: 1 }, undefined, { a: 1, other: 'z' });
  assert.equal(s.generation, 0);
  // A reset (own values changed elsewhere), and a save's end: each a new generation.
  const changed = { a: 3, other: 'z' };
  s = followRecord(s, { a: 3 }, undefined, changed);
  assert.equal(s.generation, 1);
  assert.equal(s.taken, changed);
  s = followRecord(endSave(beginSave(s)), { a: 3 }, undefined, changed);
  assert.equal(s.generation, 2);
  assert.equal(followRecord(resetForm(s), { a: 3 }).generation, 3);
});

test('a locked field shows the saved value, is no change, and a value typed before the lock is dropped', () => {
  let s = edit(initialFormState({ cpu: 1, name: 'a' }), { cpu: 4, name: 'b' });
  assert.equal(isDirty(s), true);
  // The lock begins: the typed CPU goes; the name edit stays.
  s = applyLocks(s, ['cpu']);
  assert.deepEqual(s.form, { cpu: 1, name: 'b' });
  assert.equal(applyLocks(s, ['cpu']), s);
  // The lock ends: the typed value does not come back.
  assert.deepEqual(applyLocks(s, []).form, { cpu: 1, name: 'b' });
  // Only the locked field held back: no change at all once the name is back too.
  assert.equal(isDirty(applyLocks(edit(s, { cpu: 9, name: 'a' }), ['cpu'])), false);
});

test('an edit with no form (not loaded, or gone) does nothing', () => {
  const none = initialFormState(null);
  assert.equal(editForm(none, (f) => ({ ...f, a: 1 })), none);
  assert.deepEqual(editForm(initialFormState({ a: 1 }), (f) => ({ ...f, a: 2 })).form, { a: 2 });
});

test('a held value is written only by a setter of the current generation', () => {
  let held = writeHeld(null, 0, 0, 'open');
  assert.deepEqual(held, { generation: 0, value: 'open' });
  // The form was reset (generation 1): a setter kept from generation 0 writes nothing.
  assert.equal(writeHeld(held, 0, 1, 'again'), held);
  held = writeHeld(held, 1, 1, (was) => (was ? 'kept' : 'fresh'));
  assert.deepEqual(held, { generation: 1, value: 'fresh' });
  assert.equal(writeHeld(held, 1, 1, null), null);
});

test('a problem stands only for a value the user changed; creating, every one', () => {
  const problems = { vcpus: 'bad CPU', memoryMiB: 'bad RAM' };
  const saved = { vcpus: 2, memoryMiB: 64 };
  assert.deepEqual(standingProblems(problems, { vcpus: 2, memoryMiB: 64 }, saved, false), {});
  assert.deepEqual(standingProblems(problems, { vcpus: 0, memoryMiB: 64 }, saved, false), { vcpus: 'bad CPU' });
  assert.deepEqual(standingProblems(problems, { vcpus: 2, memoryMiB: 64 }, saved, true), problems);
});

test('a problem key is a path, or several: it stands when any of them changed', () => {
  const saved = { server: { dataUid: 70000, workgroup: 'W' }, issuer: 'a', clientId: 'b' };
  const uid = { 'server.dataUid': 'bad UID' };
  assert.deepEqual(standingProblems(uid, { ...saved, server: { dataUid: 70000, workgroup: 'X' } }, saved, false), {});
  assert.deepEqual(standingProblems(uid, { ...saved, server: { dataUid: '', workgroup: 'W' } }, saved, false), uid);
  const secret = { 'issuer,clientId': 're-enter' };
  assert.deepEqual(standingProblems(secret, { ...saved, clientId: 'c' }, saved, false), secret);
  assert.deepEqual(standingProblems(secret, saved, saved, false), {});
});

test('a row taken afresh (a failed save, a write elsewhere) is the same row: its problem does not stand', () => {
  const row = (name) => ({ id: rowId(), name, access: [] });
  const saved = { shares: [row('a')], users: [] };
  const problems = { 'shares.0,users': 'needs a user' };
  const form = { ...saved, workgroup: 'X' };
  const afresh = { shares: [row('a')], users: [] };
  assert.deepEqual(standingProblems(problems, form, afresh, false), {});
  assert.deepEqual(standingProblems(problems, { ...form, shares: [{ ...form.shares[0], name: 'b' }] }, afresh, false), problems);
});
