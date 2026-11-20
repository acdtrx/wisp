"""What the kernel says of a link, read for the network plan (bridge-plan.sh);
run with lib.sh's SETUP_PYTHON.

  link.py permaddr
      reads `ip -j -d link show dev <link>` on stdin; prints the link's
      permanent hardware address when it differs from its current one (ip
      names it then only), else nothing
  link.py kind
      reads the same; prints the link's kind (dummy, bridge, …), empty for a
      physical one
"""
import json
import sys


def permaddr():
    print(json.load(sys.stdin)[0].get('permaddr', '').lower())


def kind():
    print((json.load(sys.stdin)[0].get('linkinfo') or {}).get('info_kind', ''))


COMMANDS = {'permaddr': permaddr, 'kind': kind}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
