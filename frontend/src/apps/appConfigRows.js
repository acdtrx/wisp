/**
 * An app's lists (Caddy's sites, a Samba server's shares) are saved one row at a time:
 * each save sends the whole app config with that one row changed
 * (docs/specs/UI-CONTAINER.md, App containers). A row is found by its key as the editor
 * opened on it.
 */

/**
 * The key of every command that sends an app's whole config (a row's removal, a
 * switch): they share it, so one runs at a time, and the app's rows and switches are
 * off while it runs — a second built from the record before the first landed would
 * undo it.
 */
export const APP_CONFIG_COMMAND = 'appConfig';

/** Why an app's rows and switches are off: a job on the container (`busy`), or one of
 *  its whole-config commands running (`act`, the page's command hook). */
export const appRowReason = (busy, act) => busy
  ?? (act.isBusy(APP_CONFIG_COMMAND) ? 'another change to the app is being saved' : undefined);

/** Whether the whole-config command running is the one `about` names (its row shows it). */
export const appCommandRunning = (act, about) => act.isBusy(APP_CONFIG_COMMAND) && act.aboutOf(APP_CONFIG_COMMAND) === about;

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
