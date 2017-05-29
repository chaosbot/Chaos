import unittest
import settings
from github_api import compute_api_cooldown as compute
from github_api import voting


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

    def test_dynamic_voting_window(self):
        """ test lower and upper bounds of dynamic voting window """
        self.assertEqual(voting.dynamic_voting_window(0, 0, 10), 0)
        self.assertEqual(voting.dynamic_voting_window(50, 0, 10), 10)

        self.assertEqual(voting.dynamic_voting_window(0, 10, 20), 10)
        self.assertEqual(voting.dynamic_voting_window(50, 10, 20), 20)
