/**
 * Where a save that renamed workload `name` of `kind` ('vm' or 'container') to `target`
 * goes at its ack: the router's location `pathname` as it is then, under the new name
 * (the tab it shows then kept), or null when it no longer shows that workload's page.
 */
export function renamedPath(pathname, kind, name, target) {
  const page = `/${kind}/${encodeURIComponent(name)}`;
  if (pathname !== page && !pathname.startsWith(`${page}/`)) return null;
  return `/${kind}/${encodeURIComponent(target)}${pathname.slice(page.length)}`;
}

/**
 * Where a workload page goes when its record is gone (`gone`) and the workload it showed,
 * by its `uuid` (the record's, last seen), is in the list under another name: that name,
 * or null — the gone page stays (clients follow a workload by its uuid, settled
 * 2026-11-16).
 */
export function renamedElsewhere({ gone, uuid, name, list }) {
  if (!gone || !uuid || !Array.isArray(list)) return null;
  const match = list.find((w) => w.uuid === uuid);
  return match && match.name !== name ? match.name : null;
}
