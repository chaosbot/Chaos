import unittest

from github_api import prs, API


class TestPRMethods(unittest.TestCase):
    def test_statuses_returns_passed_travis_build(self):
        statuses = [{"state": "success",
                    "description": "The Travis CI build passed"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertTrue(prs.has_build_passed(api, url))

    def test_statuses_returns_failed_travis_build(self):
        statuses = [{"state": "error",
                    "description": "The Travis CI build failed"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertFalse(prs.has_build_passed(api, url))

        statuses = [{"state": "pending",
                    "description": "The Travis CI build is in progress"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertFalse(prs.has_build_passed(api, url))
