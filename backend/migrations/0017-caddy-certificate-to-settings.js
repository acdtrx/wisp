/**
 * The Caddy app's domain and Cloudflare token become the host's certificate
 * setting (docs/specs/CERTIFICATES.md; docs/specs/CUSTOM-APPS.md, Containers made
 * before the host's certificate). Before, each Caddy container held its own
 * `domain`, `email`, `cloudflareDnsEnabled` and `cloudflareApiToken` and got its
 * certificate itself; now Wisp gets one for the host, and a Caddy app's
 * appConfig holds `hosts` only.
 *
 * - When wisp-config.json has no `certificate`, the first Caddy container by
 *   name that holds both a domain and a token gives them. A domain the setting
 *   cannot hold (not DNS labels) is reported and not moved.
 * - Every Caddy container's appConfig then loses the four fields, through
 *   containerManager's own read and write. Its env, mounts, Caddyfile and image
 *   are not touched, so it keeps serving with its own certificate, across a
 *   restart too, until Wisp's first delivery rewrites them.
 *
 * The setting is written before the containers, so a start cut between the two
 * runs this again with nothing lost. Not backward-compatible for the Caddy
 * containers: the previous release's form would show them without a domain.
 * A rollback reverts config/ and the ledger, so this runs again on the next
 * update, but the containers' appConfig stays as written here. Idempotent: a
 * host with a setting keeps it, and an appConfig without the fields is left alone.
 */
import { readFile } from 'node:fs/promises';

import { writeJsonAtomic } from '../src/lib/base/index.js';
import { checkCertificateDomain } from '../src/lib/configSchema.js';

export const id = '0017-caddy-certificate-to-settings';
export const description = "The Caddy app's domain and token become the host's certificate setting; its appConfig keeps hosts only";

const CADDY_APP = 'caddy-reverse-proxy';
const RETIRED_FIELDS = ['domain', 'email', 'cloudflareDnsEnabled', 'cloudflareApiToken'];

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** The domain in the setting's form, or null when it cannot be. */
function settingDomain(value) {
  try {
    return checkCertificateDomain(value);
  } catch {
    return null; // the check's refusal means only "not a domain the setting holds"
  }
}

async function readConfigFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function run(ctx) {
  const cm = ctx.containerManager;
  const caddies = [];
  for (const { name } of await cm.listContainers()) {
    const config = await cm.readContainerConfig(name);
    if (config?.metadata?.app === CADDY_APP && isPlainObject(config.metadata.appConfig)) caddies.push({ name, config });
  }
  caddies.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (caddies.length === 0) return;

  const path = ctx.paths.configFile;
  const data = await readConfigFile(path);
  if (isPlainObject(data) && data.certificate == null) {
    for (const { name, config } of caddies) {
      const { domain, cloudflareApiToken } = config.metadata.appConfig;
      if (typeof domain !== 'string' || !domain.trim() || typeof cloudflareApiToken !== 'string' || !cloudflareApiToken.trim()) continue;
      const checked = settingDomain(domain);
      if (!checked) {
        ctx.recordChange(`${name}: domain ${JSON.stringify(domain)} not moved to the certificate setting: it is not a domain the setting holds`);
        continue;
      }
      data.certificate = { domain: checked, cloudflareApiToken: cloudflareApiToken.trim() };
      await writeJsonAtomic(path, data, { mode: 0o600 });
      ctx.recordChange(`wisp-config.json: certificate setting from ${name}: domain ${checked} and its Cloudflare token`);
      break;
    }
  }

  for (const { name, config } of caddies) {
    const appConfig = config.metadata.appConfig;
    const dropped = RETIRED_FIELDS.filter((key) => key in appConfig);
    if (dropped.length === 0) continue;
    for (const key of dropped) delete appConfig[key];
    await cm.writeContainerConfig(name, config);
    ctx.recordChange(`${name}: appConfig loses ${dropped.join(', ')}`);
  }
}
