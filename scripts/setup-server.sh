#!/usr/bin/env bash
# Delegates to Linux server setup. Stable entry path: ./scripts/setup-server.sh
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/linux/setup-server.sh" "$@"
