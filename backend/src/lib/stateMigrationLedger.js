/**
 * The state-migration rules that need no I/O (docs/specs/UPDATES.md → State
 * migrations): which files are migrations, what a loaded one must export, the
 * ledger's shape, and which migrations are pending. lib/stateMigrations.js does
 * the reading, importing, running and writing around them.
 */
import { createAppError } from './routeErrors.js';

const MIGRATION_FILE_RE = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;

/** A bad migration file or ledger: nothing runs, and the start fails. */
function setupError(message) {
  return createAppError('MIGRATION_SETUP', message);
}

/**
 * The migration files among a directory's file names, in id order. Every `.js`
 * file is a migration, so one not named `NNNN-short-name.js` is an error rather
 * than skipped.
 */
export function migrationFileNames(fileNames) {
  const files = fileNames.filter((name) => name.endsWith('.js')).sort();
  const bad = files.find((name) => !MIGRATION_FILE_RE.test(name));
  if (bad) throw setupError(`${bad}: migration files are named NNNN-short-name.js`);
  return files;
}

/** A loaded migration module as `{ id, description, run }`; its id is its file name without `.js`. */
export function checkMigrationModule(fileName, mod) {
  const expectedId = fileName.slice(0, -'.js'.length);
  if (mod.id !== expectedId) throw setupError(`${fileName}: exports id ${JSON.stringify(mod.id)}, expected "${expectedId}"`);
  if (typeof mod.description !== 'string' || !mod.description) throw setupError(`${fileName}: missing description`);
  if (typeof mod.run !== 'function') throw setupError(`${fileName}: missing run(ctx)`);
  return { id: mod.id, description: mod.description, run: mod.run };
}

/** The ledger `{ applied: [...] }` from its file's text; `null` text (no file) is an empty ledger. */
export function parseLedger(text, path) {
  if (text === null) return { applied: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw setupError(`${path} is not valid JSON (${err.message}) — fix or remove it by hand`);
  }
  if (!data || !Array.isArray(data.applied)) {
    throw setupError(`${path} has no "applied" array — fix or remove it by hand`);
  }
  return data;
}

/** The migrations without an `ok` ledger entry, in the order given. */
export function pendingMigrations(migrations, ledger) {
  const done = new Set(ledger.applied.filter((e) => e.result === 'ok').map((e) => e.id));
  return migrations.filter((m) => !done.has(m.id));
}

/** The ledger entry for one run: `ok`, or `error` with the error's message. */
export function ledgerEntry(id, { at, changes, error = null }) {
  return {
    id,
    at,
    result: error ? 'error' : 'ok',
    changes,
    ...(error ? { error: String(error.raw || error.message || error) } : {}),
  };
}

/**
 * The ledger with `entry` recorded: one entry per id, so a rerun after an error
 * replaces the earlier one. Entries for ids no release ships any more are kept.
 */
export function recordRun(ledger, entry) {
  return { ...ledger, applied: [...ledger.applied.filter((e) => e.id !== entry.id), entry] };
}
