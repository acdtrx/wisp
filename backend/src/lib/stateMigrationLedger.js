/**
 * The state-migration rules that need no I/O (docs/specs/UPDATES.md → State
 * migrations): which files are migrations, what a loaded one must export, the
 * ledger's shape, and which migrations are pending. lib/stateMigrations.js does
 * the reading, importing, running and writing around them.
 */
import { createAppError } from './appErrors.js';

const MIGRATION_FILE_RE = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;

/** A bad migration file or ledger: nothing runs, and the start fails. */
function setupError(message, raw) {
  return createAppError('MIGRATION_SETUP', message, raw);
}

/**
 * The migration files among a directory's entries (`readdir` with
 * `withFileTypes`), in id order. Only files count: a subdirectory — `test/`,
 * the migrations' unit tests — is never a migration. Every `.js` file is one,
 * so one not named `NNNN-short-name.js` is an error rather than skipped.
 * @param {Array<{ name: string, isFile(): boolean }>} entries
 */
export function migrationFileNames(entries) {
  const files = entries.filter((e) => e.isFile() && e.name.endsWith('.js')).map((e) => e.name).sort();
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

/**
 * The ledger `{ applied: [...] }` from its file's text; `null` text (no file) is
 * an empty ledger. Every entry must be an object with a string `id`.
 */
export function parseLedger(text, path) {
  if (text === null) return { applied: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw setupError(`${path} is not valid JSON — fix or remove it by hand`, err.message);
  }
  if (!data || !Array.isArray(data.applied)) {
    throw setupError(`${path} has no "applied" array — fix or remove it by hand`);
  }
  const bad = data.applied.findIndex((e) => e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.id !== 'string');
  if (bad !== -1) {
    throw setupError(`${path}: applied[${bad}] is not an entry with a string "id" — fix or remove it by hand`);
  }
  return data;
}

/** The migrations without an `ok` ledger entry, in the order given. */
export function pendingMigrations(migrations, ledger) {
  const done = new Set(ledger.applied.filter((e) => e.result === 'ok').map((e) => e.id));
  return migrations.filter((m) => !done.has(m.id));
}

/**
 * What a migration's failure says: the error's detail or message, or what was
 * thrown. Failure is whether the migration threw or rejected, never the value it
 * threw, so a rejection with no reason still fails.
 */
export function failureMessage(error) {
  const text = error !== null && typeof error === 'object'
    ? String(error.raw || error.message || error)
    : String(error ?? '');
  return text || `failed without a reason (it threw ${typeof error === 'string' ? '""' : String(error)})`;
}

/** The ledger entry for one run: `ok`, or `error` with the failure's message (`failed` true). */
export function ledgerEntry(id, { at, changes, failed = false, error }) {
  return {
    id,
    at,
    result: failed ? 'error' : 'ok',
    changes,
    ...(failed ? { error: failureMessage(error) } : {}),
  };
}

/**
 * The ledger with `entry` recorded: one entry per id, so a rerun after an error
 * replaces the earlier one. Entries for ids no release ships any more are kept.
 */
export function recordRun(ledger, entry) {
  return { ...ledger, applied: [...ledger.applied.filter((e) => e.id !== entry.id), entry] };
}
