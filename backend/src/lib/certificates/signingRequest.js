/**
 * The certificate signing request (PKCS#10, RFC 2986) for a domain and its
 * wildcard. Node's crypto signs but cannot build one, and the request has one
 * fixed shape, so Wisp encodes it here (DER) and signs it with `crypto.sign`:
 * an empty subject, the key's SubjectPublicKeyInfo as Node exports it, and an
 * extension request holding one subjectAltName with the two DNS names. The
 * names are the request's only identifiers (RFC 8555 §7.4); an empty subject
 * also spares a name longer than a common name may be (64).
 */
import { createPublicKey, sign } from 'node:crypto';

/** A DER length: short form below 128, else long form. */
function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER element: its tag, its length, its content. */
function tlv(tag, ...content) {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const BIT_STRING = 0x03;
/** [0] IMPLICIT, constructed: the request's attributes. */
const ATTRIBUTES = 0xa0;
/** [2] IMPLICIT IA5String: a GeneralName's dNSName. */
const DNS_NAME = 0x82;

/** The object identifiers, encoded. */
const OID_EXTENSION_REQUEST = Buffer.from('06092a864886f70d01090e', 'hex'); // 1.2.840.113549.1.9.14
const OID_SUBJECT_ALT_NAME = Buffer.from('0603551d11', 'hex'); // 2.5.29.17
const OID_ECDSA_WITH_SHA256 = Buffer.from('06082a8648ce3d040302', 'hex'); // 1.2.840.10045.4.3.2

/**
 * The DER request for `<domain>` and `*.<domain>`, signed with `key` (an ECDSA
 * P-256 private KeyObject). `domain` must already be checked: lowercase DNS
 * labels, ASCII only.
 * @returns {Buffer}
 */
export function buildSigningRequest(domain, key) {
  const names = tlv(SEQUENCE, ...[domain, `*.${domain}`].map((name) => tlv(DNS_NAME, Buffer.from(name, 'ascii'))));
  const extensions = tlv(SEQUENCE, tlv(SEQUENCE, OID_SUBJECT_ALT_NAME, tlv(OCTET_STRING, names)));
  const attributes = tlv(ATTRIBUTES, tlv(SEQUENCE, OID_EXTENSION_REQUEST, tlv(SET, extensions)));
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const info = tlv(SEQUENCE, tlv(INTEGER, Buffer.from([0])), tlv(SEQUENCE), spki, attributes);
  // ECDSA's DER signature (`dsaEncoding` defaults to it), as a BIT STRING with no unused bits.
  const signature = sign('sha256', info, key);
  return tlv(SEQUENCE, info, tlv(SEQUENCE, OID_ECDSA_WITH_SHA256), tlv(BIT_STRING, Buffer.from([0]), signature));
}
