#!/usr/bin/env bash
# Setup steps that BOTH the installer and the self-updater run.
#
# Why this exists: the install path (setup-server.sh) and the update path
# (wisp-updater) each named their own steps, and the updater's list was a
# hand-picked subset of the installer's. Two failure modes followed — a step
# added to setup-server.sh silently never reached existing installs, and a step
# added to wisp-updater took effect one release late, because install-helpers.sh
# replaces the running updater by atomic rename so the in-flight process runs to
# completion on its old inode.
#
# Both callers invoke THIS script by path from the install tree, and the updater
# has already swapped that tree to the new release before calling. So a step
# added here reaches installs and updates at the same time, with no lag and no
# wisp-updater change.
#
# What belongs here: steps that are fast, idempotent, and safe to re-run against
# a live system — nothing that can disrupt a running VM or container. Steps with
# a real disruption profile (packages, containerd, libvirt, bridge) stay in
# setup-server.sh until they are audited; see docs/plans/setup-refactor.md.
#
# Exit code is meaningful: non-zero if any step failed. wisp-updater relies on
# that to roll back, while setup-server.sh wraps the call in run_step so the
# install path keeps its existing "warn and continue" leniency.
#
# Usage: common-steps.sh <project-root> <deploy-user>   (must run as root)
set -euo pipefail

PROJECT_ROOT="${1:-}"
DEPLOY_USER="${2:-}"

if [[ -z "$PROJECT_ROOT" || -z "$DEPLOY_USER" ]]; then
  echo "Usage: $0 <project-root> <deploy-user>" >&2
  exit 1
fi

SETUP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Wisp common setup steps ==="
echo ""

# Host DNS wiring for containers: the systemd-networkd drop-in owning the mDNS
# stub IP, plus the resolv.conf bind-mounted into every container on br0.
"$SETUP_DIR/container-dns.sh"
echo ""

# Privileged wisp-* helpers into /usr/local/bin with their sudoers rules. Also
# refreshes wisp-updater itself and wisp-updater.service.
"$SETUP_DIR/install-helpers.sh" "$PROJECT_ROOT" "$DEPLOY_USER"
