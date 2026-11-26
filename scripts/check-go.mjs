#!/usr/bin/env node
/**
 * The `wisp` CLI's checks (docs/TECH-STACK.md, The CLI), run in cli/ with
 * `npm run check` (or `node scripts/check-go.mjs`) from the repo root; exits 1
 * when any fails, after running them all, and when Go is not installed (the
 * check needs it, never skips it):
 *
 * - `gofmt -l`: any file it names fails;
 * - `go vet ./...` once for each platform the CLI ships for (cli/platforms,
 *   the list's one home), so every platform's build-tagged files compile;
 * - staticcheck, at the version pinned below (a build tool, not a dependency
 *   of the module), once for each platform: `go run` would build the tool
 *   for GOOS, so it is installed once, for this machine, into a temporary
 *   folder, and run with each GOOS/GOARCH;
 * - `go test ./...`: the unit tests and the end-to-end test of the built binary.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = fileURLToPath(new URL('../cli/', import.meta.url));
const STATICCHECK = 'honnef.co/go/tools/cmd/staticcheck@v0.8.2';
/** The platforms the CLI ships for, as GOOS/GOARCH, from their one home (scripts/stage-release.sh builds the same). */
const PLATFORMS = readFileSync(path.join(CLI_DIR, 'platforms'), 'utf8').split('\n').filter(Boolean).map((p) => p.replace('-', '/'));

function run(label, command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: CLI_DIR,
    env: { ...process.env, CGO_ENABLED: '0', ...env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.error) return { ok: false, output: `${label}: ${result.error.message}` };
  const output = `${result.stdout}${result.stderr}`.trim();
  return { ok: result.status === 0, output };
}

const probe = spawnSync('go', ['version'], { encoding: 'utf8' });
if (probe.error) {
  console.error(probe.error.code === 'ENOENT'
    ? 'go is not installed, and the CLI\'s check needs it: install Go (https://go.dev/dl/, or brew install go), at the version cli/go.mod names or later.'
    : `could not run go: ${probe.error.message}`);
  process.exit(1);
}

const problems = [];

const fmt = run('gofmt', 'gofmt', ['-l', '.']);
if (!fmt.ok) problems.push(fmt.output);
else if (fmt.output) problems.push(`gofmt would change these files (run gofmt -w in cli/):\n${fmt.output}`);

for (const platform of PLATFORMS) {
  const [GOOS, GOARCH] = platform.split('/');
  const vet = run(`go vet (${platform})`, 'go', ['vet', './...'], { GOOS, GOARCH });
  if (!vet.ok) problems.push(`go vet for ${platform}:\n${vet.output}`);
}

const toolDir = mkdtempSync(path.join(tmpdir(), 'wisp-staticcheck-'));
try {
  const install = run('staticcheck install', 'go', ['install', STATICCHECK], { GOBIN: toolDir });
  if (!install.ok) problems.push(`installing ${STATICCHECK}:\n${install.output}`);
  else {
    for (const platform of PLATFORMS) {
      const [GOOS, GOARCH] = platform.split('/');
      const check = run(`staticcheck (${platform})`, path.join(toolDir, 'staticcheck'), ['./...'], { GOOS, GOARCH });
      if (!check.ok) problems.push(`staticcheck for ${platform}:\n${check.output}`);
    }
  }
} finally {
  rmSync(toolDir, { recursive: true, force: true });
}

const test = run('go test', 'go', ['test', './...']);
if (!test.ok) problems.push(`go test:\n${test.output}`);

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\nThe CLI's check fails (${probe.stdout.trim()}, in ${path.relative(process.cwd(), CLI_DIR) || 'cli'}).`);
  process.exit(1);
}
console.log(`OK — the CLI is gofmt-clean, vets and passes staticcheck on ${PLATFORMS.length} platforms, and passes its tests (${probe.stdout.trim()}).`);
