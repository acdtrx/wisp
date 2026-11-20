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


class Defines(unittest.TestCase):
    def defines(self, net, key):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch('sys.stdin', io.StringIO(json.dumps(net))):
            netplan.defines(key)
        return out.getvalue().strip()

    def test_a_bridge_defined_is_named(self):
        net = {'network': {'bridges': {'br0': {'interfaces': ['eth0']}}}}
        self.assertEqual(self.defines(net, 'bridges.br0'), 'bridges.br0')

    def test_a_bridge_not_defined_is_not(self):
        net = {'network': {'version': 2, 'ethernets': {'br0': {'dhcp4': True}}}}
        self.assertEqual(self.defines(net, 'bridges.br0'), '')


def plan_with_edits(definition):
    """netplan.py plan on the uplink's definition: (exit code, what it printed,
    the `netplan set` edits it wrote as {key: value}, with its addresses6 as a
    list)."""
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
        addresses6 = os.path.join(d, 'addresses6')
        if os.path.exists(addresses6):
            with open(addresses6) as f:
                edits['addresses6'] = f.read().split()
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

    def test_the_bridge_names_networkd_its_renderer(self):
        edits = plan_with_edits({'dhcp4': True})[2]
        self.assertEqual(json.loads(edits['bridges.br0'])['renderer'], 'networkd')

    def test_a_renderer_netplan_leaves_out_as_its_default_is_as_setup_wrote_it(self):
        net = {'network': {'ethernets': {'eth0': {'dhcp4': False}},
                           'bridges': {'br0': {'interfaces': ['eth0'], 'macaddress': '52:54:00:12:34:56', 'dhcp4': True}}}}
        want = {'interfaces': ['eth0'], 'macaddress': '52:54:00:12:34:56', 'dhcp4': True, 'renderer': 'networkd'}
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch('sys.stdin', io.StringIO(json.dumps(net))):
            netplan.merged('eth0', 'br0', json.dumps(want))
        self.assertEqual(out.getvalue().strip(), '')

    def test_the_ipv6_addresses_listed_are_kept_in_either_form_as_the_kernel_writes_them(self):
        edits = plan_with_edits({'dhcp4': True, 'addresses': ['192.0.2.5/24', 'FD00:0:0::10/64',
                                                              {'2001:db8::5/64': {'lifetime': 0}}]})[2]
        self.assertEqual(edits['addresses6'], ['fd00::10/64', '2001:db8::5/64'])

    def test_a_definition_listing_no_ipv6_address_keeps_none(self):
        self.assertEqual(plan_with_edits({'dhcp4': True})[2]['addresses6'], [])


# What an uplink holds, as net-state.sh's l3_state prints it.
UPLINK_HELD = [
    'addr4 192.0.2.5/24',
    'addr6 2001:db8:1::77/64',
    'addr6 fd00::10/64',
    'dns 192.0.2.1',
    'route4 192.0.2.0/24 proto kernel scope link src 192.0.2.5',
    'route4 default via 192.0.2.1 proto dhcp src 192.0.2.5 metric 100',
]


class Facts(unittest.TestCase):
    """What the bridge's check compares: the bridge's facts must equal what the
    uplink held, and the port must hold none."""

    def test_a_learned_address_the_definition_does_not_list_is_not_compared(self):
        # 2001:db8:1::77 learned with an infinite lifetime, so no "dynamic";
        # the bridge learns one of its own.
        bridge = [f for f in UPLINK_HELD if '2001:db8:1::77' not in f] + ['addr6 2001:db8:1::99/64']
        for mode in ('dhcp', 'static'):
            self.assertEqual(netplan.facts_of(mode, ['fd00::10/64'], bridge),
                             netplan.facts_of(mode, ['fd00::10/64'], UPLINK_HELD))

    def test_a_listed_address_missing_on_the_bridge_is_a_difference(self):
        bridge = [f for f in UPLINK_HELD if 'fd00::10' not in f]
        for mode in ('dhcp', 'static'):
            self.assertNotEqual(netplan.facts_of(mode, ['fd00::10/64'], bridge),
                                netplan.facts_of(mode, ['fd00::10/64'], UPLINK_HELD))

    def test_a_listed_address_matches_whatever_form_it_is_written_in(self):
        self.assertIn('addr6 fd00::10/64', netplan.facts_of('static', ['fd00:0::10/64'], UPLINK_HELD))

    def test_on_dhcp_the_default_route_is_compared_by_its_gateway(self):
        bridge = [f.replace('metric 100', 'metric 1024') for f in UPLINK_HELD]
        self.assertEqual(netplan.facts_of('dhcp', [], bridge), netplan.facts_of('dhcp', [], UPLINK_HELD))
        self.assertIn('route4 default via 192.0.2.1', netplan.facts_of('dhcp', [], UPLINK_HELD))

    def test_on_a_static_address_every_route_is_compared(self):
        bridge = [f.replace('metric 100', 'metric 1024') for f in UPLINK_HELD]
        self.assertNotEqual(netplan.facts_of('static', [], bridge), netplan.facts_of('static', [], UPLINK_HELD))

    def test_a_port_left_a_learned_address_holds_none_of_it(self):
        self.assertEqual(netplan.facts_of('port', ['fd00::10/64'], ['addr6 2001:db8:1::77/64']), [])

    def test_a_port_holding_a_listed_address_or_a_route_is_named(self):
        self.assertEqual(
            netplan.facts_of('port', ['fd00::10/64'], ['addr6 fd00::10/64', 'route4 default via 192.0.2.1']),
            ['addr6 fd00::10/64', 'route4 default via 192.0.2.1'])


if __name__ == '__main__':
    unittest.main()
