# The host's certificate

Agreed with the user on 2026-11-25, as the first step of making Wisp work out of the
box.

## What it is for

The Caddy app gets its wildcard certificate by the Cloudflare DNS challenge, which needs
a Caddy image with the `caddy-dns/cloudflare` module. The stock image does not have it,
so a user has to build an image and host it somewhere before anything on the host can be
served over HTTPS, and a registry to host it in wants HTTPS first.

With this feature Wisp gets the certificate itself, from a domain and a Cloudflare token
entered once in Host → App Config, and hands it to a stock `caddy:latest`. HTTPS for a
domain is then two fields and a Caddy app container.

## The specs it adds or changes

Written by the design session with this file, and agreed with it:

- **New:** `specs/CERTIFICATES.md`, the whole contract: the setting, the job, renewal,
  delivery, the record, storage.
- `specs/CUSTOM-APPS.md`: the Caddy app (its `appConfig` is `hosts` only; the `tls-`
  mounts; containers made before this feature), the module interface's "host's
  certificate" part, Caddy's published links.
- `specs/API-HOST.md` (Certificate routes), `specs/API.md` (the `certificate-issue` job
  kind, interruptible; the `certificate` change kind; `certificateFailed` in `stats`).
- `specs/SETTINGS.md`, `specs/CONFIGURATION.md` (`certificate`, `certificate.json`,
  `WISP_ACME_DIRECTORY`).
