#!/usr/bin/env python3
"""
Patch /etc/netplan/90-wisp-bridge.yaml in place to declare the link-local
stub IP 169.254.53.53/32 on bridges.br0. Idempotent.

Args:
    sys.argv[1]: path to YAML file
    sys.argv[2]: path to result file (will contain 'yes' if changed, 'no' otherwise)

Exit codes:
    0 — completed cleanly (result file populated)
    2 — structural issue with YAML (caller should leave it alone)
"""
import os
import sys
import yaml

STUB = "169.254.53.53/32"


def main():
    if len(sys.argv) != 3:
        print("usage: bridge-config-patch.py <yaml-path> <result-file>", file=sys.stderr)
        sys.exit(2)

    yaml_path = sys.argv[1]
    result_path = sys.argv[2]

    try:
        with open(yaml_path) as f:
            cfg = yaml.safe_load(f) or {}
    except Exception as e:
        print(f"error: cannot parse YAML: {e}", file=sys.stderr)
        sys.exit(2)

    bridges = (cfg.get("network") or {}).get("bridges") or {}
    br = bridges.get("br0")
    if br is None:
        # Bridge not declared here — nothing for this script to do.
        with open(result_path, "w") as f:
            f.write("no")
        return

    addrs = br.get("addresses")
    if addrs is None:
        addrs = []
        br["addresses"] = addrs
    elif not isinstance(addrs, list):
        print(
            f"error: bridges.br0.addresses is not a list: {type(addrs).__name__}",
            file=sys.stderr,
        )
        sys.exit(2)

    if STUB in addrs:
        with open(result_path, "w") as f:
            f.write("no")
        return

    addrs.append(STUB)

    # Preserve file mode (netplan 0.105+ refuses to read /etc/netplan/*.yaml
    # with permissions broader than 600).
    orig_mode = os.stat(yaml_path).st_mode & 0o777

    with open(yaml_path, "w") as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)

    os.chmod(yaml_path, orig_mode)

    with open(result_path, "w") as f:
        f.write("yes")


if __name__ == "__main__":
    main()
