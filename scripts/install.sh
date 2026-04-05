#!/usr/bin/env bash
# Delegates to Linux install implementation. Stable entry path: ./scripts/install.sh
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/linux/install.sh" "$@"
