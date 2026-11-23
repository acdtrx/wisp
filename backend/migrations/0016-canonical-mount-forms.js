/**
 * Every mount in wisp-config.json, read raw, in the form wisp-mount takes and
 * the settings now store: a mountPath in canonical form (`/mnt/wisp/nas/` and
 * `/mnt/wisp//nas` → `/mnt/wisp/nas`), and an SMB share as `//host/share[/…]`
 * (`\\nas\share` and `//nas/share/` → `//nas/share`). Before, the settings
 * stored what was typed and the helper normalised it with `realpath`; the
 * helper now refuses anything but that form, and the start reads a mountPath
 * only in it.
 *
 * A share that cannot be brought into the form (no share after the host, a
 * comma) is left as it is and reported: its mount fails, saying the form, until
 * it is edited. A mountPath can always be: 0007 removed every one outside
 * /mnt/wisp, and the settings never stored one that was not absolute.
 *
 * Backward-compatible: the previous release takes these forms as it took the
 * others. A rollback reverts config/ and the ledger together, so this runs
 * again on the next update. Idempotent: mounts in these forms are left alone.
 */
import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../src/lib/base/index.js';
import { checkMountPath, checkShare } from '../src/lib/configSchema.js';

export const id = '0016-canonical-mount-forms';
export const description = 'wisp-config.json: mount paths in canonical form, SMB shares as //host/share';

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** The value in its form, or null when it cannot be brought into it. */
function inForm(check, value) {
  try {
    return check(value);
  } catch {
    return null;
  }
}

export async function run(ctx) {
  const path = ctx.paths.configFile;
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return; // no config: no mounts
    if (err instanceof SyntaxError) return; // the start's strict check judges it
    throw err;
  }
  if (!isPlainObject(data) || !Array.isArray(data.mounts)) return;
  let changed = false;
  for (const m of data.mounts) {
    if (!isPlainObject(m)) continue;
    const name = `mount ${JSON.stringify(m.id)} (${JSON.stringify(m.label ?? '')})`;
    if (typeof m.mountPath === 'string') {
      const canonical = inForm(checkMountPath, m.mountPath);
      if (canonical && canonical !== m.mountPath) {
        ctx.recordChange(`wisp-config.json: ${name}: mountPath ${JSON.stringify(m.mountPath)} → ${JSON.stringify(canonical)}`);
        m.mountPath = canonical;
        changed = true;
      }
    }
    if (m.type === 'smb' && typeof m.share === 'string') {
      const share = inForm(checkShare, m.share);
      if (share === null) {
        ctx.recordChange(`wisp-config.json: ${name}: share ${JSON.stringify(m.share)} left as it is: it is not //host/share[/folder], and it will not mount until it is edited`);
      } else if (share !== m.share) {
        ctx.recordChange(`wisp-config.json: ${name}: share ${JSON.stringify(m.share)} → ${JSON.stringify(share)}`);
        m.share = share;
        changed = true;
      }
    }
  }
  if (changed) await writeJsonAtomic(path, data, { mode: 0o600 });
}
