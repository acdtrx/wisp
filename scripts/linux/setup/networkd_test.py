"""networkd.py's reading of the .network files that could take the uplink, without a host: run by
`npm run check` (python3 -m unittest)."""
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class HardwareAddress(unittest.TestCase):
    """MACAddress= against the current address, PermanentMACAddress= against the
    permanent one, as networkd matches (a cloned address on the uplink)."""
    CUR, PERM = '52:54:00:12:34:56', '52:54:00:ab:cd:ef'

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
