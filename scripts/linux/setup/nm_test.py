"""nm.py's reading of nmcli's terse output and of NetworkManager's settings,
without a host: run by `npm run check` (python3 -m unittest)."""
import json
import os
import subprocess
import sys
import unittest

NM = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nm.py')


class Rows(unittest.TestCase):
    def test_escaped_colons_and_backslashes_stay_in_their_field(self):
        r = subprocess.run([sys.executable, '-I', NM, 'rows'], input='u1:Office\\: dock:802-3-ethernet:/etc/a\\\\b\nu2:plain:vlan:\n',
                           capture_output=True, text=True, check=True)
        self.assertEqual(r.stdout, 'u1\tOffice: dock\t802-3-ethernet\t/etc/a\\b\nu2\tplain\tvlan\t\n')



UPLINK, UUID, MAC = 'eth0', '0b5d6a4e-0000-4000-8000-000000000001', '52:54:00:12:34:56'
MAC_BYTES = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56]


PERM = '52:54:00:ab:cd:ef'
PERM_BYTES = [0x52, 0x54, 0x00, 0xab, 0xcd, 0xef]


def other(settings, permaddr=''):
    """nm.py other on one connection's settings, as busctl prints GetSettings."""
    wrapped = {name: {k: {'type': 'x', 'data': v} for k, v in props.items()} for name, props in settings.items()}
    r = subprocess.run([sys.executable, '-I', NM, 'other', UPLINK, UUID, MAC, permaddr],
                       input=json.dumps({'type': 'a{sa{sv}}', 'data': [wrapped]}), capture_output=True, text=True, check=True)
    return r.stdout.strip()


class Other(unittest.TestCase):
    def test_a_parent_naming_the_uplink_or_its_connection_hangs_off_it_whatever_the_type(self):
        for kind in ('vlan', 'macvlan', 'vxlan', 'ip-tunnel', 'macsec', 'ipvlan'):
            for parent in (UPLINK, UUID):
                with self.subTest(kind=kind, parent=parent):
                    self.assertEqual(other({'connection': {'type': kind}, kind: {'parent': parent}}),
                                     f'dependent {kind}.parent')

    def test_an_hsr_port_on_the_uplink_hangs_off_it(self):
        self.assertEqual(other({'connection': {'type': 'hsr'}, 'hsr': {'port1': 'eth1', 'port2': UPLINK}}),
                         'dependent hsr.port2')

    def test_a_virtual_link_bound_to_the_uplinks_hardware_address_hangs_off_it(self):
        self.assertEqual(other({'connection': {'type': 'vlan'}, 'vlan': {'id': 10},
                                '802-3-ethernet': {'mac-address': MAC_BYTES}}),
                         'dependent 802-3-ethernet.mac-address')

    def test_a_connection_of_another_type_bound_to_the_uplink_by_name_hangs_off_it(self):
        self.assertEqual(other({'connection': {'type': 'pppoe', 'interface-name': UPLINK}, 'pppoe': {'username': 'u'}}),
                         'dependent connection.interface-name')

    def test_a_link_on_another_device_is_none_of_the_uplinks(self):
        self.assertEqual(other({'connection': {'type': 'vlan'}, 'vlan': {'parent': 'eth1', 'id': 10}}), '')
        self.assertEqual(other({'connection': {'type': 'dummy', 'interface-name': 'wisp-dns0'}}), '')

    def test_an_unbound_ethernet_connection_could_take_the_uplink(self):
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}}), 'taker')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet', 'interface-name': UPLINK}}), 'taker')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}, 'match': {'interface-name': ['eth*']}}), 'taker')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}, 'match': {'interface-name': ['eth1', UPLINK]}}),
                         'taker')

    def test_a_connection_bound_to_the_uplinks_permanent_address_is_seen_when_the_current_one_is_cloned(self):
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}, '802-3-ethernet': {'mac-address': PERM_BYTES}},
                               PERM), 'taker')
        self.assertEqual(other({'connection': {'type': 'vlan'}, 'vlan': {'id': 10},
                                '802-3-ethernet': {'mac-address': PERM_BYTES}}, PERM),
                         'dependent 802-3-ethernet.mac-address')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}, '802-3-ethernet': {'mac-address': MAC_BYTES}},
                               PERM), 'taker')

    def test_no_permanent_address_matches_no_unbound_hardware_address(self):
        self.assertEqual(other({'connection': {'type': 'vlan'}, 'vlan': {'id': 10}}), '')

    def test_an_ethernet_connection_bound_elsewhere_is_not_a_taker(self):
        self.assertEqual(other({'connection': {'type': '802-3-ethernet', 'interface-name': 'eth1'}}), '')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'},
                                '802-3-ethernet': {'mac-address': [0x52, 0x54, 0, 0, 0, 1]}}), '')
        self.assertEqual(other({'connection': {'type': '802-3-ethernet'}, 'match': {'interface-name': ['eth1', 'eth2']}}), '')


def permaddr(link):
    r = subprocess.run([sys.executable, '-I', NM, 'permaddr'], input=json.dumps([link]),
                       capture_output=True, text=True, check=True)
    return r.stdout.strip()


class Permaddr(unittest.TestCase):
    def test_the_permanent_address_when_it_differs(self):
        self.assertEqual(permaddr({'ifname': UPLINK, 'address': MAC, 'permaddr': '52:54:00:AB:CD:EF'}), PERM)

    def test_nothing_when_ip_names_none(self):
        self.assertEqual(permaddr({'ifname': UPLINK, 'address': MAC}), '')


if __name__ == '__main__':
    unittest.main()
