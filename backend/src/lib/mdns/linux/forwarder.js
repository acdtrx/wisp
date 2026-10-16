/**
 * In-process DNS forwarder on 169.254.53.53:53 (UDP + TCP) for Wisp containers.
 *
 * Each container's /etc/resolv.conf points at 169.254.53.53 (the Wisp mDNS stub
 * IP, held on the wisp-dns0 dummy interface and answered on the containers'
 * bridge). This forwarder receives those queries and:
 *   - `<name>.local` forward (A/AAAA) for a Wisp-published workload → answered
 *     from avahi.js's in-memory registry (no avahi round-trip)
 *   - the host's own `.local` name (avahi's current host name) → answered from
 *     the addresses on the containers' bridge (no avahi round-trip)
 *   - any other `<name>.local` forward (A/AAAA) → resolved via avahi DBus
 *     (avahi.js); link-local results are dropped
 *   - `<ip>.in-addr.arpa` / `<ip>.ip6.arpa` (PTR) → tried via avahi first
 *     (so containers in the Wisp registry get nice reverse names); falls
 *     through to upstream on miss so real reverse zones still work
 *   - everything else → relayed raw to the host's upstream DNS, parsed
 *     once from /etc/resolv.conf's first `nameserver` line, over the same
 *     transport (UDP or TCP) the query arrived on
 *
 * Replaces the previous design (systemd-resolved with MulticastDNS=resolve +
 * bind-mounted /etc/hosts per container) which conflicted with avahi on
 * port 5353. Here avahi is the sole owner of 5353; the forwarder talks to
 * avahi over DBus, not the wire.
 *
 * Binding port 53 needs CAP_NET_BIND_SERVICE — granted via AmbientCapabilities
 * in wisp.service. If binding fails (missing capability, stub IP not
 * on wisp-dns0, etc.) the failure is logged and the backend continues without the
 * forwarder — container operations work, only `.local` in containers breaks.
 */
import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { readFileSync } from 'node:fs';

import { resolveLocalName, resolveLocalAddress, lookupLocalEntry, getHostFqdn } from './avahi.js';

const STUB_IP = '169.254.53.53';
const PORT = 53;
const UPSTREAM_TIMEOUT_MS = 5000;
const TCP_IDLE_TIMEOUT_MS = 6000;
const ANSWER_TTL = 120;
// Short ceiling on avahi DBus calls. Avahi's internal mDNS lookup for a
// record nobody publishes can block ~5s while it waits for responses on
// the LAN — which stalls container apps. mDNS on the wire conventionally
// uses short timeouts (~500ms-1s) because responders only reply if they
// have the record. 1500ms approximates that bound.
const AVAHI_LOOKUP_TIMEOUT_MS = 1500;

const QTYPE_A = 1;
const QTYPE_PTR = 12;
const QTYPE_AAAA = 28;
const QCLASS_IN = 1;

const RCODE_NOERROR = 0;
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;

const state = {
  udp: null,
  tcp: null,
  /** { address, port } — first IPv4 nameserver from /etc/resolv.conf, or null. */
  upstream: null,
  /** Interface (the containers' bridge) whose addresses answer the host's own name. */
  hostInterface: null,
  logger: null,
};

function logWarn(msg) {
  if (state.logger?.warn) state.logger.warn(`[mdnsForwarder] ${msg}`);
  else console.warn(`[mdnsForwarder] ${msg}`);
}

function logInfo(msg) {
  if (state.logger?.info) state.logger.info(`[mdnsForwarder] ${msg}`);
  else console.info(`[mdnsForwarder] ${msg}`);
}

// ---------------------------------------------------------------------------
// Upstream discovery
// ---------------------------------------------------------------------------

/**
 * First IPv4 `nameserver` line from /etc/resolv.conf. On systemd-resolved
 * hosts that is `127.0.0.53` (resolved's stub, which forwards to the real
 * LAN/ISP DNS — no loop risk, resolved does not forward back to us).
 */
