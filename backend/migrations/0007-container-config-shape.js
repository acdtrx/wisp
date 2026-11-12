/**
 * Brings every `container.json` to the shape the code reads. Releases before
 * 2026-11-12 repaired older shapes when the config was read; this replaces
 * those read-time repairs:
 * - `env` as a flat `{ KEY: "value" }` dict (before 2026-04-15) becomes the
 *   structured `{ KEY: { value } }`, non-secret; a missing env becomes `{}`;
 * - a missing network, or a `network.type` other than `bridge` (macvlan, before
 *   2026-04-14), becomes `bridge`, and a missing or malformed MAC is generated;
 * - the ignored `network.vlan` field is removed.
 *
 * Env values are recorded by key count only: they may be secrets. A running
 * container whose network type or MAC changed gets the restart-required flag
 * (its task runs on the old network); the env conversion keeps every value,
 * and `vlan` was never read, so neither flags.
 *
 * Backward-compatible: the previous release writes this shape itself.
 * Idempotent: a container already in it is left alone.
 */
export const id = '0007-container-config-shape';
export const description = 'container.json: structured env, bridge network with a MAC, no vlan field';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Bring `config.env` to `{ KEY: { value } }` (mutates). Returns change texts. */
function migrateEnv(config) {
  if (!isPlainObject(config.env)) {
    config.env = {};
    return ['env → {}'];
  }
  let converted = 0;
  for (const [key, value] of Object.entries(config.env)) {
    if (isPlainObject(value)) continue;
    config.env[key] = { value: typeof value === 'string' ? value : String(value ?? '') };
    converted += 1;
  }
  return converted ? [`env: ${converted} flat entr${converted === 1 ? 'y' : 'ies'} → { value }`] : [];
}

/**
 * Bring `config.network` to a bridge network with a MAC and no `vlan` (mutates).
 * Returns `{ changes, needsRestart }`.
 */
function migrateNetwork(config, generateMac) {
  const changes = [];
  let needsRestart = false;
  if (!isPlainObject(config.network)) {
    config.network = {};
    changes.push('network missing → { type: bridge }');
  }
  const net = config.network;
  if (net.type !== 'bridge') {
    if (changes.length === 0) changes.push(`network.type ${JSON.stringify(net.type ?? null)} → bridge`);
    net.type = 'bridge';
    needsRestart = true;
  }
  const mac = typeof net.mac === 'string' ? net.mac.trim().toLowerCase() : '';
  if (!MAC_RE.test(mac)) {
    const was = net.mac == null || net.mac === '' ? 'missing' : 'malformed';
    net.mac = generateMac();
    changes.push(`network.mac ${was} → ${net.mac}`);
    needsRestart = true;
  }
  if ('vlan' in net) {
    delete net.vlan;
    changes.push('network.vlan removed');
  }
  return { changes, needsRestart };
}

export async function run(ctx) {
  const cm = ctx.containerManager;
  const containers = await cm.listContainers();
  for (const { name, state } of containers) {
    const config = await cm.readContainerConfig(name);
    const envChanges = migrateEnv(config);
    const { changes: netChanges, needsRestart } = migrateNetwork(config, cm.generateContainerMac);
    const changes = [...envChanges, ...netChanges];
    if (changes.length === 0) continue;

    const running = state === 'running' || state === 'paused';
    const flag = running && needsRestart;
    ctx.recordChange(`${name}: ${changes.join('; ')}${flag ? ' (restart required)' : ''}`);
    if (ctx.dryRun) continue;
    await cm.writeContainerConfig(name, config);
    if (flag) await ctx.setContainerPendingRestart(name, true);
  }
}
