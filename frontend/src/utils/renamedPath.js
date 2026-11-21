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