function readUpstreamFromResolvConf() {
  let content;
  try {
    content = readFileSync('/etc/resolv.conf', 'utf8');
  } catch (err) {
    logWarn(`cannot read /etc/resolv.conf: ${err?.message || err}`);
    return null;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = line.match(/^nameserver\s+(\S+)/i);
    if (!m) continue;
    if (m[1].includes(':')) continue; // IPv6 upstreams skipped — UDP relay is v4-only
    return { address: m[1], port: 53 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// DNS packet parse/build (minimal — just enough for A/AAAA/PTR)
// ---------------------------------------------------------------------------

/**
 * Parse header + first question. Returns null for anything we won't handle
 * (malformed, multi-question, compressed name in question — vanishingly rare
 * in practice). Responses we don't build ourselves get relayed raw upstream,
 * so strict parsing here only matters for the `.local` / PTR fast paths.
 */
function parseQuery(buf) {
  if (buf.length < 12) return null;
  const flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // QR set — this is a response, not a query
  const qdcount = buf.readUInt16BE(4);
  if (qdcount !== 1) return null;

  let off = 12;
  const labels = [];
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) { off += 1; break; }
    if ((len & 0xc0) !== 0) return null; // compression pointer — unexpected in question
    if (off + 1 + len > buf.length) return null;
    if (len > 63) return null;
    labels.push(buf.slice(off + 1, off + 1 + len).toString('ascii'));
    off += 1 + len;
  }
  if (off + 4 > buf.length) return null;

  return {
    raw: buf,
    id: buf.readUInt16BE(0),
    qname: labels.join('.').toLowerCase(),
    qtype: buf.readUInt16BE(off),
    qclass: buf.readUInt16BE(off + 2),
    questionEnd: off + 4,
  };
}

/** Header + question echo for a response. RCODE per arg, AN count per arg. */
function buildResponseBase(query, rcode, ancount) {
  const reqFlags = query.raw.readUInt16BE(2);
  const rd = (reqFlags >> 8) & 0x01; // preserve RD bit from query
  // QR=1 | OPCODE=0 | AA=0 | TC=0 | RD=rd | RA=1 | Z=0 | RCODE
  const flags = 0x8000 | (rd << 8) | 0x0080 | (rcode & 0x0f);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(ancount, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = query.raw.slice(12, query.questionEnd);
  return [header, question];
}

function buildNoAnswer(query, rcode) {
  return Buffer.concat(buildResponseBase(query, rcode, 0));
}

/** Encode "foo.bar" as DNS wire labels (no compression). */
function encodeName(fqdn) {
  const parts = String(fqdn).replace(/\.$/, '').split('.').filter(Boolean);
  const chunks = [];
  for (const label of parts) {
    if (label.length > 63) throw new Error('label too long');
    const b = Buffer.alloc(label.length + 1);
    b[0] = label.length;
    b.write(label, 1, 'ascii');
    chunks.push(b);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function encodeIPv4(ip) {
  const parts = String(ip).split('.').map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return Buffer.from(parts);
}

/** Encode an IPv6 text address to 16 bytes. Accepts `::` shorthand. */
function encodeIPv6(ip) {
  const s = String(ip);
  let groups;
  if (s.includes('::')) {
    const [l, r] = s.split('::');
    const left = l ? l.split(':') : [];
    const right = r ? r.split(':') : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    groups = s.split(':');
  }
  if (groups.length !== 8) return null;
  const buf = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const h = parseInt(groups[i], 16);
    if (Number.isNaN(h) || h < 0 || h > 0xffff) return null;
    buf.writeUInt16BE(h, i * 2);
  }
  return buf;
}

/**
 * Build a response with one answer RR per rdata, each owner name a
 * compression pointer to the question section (offset 12) so we don't
 * re-encode the name.
 */
function buildAnswers(query, type, rdatas) {
  const rrs = rdatas.map((rdata) => {
    const namePtr = Buffer.from([0xc0, 0x0c]);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(type, 0);
    fixed.writeUInt16BE(QCLASS_IN, 2);
    fixed.writeUInt32BE(ANSWER_TTL, 4);
    fixed.writeUInt16BE(rdata.length, 8);
    return Buffer.concat([namePtr, fixed, rdata]);
  });
  const [header, question] = buildResponseBase(query, RCODE_NOERROR, rrs.length);
  return Buffer.concat([header, question, ...rrs]);
}

function buildAnswer(query, type, rdata) {
  return buildAnswers(query, type, [rdata]);
}

// ---------------------------------------------------------------------------
// Address classification + the host's own addresses
// ---------------------------------------------------------------------------

/**
 * Link-local: 169.254.0.0/16 (IPv4) or fe80::/10 (IPv6). Useless to a
 * container — an IPv6 link-local needs a zone index a DNS answer can't carry,
 * and it names an address on whichever link the publisher saw (avahi
 * publishes the host on every veth/vnet), not the container's own link.
 */
function isLinkLocal(address) {
  const a = String(address).toLowerCase();
  if (a.includes(':')) return /^fe[89ab][0-9a-f]:/.test(a);
  return a.startsWith('169.254.');
}

/** Routable IPv6 for a container: global unicast (2000::/3) or ULA (fc00::/7). */
function isRoutableIPv6(address) {
  // node prints the first group without leading zeros, so a 4-digit first
  // group is what puts the address in 2000::/3 or fc00::/7 ("fc::1" is 00fc::1)
  return /^(?:[23][0-9a-f]{3}|f[cd][0-9a-f]{2}):/i.test(String(address));
}

/**
 * The host's usable addresses of one family on the containers' bridge, read
 * from the kernel at query time (os.networkInterfaces — one getifaddrs call;
 * only queries for the host's own name pay it). Containers reach the host
 * on-link over this bridge, so these are the addresses that work for them;
 * other uplinks (a second NIC, wg0, virbr0) may not be reachable from the
 * container's segment. IPv4: everything except link-local (the wisp-dns0
 * stub lives on its own interface, so it never shows up here). IPv6: global
 * and ULA only. Kernel order is kept; the client applies RFC 6724.
 *
 * @param {'inet'|'inet6'} family
 * @returns {string[]}
 */
function hostBridgeAddresses(family) {
  if (!state.hostInterface) return [];
  const addrs = os.networkInterfaces()[state.hostInterface] || [];
  const wanted = family === 'inet' ? 'IPv4' : 'IPv6';
  return addrs
    .filter((a) => a.family === wanted && !a.internal && !isLinkLocal(a.address))
    .filter((a) => family === 'inet' || isRoutableIPv6(a.address))
    .map((a) => a.address);
}

// ---------------------------------------------------------------------------
// Reverse-name helpers
// ---------------------------------------------------------------------------

function ptrNameToIPv4(qname) {
  const m = qname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\.in-addr\.arpa$/);
  if (!m) return null;
  return `${m[4]}.${m[3]}.${m[2]}.${m[1]}`;
}

function ptrNameToIPv6(qname) {
  const m = qname.match(/^((?:[0-9a-f]\.){32})ip6\.arpa$/);
  if (!m) return null;
  const nibbles = m[1].split('.').filter(Boolean).reverse();
  if (nibbles.length !== 32) return null;
  const hex = nibbles.join('');
  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(hex.slice(i * 4, i * 4 + 4));
  return groups.join(':');
}

// ---------------------------------------------------------------------------
// Query dispatch
// ---------------------------------------------------------------------------

/**
 * Produce the raw DNS response bytes for a query, or null to drop (malformed).
 * Never throws — upstream/avahi failures become SERVFAIL/NXDOMAIN responses.
 * `transport` is the one the query arrived on; relayed queries go upstream
 * over the same one (a TCP query is usually a retry after a truncated UDP
 * answer — relaying it over UDP would just truncate again).
 *
 * Exported for harness-driven verification: the sockets bind an address that
 * exists only on the Linux host, and the project has no test suite.
 *
 * @param {Buffer} packet
 * @param {'udp'|'tcp'} transport
 */
export async function answerQuery(packet, transport) {
  const q = parseQuery(packet);
  if (!q) return null;

  if (q.qclass !== QCLASS_IN) return buildNoAnswer(q, RCODE_NXDOMAIN);

  const isLocalForward = q.qname === 'local' || q.qname.endsWith('.local');
  const isReverseV4 = q.qname.endsWith('.in-addr.arpa');
  const isReverseV6 = q.qname.endsWith('.ip6.arpa');

  if (isLocalForward && (q.qtype === QTYPE_A || q.qtype === QTYPE_AAAA)) {
    const wantedFamily = q.qtype === QTYPE_A ? 'inet' : 'inet6';

    // Fast path: the name is published by this Wisp instance. We know exactly
    // what families we registered, so no avahi round-trip is needed — and
    // crucially, family-specific avahi queries for a record we *didn't*
    // publish (e.g. AAAA on a v4-only Wisp container) trigger a ~5s mDNS
    // multicast wait inside avahi that stalls the caller.
    const local = lookupLocalEntry(q.qname);
    if (local) {
      const address = wantedFamily === 'inet' ? local.ip4 : local.ip6;
      if (!address) return buildNoAnswer(q, RCODE_NOERROR);
      const rdata = q.qtype === QTYPE_A ? encodeIPv4(address) : encodeIPv6(address);
      if (!rdata) return buildNoAnswer(q, RCODE_SERVFAIL);
      return buildAnswer(q, q.qtype, rdata);
    }

    // Host fast path: the host's own name (avahi's current one — it follows a
    // conflict rename to `<host>-2`). Answered from the containers' bridge
    // addresses: avahi's slow path both stalled in production (bursts of
    // NODATA past the 1.5 s cap) and answered AAAA with a random veth's
    // fe80:: address. NODATA for a family the bridge has no usable address in.
    if (q.qname === getHostFqdn()) {
      const rdatas = hostBridgeAddresses(wantedFamily)
        .map((a) => (q.qtype === QTYPE_A ? encodeIPv4(a) : encodeIPv6(a)))
        .filter(Boolean);
      if (rdatas.length === 0) return buildNoAnswer(q, RCODE_NOERROR);
      return buildAnswers(q, q.qtype, rdatas);
    }

    // Slow path: LAN peer (not Wisp-published). Ask avahi for the requested
    // family, bounded by our own short timeout so missing records don't stall
    // the client. If the timeout fires, we return NODATA — cannot reliably
    // distinguish "doesn't exist" from "slow mDNS responder" at this layer.
    const result = await withTimeout(
      resolveLocalName(q.qname, wantedFamily),
      AVAHI_LOOKUP_TIMEOUT_MS,
      null,
    );
    if (!result || result.family !== wantedFamily) return buildNoAnswer(q, RCODE_NOERROR);
    // Never hand a container a link-local answer (see isLinkLocal).
    // ResolveHostName yields a single address; when it is link-local the
    // answer is NODATA rather than a second lookup for another one.
    if (isLinkLocal(result.address)) return buildNoAnswer(q, RCODE_NOERROR);
    const rdata = q.qtype === QTYPE_A ? encodeIPv4(result.address) : encodeIPv6(result.address);
    if (!rdata) return buildNoAnswer(q, RCODE_SERVFAIL);
    return buildAnswer(q, q.qtype, rdata);
  }

  if ((isReverseV4 || isReverseV6) && q.qtype === QTYPE_PTR) {
    const ip = isReverseV4 ? ptrNameToIPv4(q.qname) : ptrNameToIPv6(q.qname);
    if (ip) {
      const hostname = await withTimeout(
        resolveLocalAddress(ip),
        AVAHI_LOOKUP_TIMEOUT_MS,
        null,
      );
      if (hostname) {
        try {
          return buildAnswer(q, QTYPE_PTR, encodeName(hostname));
        } catch {
          /* fall through to upstream */
        }
      }
    }
    // No avahi answer — let upstream try (may have a real PTR record).
  }

  if (!state.upstream) return buildNoAnswer(q, RCODE_SERVFAIL);
  try {
    return transport === 'tcp'
      ? await forwardUpstreamTcp(packet)
      : await forwardUpstreamUdp(packet);
  } catch {
    // timeout, refused, reset — the client gets a definite failure instead of
    // waiting out its own timer
    return buildNoAnswer(q, RCODE_SERVFAIL);
  }
}

/**
 * Race `promise` against a timer. If the timer fires first, resolve with
 * `fallback` instead of waiting. The underlying promise is still running
 * and will settle in the background — not a true cancellation, just a
 * bounded wait for the caller.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const timeoutP = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutP,
  ]);
}

/**
 * Relay one query over UDP. The socket is connect()ed to the upstream, so the
 * kernel delivers only datagrams from upstream's address and port — anything
 * else sent to the ephemeral port is dropped, not taken as the answer.
 */
function forwardUpstreamUdp(packet) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed by an error path */ }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
    sock.on('message', (msg) => finish(resolve, msg));
    sock.on('error', (err) => finish(reject, err));
    sock.connect(state.upstream.port, state.upstream.address, (connectErr) => {
      if (connectErr) {
        finish(reject, connectErr);
        return;
      }
      sock.send(packet, (err) => {
        if (err) finish(reject, err);
      });
    });
  });
}

