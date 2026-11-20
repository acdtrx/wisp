#!/usr/bin/env node
/**
 * Every route's access level and schemas: the route report
 * (`npm run route-access`, backend/src/index.js), run against a config of its
 * own so it needs nothing on the machine but the backend's packages — a fresh
 * checkout and CI alike. Exits 1 when a route lacks an access declaration or a
 * schema it needs (backend/src/routes/schemas.js, `routeSchemaProblems`),
 * printing the report; otherwise prints its summary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const dir = mkdtempSync(path.join(tmpdir(), 'wisp-check-routes-'));
try {
  const configPath = path.join(dir, 'wisp-config.json');
  writeFileSync(configPath, '{}\n');
  const env = { ...process.env, WISP_ROUTE_ACCESS_REPORT: '1', WISP_CONFIG_PATH: configPath };
  delete env.NODE_ENV;
  const run = spawnSync(process.execPath, ['backend/src/index.js'], {
    cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 60_000,
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status === 0) {
    console.log(output.trim().split('\n').slice(-2).join('\n'));
  } else {
    console.log(output);
    console.error(run.error ? `the route report did not run: ${run.error.message}` : 'routes lack an access level or a schema (SCHEMA lines above)');
  }
  process.exitCode = run.status === 0 ? 0 : 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
