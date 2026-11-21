/**
 * An app's lists (Caddy's sites, a Samba server's shares) are saved one row at a time:
 * each save sends the whole app config with that one row changed
 * (docs/specs/UI-CONTAINER.md, App containers). A row is found by its key as the editor
 * opened on it.
 */

/** `list` with the row of key `key` replaced by `row` (no key, or no such row: added at
 *  the end). */
export function withRow(list, keyOf, key, row) {
  const rows = Array.isArray(list) ? list : [];
  if (key == null || !rows.some((r) => keyOf(r) === key)) return [...rows, row];
  return rows.map((r) => (keyOf(r) === key ? row : r));
}

/** `list` without the row of key `key`. */
export function withoutRow(list, keyOf, key) {
  return (Array.isArray(list) ? list : []).filter((r) => keyOf(r) !== key);
}

/** Whether another row than the one of key `own` has key `key` (a duplicate). */
export function keyTaken(list, keyOf, key, own) {
  return (Array.isArray(list) ? list : []).some((r) => keyOf(r) === key && keyOf(r) !== own);
}
