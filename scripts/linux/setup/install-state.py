"""install-state.py server-name <wisp-config.json>: exit 0 when the config
names the server (a non-empty serverName), 1 when it does not, 2 when it is not
JSON; for install-state.sh, run with python3 -I.
"""
import json
import sys

try:
    with open(sys.argv[2]) as f:
        config = json.load(f)
except json.JSONDecodeError as err:
    print(f'ERROR: {sys.argv[2]} is not JSON: {err}', file=sys.stderr)
    sys.exit(2)
name = config.get('serverName') if isinstance(config, dict) else None
sys.exit(0 if isinstance(name, str) and name else 1)