/** Relay one query over TCP (2-byte length framing both ways), one connection per query. */
function forwardUpstreamTcp(packet) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: state.upstream.address, port: state.upstream.port });
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('upstream timeout')), UPSTREAM_TIMEOUT_MS);
    sock.on('error', (err) => finish(reject, err));
    sock.on('close', () => finish(reject, new Error('upstream closed before a full reply')));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length >= 2 + len) finish(resolve, buf.subarray(2, 2 + len));
    });
    sock.on('connect', () => {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(packet.length, 0);
      sock.write(Buffer.concat([prefix, packet]));
    });
  });
}

// ---------------------------------------------------------------------------
// UDP / TCP servers
// ---------------------------------------------------------------------------

function startUdp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      answerQuery(msg, 'udp').then((reply) => {
        if (!reply) return;
        sock.send(reply, rinfo.port, rinfo.address, () => {});
      }).catch((err) => logWarn(`UDP handler error: ${err?.message || err}`));
    });
    sock.on('error', (err) => logWarn(`UDP socket error: ${err?.message || err}`));
    sock.once('listening', () => { state.udp = sock; resolve(); });
    sock.once('error', (err) => reject(err));
    sock.bind(PORT, STUB_IP);
  });
}

function startTcp() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((conn) => handleTcpConnection(conn));
    server.on('error', (err) => logWarn(`TCP server error: ${err?.message || err}`));
    server.once('listening', () => { state.tcp = server; resolve(); });
    server.once('error', (err) => reject(err));
    server.listen(PORT, STUB_IP);
  });
}

