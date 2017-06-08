import unittest
import settings


class TestSettings(unittest.TestCase):
    def test_test(self):
        """ Sorry @paris-ci and @Ayyko """
        self.assertFalse(settings.TEST)
