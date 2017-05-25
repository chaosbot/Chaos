import time
import unittest
from decorator import memoize
from helpers import _time_code_to_seconds, _extract_args


class TestsTimeCode(unittest.TestCase):
    def test_basic(self):
        fn = _time_code_to_seconds
        self.assertEqual(60, fn("1m"))
        self.assertEqual(120, fn("2m"))
        self.assertEqual(37, fn(37))
        self.assertRaises(ValueError, fn, "abc")


class TestExtractArgs(unittest.TestCase):
    def test_basic(self):
        fn = _extract_args
        to_use = fn(["a", "b", "c", "d"], ("default",), [1, 2, 3], {"e": 4},
                    None, None)
        self.assertDictEqual(to_use, {"a": 1, "b": 2, "c": 3, "d": "default",
                                      "e": 4})

    def test_whitelist(self):
        fn = _extract_args
        to_use = fn(["a", "b", "c", "d"], ("default",), [1, 2, 3], {"e": 4},
                    ["b", "c"], None)
        self.assertDictEqual(to_use, {"b": 2, "c": 3})

    def test_blacklist(self):
        fn = _extract_args
        to_use = fn(["a", "b", "c", "d"], ("default",), [1, 2, 3], {"e": 4},
                    None, ["b"])
        self.assertDictEqual(to_use, {"a": 1, "c": 3, "d": "default", "e": 4})


class TestMemoize(unittest.TestCase):
    def setUp(self):
        self.backend = {}
        self.backend_factory = lambda fn: self.backend

    def test_set(self):

        @memoize("1m", backend=self.backend_factory)
        def fn(a, b, c):
            return a + b + c

        # set 1
        now = time.time()
        res = fn(1, 2, 3)
        self.assertEqual(res, 6)

        mkey = '[["a", 1], ["b", 2], ["c", 3]]'
        self.assertIn(mkey, self.backend)
        inserted, mvalue = self.backend[mkey]

        self.assertAlmostEqual(inserted, now, delta=0.1)
        self.assertEqual(mvalue, res)

        # set 2
        now = time.time()
        res = fn(4, 5, 6)
        self.assertEqual(res, 15)

        mkey = '[["a", 4], ["b", 5], ["c", 6]]'
        self.assertIn(mkey, self.backend)
        inserted, mvalue = self.backend[mkey]

        self.assertAlmostEqual(inserted, now, delta=0.1)
        self.assertEqual(mvalue, res)

    def test_get(self):
        state = {"counter": 0}

        @memoize("1m")
        def fn(a, b, c):
            c = state["counter"]
            state["counter"] += 1
            return c

        res = fn(1, 2, 3)
        self.assertEqual(res, 0)
        res = fn(1, 2, 3)
        self.assertEqual(res, 0)

    def test_whitelist(self):
        @memoize("1m", whitelist=("b", "c"))
        def fn(a, b, c):
            return a + b + c

        res = fn(1, 2, 3)
        self.assertEqual(res, 6)
        res = fn(2, 2, 3)
        self.assertEqual(res, 6)
        res = fn(2, 2, 4)
        self.assertEqual(res, 8)

    def test_blacklist(self):
        @memoize("1m", blacklist=("a", "c"))
        def fn(a, b, c):
            return a + b + c

        res = fn(1, 2, 3)
        self.assertEqual(res, 6)
        res = fn(9, 2, 7)
        self.assertEqual(res, 6)
        res = fn(9, 3, 7)
        self.assertEqual(res, 19)

    def test_refresh(self):
        state = {"counter": 0}

        def get_now():
            return time.time() + state["counter"] * 60

        @memoize("30s", backend=self.backend_factory, get_now=get_now)
        def fn(a, b, c):
            c = state["counter"]
            state["counter"] += 1
            return c

        mkey = '[["a", 1], ["b", 2], ["c", 3]]'

        now = time.time()
        res = fn(1, 2, 3)
        self.assertEqual(res, 0)
        self.assertIn(mkey, self.backend)

        inserted, mvalue = self.backend[mkey]
        self.assertEqual(mvalue, res)
        self.assertAlmostEqual(inserted, now, delta=0.1)

        now = time.time()
        res = fn(1, 2, 3)
        self.assertEqual(res, 1)
        self.assertIn(mkey, self.backend)

        inserted, mvalue = self.backend[mkey]
        self.assertEqual(mvalue, res)
        self.assertAlmostEqual(inserted, now + 60, delta=0.1)


if __name__ == "__main__":
    unittest.main()