function handleTcpConnection(conn) {
  // DNS-over-TCP frames each message with a 2-byte big-endian length prefix.
  let buf = Buffer.alloc(0);
  let expected = -1;
  conn.setTimeout(TCP_IDLE_TIMEOUT_MS, () => conn.destroy());
  conn.on('error', () => conn.destroy());
  conn.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (expected < 0) {
        if (buf.length < 2) break;
        expected = buf.readUInt16BE(0);
        buf = buf.slice(2);
      }
      if (buf.length < expected) break;
      const msg = buf.slice(0, expected);
      buf = buf.slice(expected);
      expected = -1;
      answerQuery(msg, 'tcp').then((reply) => {
        if (!reply) return;
        const len = Buffer.alloc(2);
        len.writeUInt16BE(reply.length, 0);
        conn.write(len);
        conn.write(reply);
      }).catch((err) => logWarn(`TCP handler error: ${err?.message || err}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @param {object|null} logger
 * @param {{ hostInterface?: string|null }} [opts] `hostInterface` — the
 *   containers' bridge; its addresses answer the host's own `.local` name.
 *   Chosen once at boot by the caller: a bridge created later is picked up
 *   on the next wisp restart. Null → the host's name gets NODATA.
 */
export async function startForwarder(logger = null, { hostInterface = null } = {}) {
  if (state.udp || state.tcp) return;
  state.logger = logger;
  state.hostInterface = hostInterface || null;
  state.upstream = readUpstreamFromResolvConf();
  if (!state.upstream) {
    logWarn('no IPv4 nameserver in /etc/resolv.conf; non-.local queries will fail');
  }
  try {
    await startUdp();
    await startTcp();
    logInfo(`listening on ${STUB_IP}:${PORT} (UDP+TCP); upstream=${state.upstream?.address ?? 'none'}; ` +
      `host name answered from ${state.hostInterface ?? 'none'}`);
  } catch (err) {
    const msg = err?.message || String(err);
    if (err?.code === 'EACCES') {
      logWarn(`cannot bind ${STUB_IP}:${PORT} — need CAP_NET_BIND_SERVICE. ` +
        'Check AmbientCapabilities in wisp.service. Container .local resolution will not work.');
    } else if (err?.code === 'EADDRNOTAVAIL') {
      logWarn(`${STUB_IP} is not assigned to any interface. ` +
        'Run scripts/linux/setup/container-dns.sh (holds it on wisp-dns0), then restart wisp.');
    } else {
      logWarn(`failed to start: ${msg}`);
    }
    await stopForwarder();
  }
}

export async function stopForwarder() {
  if (state.udp) { try { state.udp.close(); } catch { /* ignore */ } state.udp = null; }
  if (state.tcp) {
    await new Promise((resolve) => {
      state.tcp.close(() => resolve());
    });
    state.tcp = null;
  }
}
