"""netplan.py's reading of netplan's merged configuration, without a host: run
by `npm run check` (python3 -m unittest). netplan.py imports yaml, netplan's
runtime, which a machine without netplan may lack: JSON, a subset of YAML,
stands in for it."""
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
import unittest.mock

try:
    import yaml  # noqa: F401
except ImportError:
    sys.modules['yaml'] = types.SimpleNamespace(safe_load=lambda s: json.loads(s if isinstance(s, str) else s.read()))

_spec = importlib.util.spec_from_file_location(
    'setup_netplan', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'netplan.py'))
netplan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(netplan)


class Dependents(unittest.TestCase):
    def test_a_link_to_the_uplink_hangs_off_it_whatever_the_kind(self):
        net = {'version': 2, 'renderer': 'networkd',
               'ethernets': {'eth0': {'dhcp4': True}, 'vf0': {'link': 'eth0'}},
               'vlans': {'eth0.10': {'id': 10, 'link': 'eth0'}},
               'tunnels': {'vx0': {'mode': 'vxlan', 'id': 5, 'link': 'eth0'}}}
        self.assertEqual(netplan.dependents_of(net, 'eth0'), ['ethernets.vf0', 'tunnels.vx0', 'vlans.eth0.10'])

    def test_a_definition_holding_the_uplink_is_named(self):
        net = {'ethernets': {'eth0': {}},
               'bonds': {'bond0': {'interfaces': ['eth0', 'eth1']}},
               'vrfs': {'vrf0': {'table': 10, 'interfaces': ['eth0']}}}
        self.assertEqual(netplan.dependents_of(net, 'eth0'), ['bonds.bond0', 'vrfs.vrf0'])

    def test_links_to_other_devices_are_none_of_the_uplinks(self):
        net = {'ethernets': {'eth0': {'dhcp4': True}, 'eth1': {}},
               'vlans': {'eth1.10': {'id': 10, 'link': 'eth1'}},
               'bridges': {'br1': {'interfaces': ['eth1']}}}
        self.assertEqual(netplan.dependents_of(net, 'eth0'), [])



def plan_with_edits(definition):
    """netplan.py plan on the uplink's definition: (exit code, what it printed,
    the `netplan set` edits it wrote as {key: value})."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'uplink.yaml')
        with open(path, 'w') as f:
            json.dump(definition, f)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                netplan.plan(path, 'eth0', 'eth0', '52:54:00:12:34:56', 'br0', 'mac', '/etc/netplan/50-x.yaml', d, '1500')
                code = 0
            except SystemExit as e:
                code = e.code
        edits = {}
        args = os.path.join(d, 'netplan-set.args')
        if os.path.exists(args):
            with open(args) as f:
                for line in f:
                    key, value = line.rstrip('\n').split('\t', 1)[1].split('=', 1)
                    edits[key] = value
        return code, out.getvalue().strip(), edits


def plan(definition):
    """netplan.py plan on the uplink's definition: (exit code, what it printed)."""
    return plan_with_edits(definition)[:2]


class Plan(unittest.TestCase):
    def test_a_match_beyond_the_uplink_names_the_match_that_lifts_it(self):
        code, why = plan({'match': {'driver': 'e1000'}, 'dhcp4': True})
        self.assertEqual(code, 5)
        self.assertIn('match eth0 alone, by its name', why)

    def test_critical_moves_to_the_bridge(self):
        code, mode, edits = plan_with_edits({'dhcp4': True, 'critical': True})
        self.assertEqual((code, mode), (0, 'dhcp'))
        self.assertEqual(edits['ethernets.eth0.critical'], 'null')
        self.assertIs(json.loads(edits['bridges.br0'])['critical'], True)

    def test_critical_left_on_the_port_is_not_as_setup_wrote_it(self):
        net = {'network': {'ethernets': {'eth0': {'dhcp4': False, 'critical': True}},
                           'bridges': {'br0': {'interfaces': ['eth0'], 'macaddress': '52:54:00:12:34:56',
                                               'dhcp4': True, 'critical': True}}}}
        want = {'interfaces': ['eth0'], 'macaddress': '52:54:00:12:34:56', 'dhcp4': True, 'critical': True}
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch('sys.stdin', io.StringIO(json.dumps(net))):
            netplan.merged('eth0', 'br0', json.dumps(want))
        self.assertEqual(out.getvalue().strip(), 'eth0 still has critical')

    def test_a_key_not_carried_is_refused(self):
        self.assertEqual(plan({'dhcp4': True, 'infiniband-mode': 'datagram'})[0], 3)

    def test_dhcp_is_planned(self):
        self.assertEqual(plan({'dhcp4': True}), (0, 'dhcp'))


if __name__ == '__main__':
    unittest.main()
