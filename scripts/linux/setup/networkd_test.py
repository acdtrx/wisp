"""networkd.py's split of the uplink's file, without a host: run by
`npm run check` (python3 -m unittest)."""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


def port(text, uplink='eth0', mac='52:54:00:12:34:56', permaddr=''):
    """networkd.py port on a file holding <text>: (stdout, exit, out files)."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, '10-eth0.network')
        with open(path, 'w') as f:
            f.write(text)
        r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'networkd.py'), 'port', path, uplink, mac, permaddr, d],
                           capture_output=True, text=True, check=False)
        out = {}
        for name in ('bridge.network.body', 'port.link', 'port.match'):
            p = os.path.join(d, name)
            if os.path.exists(p):
                with open(p) as f:
                    out[name] = f.read()
        return r.stdout.strip(), r.returncode, out


class PortSplit(unittest.TestCase):
    def test_two_route_sections_stay_two(self):
        mode, rc, out = port('[Match]\nName=eth0\n\n[Network]\nAddress=192.0.2.5/24\n\n'
                             '[Route]\nGateway=192.0.2.1\n\n[Route]\nDestination=198.51.100.0/24\nGateway=192.0.2.2\n')
        self.assertEqual((mode, rc), ('static', 0))
        self.assertEqual(out['bridge.network.body'],
                         '\n[Network]\nAddress=192.0.2.5/24\n'
                         '\n[Route]\nGateway=192.0.2.1\n'
                         '\n[Route]\nDestination=198.51.100.0/24\nGateway=192.0.2.2\n')

    def test_link_stays_on_the_port_and_online_goes_with_the_address(self):
        mode, rc, out = port('[Match]\nName=eth0\n\n[Link]\nMTUBytes=9000\nRequiredForOnline=routable\n\n'
                             '[Network]\nDHCP=yes\nLLDP=yes\n')
        self.assertEqual((mode, rc), ('dhcp', 0))
        self.assertEqual(out['port.link'], '\n[Link]\nMTUBytes=9000\n\n[Network]\nLLDP=yes\n')
        self.assertEqual(out['bridge.network.body'], '\n[Link]\nRequiredForOnline=routable\n\n[Network]\nDHCP=yes\n')
        self.assertEqual(out['port.match'], 'Name=eth0\n')

    def test_a_match_by_more_than_the_name_is_refused_as_such(self):
        for text in ('[Match]\nName=eth*\n\n[Network]\nDHCP=yes\n',
                     '[Match]\nDriver=e1000\n\n[Network]\nDHCP=yes\n',
                     '[Match]\nMACAddress=52:54:00:12:34:56\n\n[Network]\nDHCP=yes\n'):
            with self.subTest(text=text):
                _, rc, _ = port(text)
                self.assertEqual(rc, 5)

    def test_a_setting_not_carried_is_refused(self):
        _, rc, _ = port('[Match]\nName=eth0\n\n[Network]\nDHCP=yes\nBond=bond0\n')
        self.assertEqual(rc, 3)

    def test_a_link_hanging_off_the_uplink_is_refused_as_such(self):
        for key in ('VLAN', 'MACVLAN', 'IPVLAN', 'VXLAN', 'Tunnel', 'MACsec', 'Xfrm'):
            with self.subTest(key=key):
                _, rc, _ = port(f'[Match]\nName=eth0\n\n[Network]\nDHCP=yes\n{key}=link0\n')
                self.assertEqual(rc, 4)


class HardwareAddress(unittest.TestCase):
    """MACAddress= against the current address, PermanentMACAddress= against the
    permanent one, as networkd matches (a cloned address on the uplink)."""
    CUR, PERM = '52:54:00:12:34:56', '52:54:00:ab:cd:ef'

    def test_the_port_matched_by_its_permanent_address_is_the_uplinks(self):
        _, rc, out = port('[Match]\nName=eth0\nPermanentMACAddress=52:54:00:ab:cd:ef\n\n[Network]\nDHCP=yes\n',
                          mac=self.CUR, permaddr=self.PERM)
        self.assertEqual(rc, 0)
        self.assertIn('PermanentMACAddress=52:54:00:ab:cd:ef', out['port.match'])

    def test_a_permanent_match_on_the_current_address_is_refused(self):
        _, rc, _ = port('[Match]\nName=eth0\nPermanentMACAddress=52:54:00:12:34:56\n\n[Network]\nDHCP=yes\n',
                        mac=self.CUR, permaddr=self.PERM)
        self.assertEqual(rc, 5)

    def test_without_permaddr_the_permanent_address_is_the_current_one(self):
        _, rc, _ = port('[Match]\nName=eth0\nPermanentMACAddress=52:54:00:12:34:56\n\n[Network]\nDHCP=yes\n',
                        mac=self.CUR)
        self.assertEqual(rc, 0)

    def test_a_second_file_taking_the_uplink_by_its_permanent_address(self):
        import contextlib
        import importlib.util
        import io
        spec = importlib.util.spec_from_file_location('networkd', os.path.join(HERE, 'networkd.py'))
        networkd = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(networkd)
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, '05-perm.network'), 'w') as f:
                f.write('[Match]\nPermanentMACAddress=52:54:00:ab:cd:ef\n')
            with open(os.path.join(d, '06-cur-as-perm.network'), 'w') as f:
                f.write('[Match]\nPermanentMACAddress=52:54:00:12:34:56\n')
            networkd.DIRS = (d,)
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                networkd.takers('eth0', self.CUR, self.PERM, '', os.path.join(d, '10-eth0.network'))
        self.assertEqual(buf.getvalue().split(), [os.path.join(d, '05-perm.network')])


if __name__ == '__main__':
    unittest.main()
