/**
 * Certificates module facade: the client of the certificate authority (ACME)
 * and of Cloudflare's DNS API, through lib/outbound. It gets a certificate for
 * a domain and knows nothing of containers or settings
 * (docs/specs/CERTIFICATES.md): the glue keeps what it obtains.
 */
export { findZone } from './cloudflare.js';
export { describeChain, issueCertificate, removeTxtRecords } from './issue.js';
