/**
 * wisp-cni takes a container's name, its bridge and its MAC address, names the
 * CNI plugins' folder itself and writes the network configuration for each
 * call: the WISP_CNI_BIN_DIR and WISP_CNI_CONF_DIR overrides are retired.
 * runtime.env, read raw: lines setting them are removed. The start loads the
 * file tolerating them until then.
 *
 * Backward-compatible: the previous release falls back to /opt/cni/bin and
 * /etc/cni/net.d without them, the only folders its helper and setup used. A
 * rollback reverts config/ and the ledger together, so this
 * runs again on the next update. Idempotent: a file without them is left alone.
 */
import { readFile, stat } from 'node:fs/promises';

import { writeFileAtomic } from '../src/lib/base/index.js';
import { retiredKeyOfLine, RETIRED_CNI_DIR_KEYS } from '../src/lib/loadRuntimeEnv.js';

export const id = '0015-retire-cni-dir-overrides';
export const description = 'runtime.env: the retired WISP_CNI_BIN_DIR and WISP_CNI_CONF_DIR overrides removed';

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
    const key = retiredKeyOfLine(line, RETIRED_CNI_DIR_KEYS);
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
