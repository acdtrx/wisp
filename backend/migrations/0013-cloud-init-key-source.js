/**
 * A VM's first boot setup (`cloud-init.json`) loses `sshKeySource` since 2026-11-21:
 * a VM's keys are named by Wisp's list of SSH keys (docs/specs/SETTINGS.md, SSH keys),
 * and nothing reads where a key came from any more. This removes the field from every
 * `<vmsPath>/*\/cloud-init.json`, kept directories of deleted VMs included. Wisp's own
 * file (lib/cloudInit.js), not a manager's, so it is rewritten here: atomically, 0600
 * as every save writes it (it holds the password hash). The seed ISO stays: the field
 * was never in it.
 *
 * Left alone: a file without the field, and one that is not a JSON object (the backend
 * reads it as no setup). Idempotent for the same reason.
 *
 * Backward-compatible: the previous release reads the field as optional and names the
 * key by its comment without it. A backup made before this keeps the field in its copy
 * of the file; nothing reads it, and the VM's next save writes the file without it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../src/lib/base/index.js';

export const id = '0013-cloud-init-key-source';
export const description = "cloud-init.json files lose sshKeySource (a VM's keys are named by Wisp's list)";

export async function run(ctx) {
  const { vmsPath } = ctx.getConfig();
  let entries;
  try {
    entries = await readdir(vmsPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return; // no VM directory yet
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(vmsPath, entry.name, 'cloud-init.json');
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      ctx.log.warn({ file }, '0013: cloud-init.json is not JSON; left alone');
      continue;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config) || !('sshKeySource' in config)) continue;
    const { sshKeySource: _source, ...rest } = config;
    await writeJsonAtomic(file, rest, { mode: 0o600 });
    ctx.recordChange(`${entry.name}/cloud-init.json: sshKeySource removed`);
  }
}
