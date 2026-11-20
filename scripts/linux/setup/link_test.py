"""link.py's reading of `ip -j -d link`, without a host: run by `npm run check`
(python3 -m unittest)."""
import json
import os
import subprocess
import sys
import unittest

LINK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'link.py')
UPLINK = 'eth0'
MAC = '52:54:00:12:34:56'
PERM = '52:54:00:ab:cd:ef'


def permaddr(link):
    r = subprocess.run([sys.executable, '-I', LINK, 'permaddr'], input=json.dumps([link]),
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


class Permaddr(unittest.TestCase):
    def test_the_permanent_address_when_it_differs(self):
        self.assertEqual(permaddr({'ifname': UPLINK, 'address': MAC, 'permaddr': '52:54:00:AB:CD:EF'}), PERM)

    def test_nothing_when_ip_names_none(self):
        self.assertEqual(permaddr({'ifname': UPLINK, 'address': MAC}), '')





def kind(link):
    r = subprocess.run([sys.executable, '-I', LINK, 'kind'], input=json.dumps([link]),
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


class Kind(unittest.TestCase):
    def test_the_kind_ip_names(self):
        self.assertEqual(kind({'ifname': 'wisp-dns0', 'linkinfo': {'info_kind': 'bridge'}}), 'bridge')

    def test_empty_for_a_physical_link(self):
        self.assertEqual(kind({'ifname': UPLINK, 'address': MAC}), '')
