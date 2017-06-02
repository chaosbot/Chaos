import unittest
import settings
from math import inf
from github_api import compute_api_cooldown as compute
from github_api import voting


class CooldownTests(unittest.TestCase):
    def test_no_requests(self):
        """ no requests means always sleep to the reset time + padding """
        pad = settings.API_COOLDOWN_RESET_PADDING
        self.assertEqual(60 + pad, compute(0, 60))
        self.assertEqual(61 + pad, compute(0, 61))
        self.assertEqual(62 + pad, compute(0, 62))

        # test a negative remaining as well
        self.assertEqual(60 + pad, compute(-1, 60))

    def test_longer_and_longer(self):
        """ fewer requests = longer wait """
        c1 = compute(5000, 3600)
        c2 = compute(4000, 3600)
        c3 = compute(3000, 3600)
        self.assertLess(c1, c2)
        self.assertLess(c2, c3)

    def test_dynamic_voting_window(self):
        """ test lower and upper bounds of dynamic voting window """

        first_day = 0
        in_2weeks = 14
        in_2month = 60
        far_future = inf  # <- we will never reach this in reality

        # first day starts at the lower bound
        self.assertEqual(voting.dynamic_voting_window(first_day, 0, 10), 0)
        self.assertEqual(voting.dynamic_voting_window(first_day, 10, 10), 10)
        self.assertEqual(voting.dynamic_voting_window(first_day, 10, 20), 10)

        # in 2 weeks should be somewhere in between
        window = voting.dynamic_voting_window(in_2weeks, 0, 10)
        self.assertTrue(window > 1)
        self.assertTrue(window < 9)

        # in 2 month should start reaching upper bound
        # assertAlmostEqual with 0 as a 3rd argument rounds the values
        self.assertAlmostEqual(voting.dynamic_voting_window(in_2month, 0, 10), 10, 0)
        self.assertAlmostEqual(voting.dynamic_voting_window(in_2month, 10, 10), 10, 0)
        self.assertAlmostEqual(voting.dynamic_voting_window(in_2month, 10, 20), 20, 0)

        # many days in the future reaches upper bound
        # assertEqual also works here, but why risk?
        self.assertAlmostEqual(voting.dynamic_voting_window(far_future, 0, 10), 10)
        self.assertAlmostEqual(voting.dynamic_voting_window(far_future, 10, 10), 10)
        self.assertAlmostEqual(voting.dynamic_voting_window(far_future, 10, 20), 20)
