/**
 * A privileged helper is only ever the one setup installs in /usr/local/bin
 * (the path its sudoers rule names): the WISP_POWER_SCRIPT,
 * WISP_DMIDECODE_SCRIPT, WISP_SMARTCTL_SCRIPT, WISP_NETNS_SCRIPT and
 * WISP_CNI_SCRIPT overrides are retired. runtime.env, read raw: lines setting
 * them are removed. The start loads the file tolerating them until then.
 *
 * Backward-compatible: the previous release falls back to /usr/local/bin
 * without them. A rollback reverts config/ and the ledger together, so this
 * runs again on the next update. Idempotent: a file without them is left alone.
 */
import { readFile, stat } from 'node:fs/promises';

import { writeFileAtomic } from '../src/lib/atomicJson.js';
import { retiredKeyOfLine, RETIRED_HELPER_PATH_KEYS } from '../src/lib/loadRuntimeEnv.js';

export const id = '0014-retire-helper-path-overrides';
export const description = 'runtime.env: the retired WISP_*_SCRIPT helper-path overrides removed';

export async function run(ctx) {
  const path = ctx.paths.runtimeEnvFile;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return; // no runtime.env: nothing set
    throw err;
  }
  const lines = text.split('\n');
  const kept = lines.filter((line, i) => {
    const key = retiredKeyOfLine(line, RETIRED_HELPER_PATH_KEYS);
    if (!key) return true;
    ctx.recordChange(`runtime.env line ${i + 1}: removed retired ${key}`);
    return false;
  });
  if (kept.length !== lines.length) {
    const { mode } = await stat(path);
    // Staged, synced and renamed; a crash's leftover temp file is swept at boot.
    await writeFileAtomic(path, kept.join('\n'), { mode: mode & 0o777 });
  }
}
