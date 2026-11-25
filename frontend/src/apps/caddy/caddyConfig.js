import { keyTaken, withRow, withoutRow } from '../appConfigRows.js';

/**
 * The Caddy app's config as its groups edit it, pure: its sites (`hosts`), all the
 * config there is. The domain they are under is the host certificate's.
 */

const siteKey = (h) => h.subdomain;

/** The config as the PATCH takes it, from the stored one. */
export function caddySendable(ac = {}) {
  return {
    hosts: (ac.hosts ?? []).filter(Boolean).map((h) => ({ subdomain: h.subdomain ?? '', target: h.target ?? '' })),
  };
}

/* ---- Sites ---- */

export const siteForm = (site) => ({ subdomain: site?.subdomain ?? '', target: site?.target ?? '' });

/** The config with the site opened as `key` (null: a new one) saved as `form`. */
export function withSite(ac, key, form) {
  const base = caddySendable(ac);
  const site = { subdomain: form.subdomain.trim().toLowerCase(), target: form.target.trim() };
  return { ...base, hosts: withRow(base.hosts, siteKey, key, site) };
}

export function withoutSite(ac, key) {
  const base = caddySendable(ac);
  return { ...base, hosts: withoutRow(base.hosts, siteKey, key) };
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Why the site cannot be saved, or null (the server checks the target's shape). */
export function siteProblem(ac, key, form) {
  const sub = form.subdomain.trim().toLowerCase();
  if (!sub) return 'A name is required.';
  if (!LABEL.test(sub)) return 'The name is one DNS label: letters, digits and dashes.';
  if (keyTaken(caddySendable(ac).hosts, siteKey, sub, key)) return `${sub} is a site already.`;
  if (!form.target.trim()) return 'A target is required.';
  if (/[\s{}]/.test(form.target.trim())) return 'The target is host[:port] or scheme://host[:port][/path].';
  return null;
}

/** A site's full name under the certificate's domain, or its name alone while there is none. */
export const siteName = (subdomain, domain) => (domain ? `${subdomain}.${domain}` : subdomain);
