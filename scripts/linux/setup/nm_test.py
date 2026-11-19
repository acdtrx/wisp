"""nm.py's reading of nmcli's terse output, without a host: run by
`npm run check` (python3 -m unittest)."""
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


if __name__ == '__main__':
    unittest.main()
