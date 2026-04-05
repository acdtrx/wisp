#!/usr/bin/env bash
# Delegates to Linux wispctl. Stable entry path: ./scripts/wispctl.sh
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/linux/wispctl.sh" "$@"
