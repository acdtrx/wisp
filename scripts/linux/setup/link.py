"""What the kernel says of a link, read for net-uplink.sh; run with python3 -I.

  link.py permaddr
      reads `ip -j -d link show dev <link>` on stdin; prints the link's
      permanent hardware address when it differs from its current one (ip
      names it then only), else nothing
"""
import json
import sys


def permaddr():
    print(json.load(sys.stdin)[0].get('permaddr', '').lower())


COMMANDS = {'permaddr': permaddr}

if __name__ == '__main__':
    COMMANDS[sys.argv[1]](*sys.argv[2:])
