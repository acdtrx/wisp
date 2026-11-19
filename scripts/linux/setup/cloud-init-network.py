"""Whether cloud-init's merged configuration switches its networking off, for
net-uplink.sh; run with python3 -I. Prints "off:<file>" for the file whose
`network: {config: disabled}` has the last word, else "managed". The files are
/etc/cloud/cloud.cfg, then cloud.cfg.d/*.cfg in name order, the last word
winning. cloud-init's own runtime, python3 and its yaml module, reads them.
"""
import glob

import yaml

state = "managed"
for path in ["/etc/cloud/cloud.cfg"] + sorted(glob.glob("/etc/cloud/cloud.cfg.d/*.cfg")):
    try:
        doc = yaml.safe_load(open(path)) or {}
    except FileNotFoundError:
        continue
    net = doc.get("network") if isinstance(doc, dict) else None
    if isinstance(net, dict) and "config" in net:
        state = "managed" if net["config"] != "disabled" else "off:" + path
print(state)
