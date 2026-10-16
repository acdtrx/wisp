#!/usr/bin/env node
/**
 * State-migration runner: brings state an earlier Wisp release wrote (domain
 * XML, container.json, file modes) up to the schema the current code targets.
 * Runs on every update from scripts/linux/setup/common-steps.sh, as the deploy
 * user, with wisp.service stopped. Contract: docs/spec/UPDATES.md → State
 * migrations.
 *
 *   node backend/scripts/migrate.mjs              run every pending migration
 *   node backend/scripts/migrate.mjs --dry-run    run them with ctx.dryRun, record nothing
 *   node backend/scripts/migrate.mjs --list       show applied / pending, run nothing
 *   --migrations-dir <dir>                        read migrations from <dir> (testing the runner)
 *
 * Ledger: <config dir>/migrations.json (beside wisp-config.json, so
 * WISP_CONFIG_PATH moves it too). Exit 0 when nothing failed; non-zero on the
 * first failing migration, after recording it — the updater then rolls back.
 */
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import Fastify from 'fastify';

import { loadRuntimeEnv } from '../src/lib/loadRuntimeEnv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// runtime.env before any module that reads the environment as it loads:
// config.js resolves WISP_CONFIG_PATH (and with it the ledger path) at import,
// containerManager its socket path. Static imports would evaluate them first.
// Under systemd the backend gets runtime.env from EnvironmentFile=; this script
// runs from common-steps.sh / install.sh, which pass no environment.
loadRuntimeEnv(PROJECT_ROOT);

const { writeJsonAtomic } = await import('../src/lib/atomicJson.js');
const { CONFIG_PATH, getConfigSync } = await import('../src/lib/config.js');
const { DEV_LOG_TRANSPORT } = await import('../src/lib/logFormat.js');
const { configureManagers, connectManagers, disconnectManagers } = await import('../src/lib/managerBootstrap.js');
const vmManager = await import('../src/lib/vmManager/index.js');
const containerManager = await import('../src/lib/containerManager/index.js');

const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');
const CONFIG_DIR = dirname(CONFIG_PATH);
const LEDGER_PATH = join(CONFIG_DIR, 'migrations.json');

const MIGRATION_FILE_RE = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;

/** Usage and setup errors: printed as one line, exit 2 — nothing ran. */
class SetupError extends Error {}

function parseCliArgs() {
  try {
    const { values } = parseArgs({
      options: {
        list: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'migrations-dir': { type: 'string' },
      },
    });
    if (values.list && values['dry-run']) throw new SetupError('--list and --dry-run are exclusive');
    return {
      list: values.list,
      dryRun: values['dry-run'],
      migrationsDir: values['migrations-dir'] ? resolve(values['migrations-dir']) : DEFAULT_MIGRATIONS_DIR,
    };
  } catch (err) {
    throw err instanceof SetupError ? err : new SetupError(err.message);
  }
}

/**
 * Load every migration module in id order. A missing directory is an error, not
 * "no migrations": the release ships the directory, so its absence means a
 * wrong path, which must not pass as a clean run.
 */
async function loadMigrations(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new SetupError(`cannot read migrations directory ${dir}: ${err.message}`);
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => e.name)
    .sort();
  const migrations = [];
  for (const file of files) {
    if (!MIGRATION_FILE_RE.test(file)) {
      throw new SetupError(`${file}: migration files are named NNNN-short-name.js`);
    }
    const mod = await import(pathToFileURL(join(dir, file)).href);
    const expectedId = basename(file, '.js');
    if (mod.id !== expectedId) throw new SetupError(`${file}: exports id ${JSON.stringify(mod.id)}, expected "${expectedId}"`);
    if (typeof mod.description !== 'string' || !mod.description) throw new SetupError(`${file}: missing description`);
    if (typeof mod.run !== 'function') throw new SetupError(`${file}: missing run(ctx)`);
    migrations.push({ id: mod.id, description: mod.description, run: mod.run });
  }
  return migrations;
}

