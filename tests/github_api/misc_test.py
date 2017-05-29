import unittest
import settings
from github_api import compute_api_cooldown as compute


class CooldownTests(unittest.TestCase):
    def test_no_requests(self):
        """ no requests means always sleep to the reset time + padding """
        pad = settings.API_COOLDOWN_RESET_PADDING
        self.assertEqual(60+pad, compute(0, 60))
        self.assertEqual(61+pad, compute(0, 61))
        self.assertEqual(62+pad, compute(0, 62))

        # test a negative remaining as well
        self.assertEqual(60+pad, compute(-1, 60))

    def test_longer_and_longer(self):
        """ fewer requests = longer wait """
        c1 = compute(5000, 3600)
        c2 = compute(4000, 3600)
        c3 = compute(3000, 3600)
        self.assertLess(c1, c2)
        self.assertLess(c2, c3)
