/**
 * State migrations, run by the backend at every start before anything else
 * reads stored state: they bring what an earlier release wrote (domain XML,
 * container.json, config and file modes) up to the shape the current code
 * targets. Contract: docs/specs/UPDATES.md → State migrations; the rules with
 * no I/O are lib/stateMigrationLedger.js.
 *
 * Ledger: <config dir>/migrations.json, beside wisp-config.json, so
 * WISP_CONFIG_PATH moves it too. With nothing pending a start reads the ledger
 * and the migration file names, and connects to nothing.
 *
 * Nothing reads wisp-config.json strictly before the migrations have run:
 * migration 0007 repairs what older releases left in it, so the manager setup
 * and ctx.getConfig() read its paths tolerantly (migrations/lib/tolerantConfig.js).
 * The start checks the config strictly once this has returned.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readTolerantConfig } from '../../migrations/lib/tolerantConfig.js';
import { writeJsonAtomic } from './base/index.js';
import { CONFIG_PATH } from './config.js';
import { configureManagers, connectManagers, disconnectManagers } from './managerBootstrap.js';
import { createAppError } from './appErrors.js';
import {
  checkMigrationModule, ledgerEntry, migrationFileNames, parseLedger, pendingMigrations, recordRun,
} from './stateMigrationLedger.js';
import * as vmManager from './vmManager/index.js';
import * as containerManager from './containerManager/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = resolve(__dirname, '..', '..', '..');
const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'migrations');
const CONFIG_DIR = dirname(CONFIG_PATH);
const LEDGER_PATH = join(CONFIG_DIR, 'migrations.json');
const RUNTIME_ENV_PATH = join(INSTALL_DIR, 'config', 'runtime.env');

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw createAppError('MIGRATION_SETUP', `cannot read ${path}`, err.message);
  }
}

/**
 * Every migration module, in id order. A missing directory is an error, not "no
 * migrations": the release ships it, so its absence means a broken tree.
 */
async function loadMigrations() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (err) {
    throw createAppError('MIGRATION_SETUP', `cannot read migrations directory ${MIGRATIONS_DIR}`, err.message);
  }
  const files = migrationFileNames(entries);
  const migrations = [];
  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(join(MIGRATIONS_DIR, file)).href);
    } catch (err) {
      throw createAppError('MIGRATION_SETUP', `${file}: cannot be loaded`, err?.message ?? String(err));
    }
    migrations.push(checkMigrationModule(file, mod));
  }
  return migrations;
}

function writeLedger(ledger) {
  return writeJsonAtomic(LEDGER_PATH, ledger, { mode: 0o600 });
}

function getTolerantConfig() {
  return readTolerantConfig(CONFIG_PATH);
}

/**
 * What a migration gets. Changes go through the managers (the app's own code
 * paths), never by editing their files directly, and each is reported through
 * recordChange, which logs it and lands it in the ledger entry. The managers
 * run without event watching here (connectManagers watchEvents: false): list
 * calls read live state, the whole list or an error, so a migration never
 * passes over workloads it could not see, and nothing reacts to its changes
 * before the start connects them for normal work.
 */
function buildContext(migration, { log, changes }) {
  const migrationLog = log.child({ migration: migration.id });
  return {
    log: migrationLog,
    vmManager,
    containerManager,
    getConfig: getTolerantConfig,
    paths: { installDir: INSTALL_DIR, configDir: CONFIG_DIR, configFile: CONFIG_PATH, runtimeEnvFile: RUNTIME_ENV_PATH },
    setVMPendingRestart: vmManager.setVMPendingRestart,
    setContainerPendingRestart: containerManager.setContainerPendingRestart,
    recordChange(text) {
      changes.push(text);
      migrationLog.info(text);
    },
  };
}

/** Run `pending` in order, writing the ledger after each; the first failure stops the run. */
async function runPending(pending, ledger, log) {
  configureManagers({ getConfig: getTolerantConfig, logger: log });
  await connectManagers(log, { watchEvents: false });
  let current = ledger;
  try {
    for (const migration of pending) {
      const changes = [];
      log.info({ migration: migration.id }, `running: ${migration.description}`);
      let failed = false;
      let error;
      try {
        await migration.run(buildContext(migration, { log, changes }));
      } catch (err) {
        failed = true;
        error = err;
      }
      const entry = ledgerEntry(migration.id, { at: new Date().toISOString(), changes, failed, error });
      current = recordRun(current, entry);
      await writeLedger(current);
      if (failed) {
        log.error({ migration: migration.id, err: error }, 'migration failed — later migrations not run');
        throw createAppError('MIGRATION_FAILED', `state migration ${migration.id} failed: ${entry.error}`);
      }
      log.info({ migration: migration.id, changes: changes.length }, 'migration done');
    }
  } finally {
    disconnectManagers();
  }
}

/**
 * Run every pending migration. Throws MIGRATION_SETUP for a bad migration file,
 * an unreadable or malformed ledger, a config that is not JSON, or a run as root
 * that would write, and
 * MIGRATION_FAILED for a migration that threw (recorded as `error` in the
 * ledger, so the next start runs it again).
 */
export async function migrateState(log) {
  const migrations = await loadMigrations();
  const ledgerText = await readIfExists(LEDGER_PATH);
  const ledger = parseLedger(ledgerText, LEDGER_PATH);
  const pending = pendingMigrations(migrations, ledger);

  // Whatever runs here writes the ledger and the migrations' state, which the
  // service (the deploy user) must keep reading and writing.
  if ((pending.length > 0 || ledgerText === null) && process.getuid?.() === 0) {
    throw createAppError(
      'MIGRATION_SETUP',
      'state migrations must run as the deploy user, not root: files they write as root would be unreadable to wisp.service',
    );
  }

  if (pending.length === 0) {
    log.info({ ledger: LEDGER_PATH, shipped: migrations.length }, 'state migrations: none pending');
    // A ledger on disk records that this host's state has been brought up to date.
    if (ledgerText === null) await writeLedger(ledger);
    return;
  }

  log.info(
    { ledger: LEDGER_PATH, shipped: migrations.length, pending: pending.map((m) => m.id) },
    `state migrations: ${pending.length} pending`,
  );
  // The migrations read the config tolerantly, but it must still be JSON.
  try {
    getTolerantConfig();
  } catch (err) {
    throw createAppError('MIGRATION_SETUP', `${CONFIG_PATH} can't be read for the migrations`, err.message);
  }
  await runPending(pending, ledger, log);
}