/** `{ applied: [{ id, at, result, changes, error? }] }`; a missing file is an empty ledger. */
async function readLedger() {
  let raw;
  try {
    raw = await readFile(LEDGER_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, ledger: { applied: [] } };
    throw new SetupError(`cannot read ${LEDGER_PATH}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new SetupError(`${LEDGER_PATH} is not valid JSON (${err.message}) — fix or remove it by hand`);
  }
  if (!data || !Array.isArray(data.applied)) {
    throw new SetupError(`${LEDGER_PATH} has no "applied" array — fix or remove it by hand`);
  }
  return { exists: true, ledger: data };
}

function writeLedger(ledger) {
  return writeJsonAtomic(LEDGER_PATH, ledger, { mode: 0o600 });
}

/** One entry per id: a rerun (after an error) replaces the earlier entry. */
function recordRun(ledger, entry) {
  ledger.applied = ledger.applied.filter((e) => e.id !== entry.id);
  ledger.applied.push(entry);
}

function printList(migrations, ledger) {
  const byId = new Map(ledger.applied.map((e) => [e.id, e]));
  const shipped = new Set(migrations.map((m) => m.id));
  console.log(`Ledger: ${LEDGER_PATH}`);
  if (migrations.length === 0 && ledger.applied.length === 0) {
    console.log('No migrations.');
    return;
  }
  for (const m of migrations) {
    const entry = byId.get(m.id);
    if (!entry) {
      console.log(`pending  ${m.id}  ${m.description}`);
    } else if (entry.result === 'ok') {
      console.log(`applied  ${m.id}  ${entry.at}  ${entry.changes?.length ?? 0} change(s)`);
    } else {
      console.log(`failed   ${m.id}  ${entry.at}  ${entry.error ?? ''} (runs again next time)`);
    }
  }
  for (const entry of ledger.applied) {
    if (!shipped.has(entry.id)) console.log(`${entry.result === 'ok' ? 'applied' : 'failed '}  ${entry.id}  ${entry.at}  (not shipped by this release)`);
  }
}

function createLogger() {
  const isDev = process.env.NODE_ENV === 'development';
  // pino is Fastify's dependency, not the backend's: take the logger from a
  // (never listening) Fastify instance so this script logs exactly like the
  // backend without importing a package package.json doesn't declare.
  return Fastify({ logger: isDev ? { transport: DEV_LOG_TRANSPORT } : true }).log;
}

/**
 * What a migration gets. Changes go through the managers (the app's own code
 * paths), never by editing their files directly; every change is reported via
 * recordChange, which logs it and lands it in the ledger entry. The managers
 * run without event watching (connectManagers watchEvents: false): list calls
 * read live state — the whole list or an error, so a migration never passes over
 * workloads it could not see — and nothing reacts to the migration's changes in
 * this process.
 */
function buildContext(migration, { log, dryRun, changes }) {
  const migrationLog = log.child({ migration: migration.id });
  return {
    dryRun,
    log: migrationLog,
    vmManager,
    containerManager,
    getConfig: getConfigSync,
    paths: { installDir: PROJECT_ROOT, configDir: CONFIG_DIR },
    // Restart-required setters, when the manager facades provide them.
    setVMPendingRestart: typeof vmManager.setVMPendingRestart === 'function' ? vmManager.setVMPendingRestart : undefined,
    setContainerPendingRestart: typeof containerManager.setContainerPendingRestart === 'function'
      ? containerManager.setContainerPendingRestart
      : undefined,
    recordChange(text) {
      changes.push(text);
      migrationLog.info({ dryRun }, text);
    },
  };
}

/** Returns the process exit code. */
async function runPending(pending, { ledger, dryRun, log }) {
  configureManagers();
  // Connections and calls only: the backend owns the reconcilers and restart
  // policy, and it comes back once the update finishes.
  await connectManagers(log, { watchEvents: false });
  try {
    for (const migration of pending) {
      const changes = [];
      const ctx = buildContext(migration, { log, dryRun, changes });
      log.info({ migration: migration.id, dryRun }, `running: ${migration.description}`);
      let error = null;
      try {
        await migration.run(ctx);
      } catch (err) {
        error = err;
      }
      const entry = {
        id: migration.id,
        at: new Date().toISOString(),
        result: error ? 'error' : 'ok',
        changes,
        ...(error ? { error: String(error.raw || error.message || error) } : {}),
      };
      if (!dryRun) {
        recordRun(ledger, entry);
        await writeLedger(ledger);
      }
      if (error) {
        log.error({ migration: migration.id, err: error }, 'migration failed — later migrations not run');
        return 1;
      }
      log.info({ migration: migration.id, dryRun, changes: changes.length }, 'migration done');
    }
    return 0;
  } finally {
    disconnectManagers();
  }
}

async function main() {
  const args = parseCliArgs();
  if (process.getuid?.() === 0) {
    throw new SetupError('run as the deploy user, not root (common-steps.sh uses sudo -u)');
  }

  const migrations = await loadMigrations(args.migrationsDir);
  const { exists, ledger } = await readLedger();

  if (args.list) {
    printList(migrations, ledger);
    return 0;
  }

  const log = createLogger();
  const done = new Set(ledger.applied.filter((e) => e.result === 'ok').map((e) => e.id));
  const pending = migrations.filter((m) => !done.has(m.id));
  log.info({ ledger: LEDGER_PATH, shipped: migrations.length, pending: pending.length, dryRun: args.dryRun }, 'state migrations');

  if (pending.length === 0) {
    // A ledger file on disk records that the runner has run on this host.
    if (!exists && !args.dryRun) await writeLedger(ledger);
    return 0;
  }
  return runPending(pending, { ledger, dryRun: args.dryRun, log });
}

main().then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof SetupError) {
      console.error(`migrate: ${err.message}`);
      process.exit(2);
    }
    console.error('migrate: unexpected failure:', err);
    process.exit(1);
  },
);