- `specs/UI-HOST.md` (the Certificate group, the App Config tab's dot), `specs/UI.md`
  (the Host row's badge), `specs/UI-CONTAINER.md` (Caddy's Certificate card; Use the
  app's image).
- `specs/MCP.md` (`certificate` in the overview; Caddy's row of agent-writable fields).
- `specs/UPDATES.md` (migration `0017`), `ARCHITECTURE.md` (the `certificates` and
  `outbound` subsystems, `certificate.json`, the token among the secrets),
  `TECH-STACK.md` (no ACME library; `lib/outbound`), `CODING-RULES.md` §7 and §9
  (`lib/outbound` as the home of outbound HTTP).

The builder edits none of these. It reports each sentence its work makes untrue, with
file and line.

**The one exception: `specs/ERROR-HANDLING.md`.** `npm run check` holds its code table in
step with the code, so these rows, agreed here, are added by the builder in the commit
that first throws each code:

| Code | Status | Meaning |
|------|--------|---------|
| `CERTIFICATE_NOT_FOUND` | 404 | The host has no certificate setting to renew |
| `CERTIFICATE_TOKEN_REJECTED` | 422 | Cloudflare refused the API token of the certificate setting |
| `CERTIFICATE_ZONE_NOT_FOUND` | 422 | The token sees no Cloudflare zone that holds the certificate's domain |
| `CERTIFICATE_DNS_UNAVAILABLE` | 502 | Cloudflare could not be asked about the certificate's domain |
| `CERTIFICATE_ISSUE_FAILED` | 502 | The certificate job failed; the detail names the step and carries the certificate authority's or Cloudflare's message. A job's error only |

## Decisions

- **The Caddy app always uses the host's certificate.** There is no choice between it and
  Caddy's own DNS challenge, and no second path kept for custom images: a user who wants
  Caddy to manage its certificates ejects the app.
- **One certificate per host.** Every Caddy container on a host serves under the same
  domain.
- **No email.** The certificate authority's account is registered without a contact.
- **The certificate routes are `admin`**, like the storage mounts with their passwords.
- **The client is Wisp's own**, with no package (`TECH-STACK.md`). It is written to
  RFC 8555: it polls statuses, retries a `badNonce`, honours `Retry-After`, and never
  relies on a step being instant.
- **The signing request is built in Node**, by Wisp's own encoding of its one fixed
  shape, signed with Node's `crypto`: no exec, no temporary file. The unit tests check
  the request with `openssl`.
- **Outbound HTTP has a module named for it.** The two fetches move from
  `lib/downloads` to `lib/outbound`, which holds nothing else; `lib/downloads` keeps the
  image downloads, built on it. The requests that speak the certificate authority's and
  Cloudflare's APIs live in `lib/certificates`, through the SSRF-guarded fetch. If that
  fetch cannot yet send what the two APIs need (a `POST` with a body and headers,
  reading response headers), the builder extends it, and says so in its report.
- **Waiting for the TXT records** asks the zone's own name servers, with Node's DNS
  resolver. That is DNS, not HTTP, and stays inside the `certificates` module.
- **Wisp never changes an existing Caddy container's image.** The image it has serves
  Wisp's certificate too. Every app container's Image group gets **Use the app's
  image**, which sets the app's default image when the container's is another: the way
  to the stock Caddy, and the way back for anyone who changed an app's image and no
  longer knows what it was.
- **The domain may sit inside a zone** (`home.example.com` in the zone `example.com`):
  the zone is found by walking up the name.

## Constraints

- Built on its own branch, in a worktree.
- **The first commit moves the two fetches to `lib/outbound`** and changes nothing
  else: the importers, the fence check and its tests follow, `npm run check` passes,
  and `BACKLOG.md`'s entry that names the old file's path is brought up to date.
- `README.md`'s line on the Caddy app is rewritten to what the feature does. The
  changelog entry says that existing Caddy containers move to Wisp's certificate, need
  one restart, and can be moved to the stock image with Use the app's image.
- `BACKLOG.md` loses "The Caddy app's certificate needs an image the user must build".
- **Verification on the test host** (`CODING-RULES.md` §14) runs against Let's Encrypt's
  staging directory (`WISP_ACME_DIRECTORY`), with the domain `tinipana.trixbits.ro`, a
  name inside the user's Cloudflare zone `trixbits.ro`. The user enters the token in the UI: it never passes through the builder
  or a file of the repo. Throwaway containers only; the host's own workloads are not
  touched.
- No test calls Let's Encrypt or Cloudflare: unit tests stand both in.

## Milestones

### 1. A domain and a token give the host a certificate

Acceptance:

- A save is refused with nothing stored, each by a unit test with Cloudflare stood in: a
  malformed domain (422 `INVALID_SETTINGS`), a token Cloudflare refuses (422
  `CERTIFICATE_TOKEN_REJECTED`), a token that sees no zone holding the domain (422
  `CERTIFICATE_ZONE_NOT_FOUND`), Cloudflare unreachable (502
  `CERTIFICATE_DNS_UNAVAILABLE`). A domain inside a zone finds that zone.
- A unit test, with the certificate authority stood in, shows the client waiting on an
  order that answers `processing` and an authorization that answers `pending`, and
  retrying a `badNonce`.
- On the test host, saving a domain and a token in Host → App Config starts the job, and
  the group then shows the certificate valid until a date. `openssl x509` on the stored
  chain names `<domain>` and `*.<domain>`.
- After the job, ended well or badly, the zone holds no `_acme-challenge` record that
  Wisp wrote.
- With a token that may read the zone but not edit it, the job ends with
  `CERTIFICATE_ISSUE_FAILED` naming the step; the group shows the failure, and the Host
  row and the App Config tab carry their dot.
- The token appears in no API answer and no log line; `wisp-config.json` and
  `certificate.json` are `0600`. A `read` token reads the record and is refused the
  save (403).
- Remove asks first; after it the record holds no domain and no certificate, and
  `certificate.json` holds neither the chain nor its key.

### 2. A stock Caddy serves its sites with it

Acceptance, on the test host unless a unit test is named:

- A new Caddy app container on `caddy:latest`, with one site, answers on its own address
  for `<subdomain>.<domain>` with the certificate Wisp holds (the same serial) and
  proxies to the site's target.
- A Caddy app container made while Wisp holds no certificate stores its sites and serves
  none, and its Certificate card says so. When the certificate arrives, the running
  container serves them without a restart.
- `tls-key` cannot be read through the mount content route (403
  `CONTAINER_MOUNT_SECRET`) and is `0600` on the host; `tls-cert` and the Caddyfile can.
- A Caddy container carried over from the release before, with its own domain and token:
  after the update the certificate setting holds them, its `appConfig` holds `hosts`
  only, and it still serves with its own certificate, after a restart too. After Wisp's
  first delivery it is flagged restart required, with its image unchanged; after the
  restart it serves Wisp's certificate.
- On that container, **Use the app's image** in the Image group names `caddy:latest`
  and saves it; after a restart the container serves Wisp's certificate on the stock
  image. The action is not offered on an app container that already has its app's
  image, nor on a container that is not an app's.
- The migration, by unit tests over stored fixtures: a host that already has a setting
  keeps it; of two Caddy containers the first by name gives its domain and token; both
  lose the four fields.
- What reads the domain: the Home page's tiles for the sites are under the
  certificate's domain, with none while Wisp holds no certificate (a unit test); MCP's
  `get_deployment_overview` carries `certificate`, and `update_app_config` takes `hosts`
  and refuses `domain`.
- Removing the setting stops a running Caddy container serving its sites.

### 3. The certificate renews itself

Acceptance:

- The check's decision, by unit tests on certificates of 90 and of 6 days: nothing before
  two thirds of the lifetime, the job after it, the job when Wisp holds no certificate
  for the stored domain.
- The check runs at the start and once an hour, and each run logs what triggered it and
  what it did.
- On the test host, **Renew now** gets a certificate with another serial, and a running
  Caddy container serves that serial without a restart.
- A renewal that fails leaves the old certificate serving, sets `certificateFailed` and
  the two dots, and shows its message in the group. The next attempt that succeeds
  clears them.
- A Caddy container restored from a backup taken before a renewal serves the current
  certificate after the next check.
- A job cut by a shutdown ends `cancelled`; the next start runs it again, and the records
  the cut job left in the zone are removed (a unit test for the leftover records).

## Not in this feature

- Other DNS providers, other certificate authorities, more than one domain.
- HTTPS on Wisp's own port.
- The `agent` token scope, image upload and the CLI: features of their own, after this
  one.
