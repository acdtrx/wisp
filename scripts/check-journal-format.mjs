#!/usr/bin/env node
/**
 * The bridge journal's format number, held to what the journal holds: run with
 * `npm run check` (or `node scripts/check-journal-format.mjs`) from the repo
 * root; exits 1 when they part.
 *
 * The journal directory (scripts/linux/setup/bridge-journal.sh) holds the
 * plan's record, whose keys are plan-record.sh's PLAN_RECORD_VARS, and
 * uplink.state, whose lines are net-state.sh's l3_state facts. Another
 * release's setup misreads a journal whose keys or fact kinds differ from its
 * own, so either changing raises JOURNAL_FORMAT. PINNED is what the current
 * format holds.
 *
 * - JOURNAL_FORMAT: its `JOURNAL_FORMAT=<n>` line in bridge-journal.sh;
 * - the keys: PLAN_RECORD_VARS, evaluated by bash from plan-record.sh;
 * - the fact kinds: l3_state run by bash for each tool's branch, with net_call
 *   answering every read with lines each of its parsers takes (and systemctl's
 *   is-active with success, so the resolver's facts are read too). A kind read
 *   from a new call shows here only when that call's parser takes those lines.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PINNED = {
  format: 1,
  planKeys: ['NET_TOOL', 'UPLINK', 'UPLINK_ADDR', 'BRIDGE', 'BRIDGE_CREATE', 'UPLINK_MAC', 'UPLINK_MTU',
    'UPLINK_MODE', 'UPLINK_NETFILE', 'UPLINK_CLIENT_ID', 'UPLINK_NETPLAN_ID', 'NETPLAN_ORIGIN',
    'NETWORKD_PORT_FILE', 'UPLINK_CONNECTION', 'UPLINK_PERMADDR', 'NM_PROFILE_FILE', 'NM_BRIDGE_UUID',
    'NM_PORT_UUID', 'NM_BRIDGE_FILE', 'NM_PORT_FILE', 'HOST_KVM', 'NET_PLAN_JOURNAL'],
  factKinds: ['addr4', 'addr6', 'dns', 'domain', 'route4', 'route6'],
};

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SETUP = 'scripts/linux/setup';
const problems = [];

const bash = (script) => execFileSync('bash', ['-c', script], { cwd: ROOT, encoding: 'utf8' });
const lines = (out) => out.split('\n').filter(Boolean);

const journalSource = readFileSync(path.join(ROOT, SETUP, 'bridge-journal.sh'), 'utf8');
const formatLine = journalSource.match(/^JOURNAL_FORMAT=(\d+)$/m);
if (!formatLine) problems.push(`${SETUP}/bridge-journal.sh: no JOURNAL_FORMAT=<n> line`);
const format = formatLine ? Number(formatLine[1]) : null;

const planKeys = lines(bash(`source ${SETUP}/plan-record.sh && printf '%s\\n' "\${PLAN_RECORD_VARS[@]}"`));

const factKinds = [...new Set(lines(bash(`
  source ${SETUP}/net-state.sh || exit 1
  net_call() {
    [[ "$1" != systemctl ]] || return 0
    printf '%s\\n' '2: x inet 192.0.2.1/24 scope global' 'IP4.DNS[1]:192.0.2.53' 'IP4.DOMAIN[1]:example'
  }
  for tool in networkmanager networkd; do l3_state x "$tool" || exit 1; done
`)).map((l) => l.split(' ')[0]))].sort();

/** How <now> differs from <pinned>, or '' when they hold the same names. */
function difference(now, pinned) {
  const added = now.filter((v) => !pinned.includes(v));
  const dropped = pinned.filter((v) => !now.includes(v));
  return [added.length > 0 && `adds ${added.join(' ')}`, dropped.length > 0 && `drops ${dropped.join(' ')}`]
    .filter(Boolean).join(', ');
}
const changes = [];
const keysChange = difference(planKeys, PINNED.planKeys);
if (keysChange) changes.push(`The plan record's keys (${SETUP}/plan-record.sh, PLAN_RECORD_VARS) differ from the pin: ${keysChange}.`);
const kindsChange = difference(factKinds, PINNED.factKinds);
if (kindsChange) changes.push(`uplink.state's fact kinds (${SETUP}/net-state.sh, l3_state) differ from the pin: ${kindsChange}.`);
if (format !== null && changes.length > 0 && format === PINNED.format) {
  problems.push(...changes, `The bridge journal's format changed: raise JOURNAL_FORMAT in ${SETUP}/bridge-journal.sh, and update PINNED in scripts/check-journal-format.mjs to the new format, keys and fact kinds.`);
} else if (format !== null && format !== PINNED.format) {
  problems.push(...changes, `JOURNAL_FORMAT is ${format}, and PINNED in scripts/check-journal-format.mjs holds format ${PINNED.format}: update PINNED to this format, with its keys and fact kinds.`);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(`journal format: ${format}, holding ${planKeys.length} plan keys and the fact kinds ${factKinds.join(' ')}`);
