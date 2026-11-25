# Certificates

Wisp gets one TLS certificate for the host's domain from Let's
Encrypt, by the DNS challenge through Cloudflare, keeps it renewed, and hands it to the
app containers that serve HTTPS. The Caddy app is the one that uses it today
([CUSTOM-APPS.md](CUSTOM-APPS.md#app-caddy-reverse-proxy)).

## Principles

- **Wisp gets the certificate; an app only loads it.** A stock image is enough, and the
  DNS provider's token never enters a container.
- **One certificate per host**, for `<domain>` and `*.<domain>`. Every app that uses it
  serves names under that one domain.
- **No ACME library** ([TECH-STACK.md](../TECH-STACK.md)): the client is Wisp's own, on
  Node's `crypto`, the signing request included: Node has no API for one, so Wisp
  encodes its one fixed shape itself, and the key never leaves the process. It follows the standard (RFC 8555), never what Let's Encrypt happens to
  do today: it reads each order's and authorization's status and waits on it, takes the
  URLs the directory gives, and hands on the chain exactly as delivered.
- **Nothing depends on a fixed lifetime.** Every date Wisp acts on is computed from the
  certificate it holds.

## The certificate setting

Two values, in the settings record (`certificate` in
[`wisp-config.json`](CONFIGURATION.md#application-config-configwisp-configjson)), edited
in **Host → App Config → Certificate**:

| Field | Description |
|-------|-------------|
| `domain` | The name the certificate is for: lowercase DNS labels, no scheme, no wildcard, no trailing dot. It may be a whole Cloudflare zone (`example.com`) or a name inside one (`home.example.com`). |
| `cloudflareApiToken` | A Cloudflare API token that can read the zone and edit its DNS records. Write-only: the API returns only whether one is stored, and a save that omits or blanks it keeps the stored one. |

**A save is checked before anything is stored.** The domain's form first (**422**
`INVALID_SETTINGS`). Then Wisp asks Cloudflare, with the token, for the zone that holds
the domain: the domain itself or its nearest parent that is a zone.

- Cloudflare refuses the token → **422** `CERTIFICATE_TOKEN_REJECTED`.
- The token sees no zone that holds the domain → **422** `CERTIFICATE_ZONE_NOT_FOUND`.
- Cloudflare cannot be reached → **502** `CERTIFICATE_DNS_UNAVAILABLE`.

Let's Encrypt is not contacted by a save that fails here. The check does not prove the
token may edit records: a token that can only read fails the job, with Cloudflare's
message.

**What a save starts.** A save starts the [job](#the-job) whenever Wisp holds no
certificate for the saved domain: the first save, a changed domain, and a token
corrected after an attempt that failed. A save that changes only the token while Wisp
holds the domain's certificate stores it and starts nothing.

**After a domain change the old certificate keeps serving** until the new one is issued:
the apps serve under the domain of the certificate Wisp holds, not the one asked for.

**Removing the setting** deletes the token, the certificate and its key, and
[delivers](#delivery) that: the apps then serve no HTTPS site. The Let's Encrypt account
is kept. Nothing is revoked.

## The job

Getting a certificate is one job kind, `certificate-issue`, for the first certificate and
for every renewal ([API.md → Background jobs](API.md#background-jobs)). It has no subject.
It is shared: a start while one runs answers that job. It is interruptible: a shutdown
cuts it, and the [check](#renewal) at the next start runs it again when it is still due
(no certificate for the domain, past two thirds, or a failed last attempt). A cut
**Renew now** on a certificate that is not due is not run again.

What it does, each a `step` of its progress:

1. `account`: registers an account with the certificate authority, the first time only.
2. `order`: orders a certificate for `<domain>` and `*.<domain>`.
3. `dns`: writes the challenge's TXT records at `_acme-challenge.<domain>` through the
   Cloudflare API, and waits until the zone's own name servers answer with them.
4. `validate`: asks the authority to check them, and waits for its answer.
5. `finalize`: sends the signing request for a new key, waits for the order, and
   downloads the chain.
6. `deliver`: stores the certificate and [delivers](#delivery) it.

- **Keys** are ECDSA P-256: the account's, kept for good, and the certificate's, new with
  every certificate.
- **The TXT records are removed when the job ends, however it ends.** Records a cut job
  left behind are removed by the next job. Wisp removes only records it wrote.
- **`done` result:** `{ domain, validUntil }`.
- **A failure** is the job's `error`, code `CERTIFICATE_ISSUE_FAILED`, its detail the step
  and the authority's or Cloudflare's own message. The certificate Wisp already holds, if
  any, is untouched and keeps serving.

## Renewal

- **A check runs at every start and once an hour**, like Wisp's other checks. It starts the job when Wisp holds no
  certificate for the stored domain (a first attempt that failed, a domain change), or
  when the certificate it holds is past **two thirds of its own lifetime**
  (`renewAt` = `validFrom` + ⅔ × (`validUntil` − `validFrom`)).
- **A failed attempt is tried again by the next check**, an hour later. Until one succeeds the host is
  flagged: `certificateFailed` in the [`stats`](API.md#stats-topic-payload) topic, shown
  as the Host row's badge ([UI-HOST.md](UI-HOST.md)). With renewal at two thirds, a
  third of the lifetime is left to notice it.
- **Renew now** starts the same job whatever the dates say.
- The check also [delivers](#delivery) to any app container whose files are not the
  certificate Wisp holds. It compares the files themselves, so it needs no memory of
  what was renewed or who missed it.

## Delivery

An app that uses the certificate gets the chain and the key as file mounts, the key a
[secret file mount](CONTAINERS.md#secret-file-mounts). Delivery is that app's config
save ([CUSTOM-APPS.md → Live Reload](CUSTOM-APPS.md#live-reload)), run by Wisp:

- **When:** at the end of every job that got a certificate, when the setting is removed,
  on every save of the app's own config, and by the hourly check for a container whose
  files differ from what Wisp holds (one that was busy at the time, or was restored from
  a backup).
- **A running container** reloads and serves the new certificate without a restart. One
  that cannot take the change by reload is flagged restart required, as after any app
  save.
- **A delivery that fails is not the job's failure.** The job is done once the
  certificate is stored; a container whose save then fails is logged, and the next check
  delivers to it again, since its files still differ.
- **A container whose [operation lock](CONTAINERS.md#per-container-operation-lock) is
  held** (a backup running, say) is skipped, and the next check, within the hour,
  delivers to it. A renewed certificate loses nothing by that: the one the container
  still serves is valid for a third of its lifetime more.

## The record

What the pages read: `GET /api/settings/certificate` ([API-HOST.md](API-HOST.md#certificate)),
announced as `{ kind: "certificate" }` on the [`changes`](API.md#changes-topic-payload)
topic whenever the setting is saved or removed or an attempt ends.

```json
{
  "domain": "home.example.com",
  "tokenSet": true,
  "certificate": {
    "domain": "home.example.com",
    "validFrom": "2026-11-25T10:00:00.000Z",
    "validUntil": "2027-02-23T10:00:00.000Z",
    "renewAt": "2027-01-24T10:00:00.000Z"
  },
  "lastAttempt": { "at": "2026-11-25T10:01:12.000Z", "error": null }
}
```

- `domain` and `tokenSet` are the setting; `domain` is `null` when there is none.
- `certificate` is the one Wisp holds, `null` when it holds none. Its `domain` differs
  from the setting's between a domain change and the new certificate.
- `lastAttempt` is the last job's end: `error` is `null` after a success, the
  [error body](ERROR-HANDLING.md#the-error-body) after a failure. `null` before any
  attempt.
- No field carries a secret.

## Where it is stored

- The setting: `certificate` in `wisp-config.json`.
- Everything Wisp obtained: `config/certificate.json`, mode `0600`, one record written
  atomically: the account's key and URL, the chain and its key, the dates, the last
  attempt, and the TXT records still to remove. An install and an update keep it
  ([UPDATES.md](UPDATES.md), the keep rule). It is read strictly at the start, like the
  settings ([CONFIGURATION.md → Strict reading](CONFIGURATION.md#strict-reading)): a
  file that is not what Wisp writes stops the start, naming the file and the key.
- An app container's copy is in its own files, like any file mount, so a container backup
  holds the certificate's key.

## The certificate authority

Let's Encrypt's production directory. `WISP_ACME_DIRECTORY` in
[`runtime.env`](CONFIGURATION.md#optional-configruntimeenv) names another directory, for
development and tests: Let's Encrypt's staging directory issues certificates no browser
trusts, at far higher rate limits. The account belongs to its directory: under another
directory Wisp registers a new one.

Every request, to the directory and the URLs it names and to Cloudflare's API, goes
through the SSRF-guarded fetch ([CODING-RULES.md](../CODING-RULES.md) §9). The token
travels in the `Authorization` header only.

## Not supported

- A DNS provider other than Cloudflare, or a challenge other than DNS.
- More than one domain per host.
- A certificate authority that needs an account made beforehand.
- Revoking a certificate.
- HTTPS on Wisp's own port: Wisp is reached over HTTPS as a site of the Caddy app
  ([CONFIGURATION.md](CONFIGURATION.md#reverse-proxy--https-trustedproxies)).
