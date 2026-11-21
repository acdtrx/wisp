/**
 * Whether a workload page follows a rename made elsewhere, pure so it can be tested,
 * as one step per event. `known` is what the page knows: the name it shows, the last
 * uuid its config record had for that name (kept past a 404 for the old name, which
 * drops the record's data), and the list topic's frame as it was when that uuid was
 * learned. An event is what the page sees now: the name it shows, its record's uuid
 * (null when the record has none), and the list topic's last frame. The step answers
 * what is known next, and the name to follow to: the name the list gives the known
 * uuid, once the list no longer lists the shown name — from a frame newer than the
 * uuid only. A frame the record was read after is older than what the record says:
 * the page of a name just renamed to by this client, whose record lands before the
 * list's frame, stays.
 *
 * @typedef {{ name: string | null, uuid: string | null, list: unknown }} Known
 * @param {Known} known
 * @param {{ name: string, recordUuid: string | null, list: unknown }} event
 * @returns {{ known: Known, renamedTo: string | null }}
 */
export function renameStep(known, { name, recordUuid, list }) {
  let next = known;
  if (known.name !== name) next = { name, uuid: null, list: null };
  if (recordUuid && recordUuid !== next.uuid) next = { name, uuid: recordUuid, list };
  return { known: next, renamedTo: list === next.list ? null : renamedTo(name, next.uuid, list) };
}

/** The new name of the workload shown as `name` with identity `uuid`, or null. */
function renamedTo(name, uuid, list) {
  if (!uuid || !Array.isArray(list) || list.some((w) => w.name === name)) return null;
  const match = list.find((w) => w.uuid === uuid);
  return match && match.name !== name ? match.name : null;
}

/** What a page knows before its first event. */
export const UNKNOWN = Object.freeze({ name: null, uuid: null, list: null });
