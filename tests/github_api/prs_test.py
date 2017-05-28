import unittest

from github_api import prs, API


class TestPRMethods(unittest.TestCase):
    def test_statuses_returns_passed_travis_build(self):
        statuses = [{"state": "success",
                    "context": "continuous-integration/travis-ci/pr"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertTrue(prs.has_build_passed(api, url))

        # should succeed even if there are other statuses
        statuses = [{"state": "success",
                    "context": "continuous-integration/travis-ci/pr"},
                    {"state": "failure",
                    "context": "chaosbot"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertTrue(prs.has_build_passed(api, url))

    def test_statuses_returns_failed_travis_build(self):

        # should fail because of "error" status
        statuses = [{"state": "error",
                    "context": "continuous-integration/travis-ci/pr"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertFalse(prs.has_build_passed(api, url))

        # should fail because of "pending" status
        statuses = [{"state": "pending",
                    "context": "continuous-integration/travis-ci/pr"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertFalse(prs.has_build_passed(api, url))

        # should fail because of incorrect context
        statuses = [{"state": "pending",
                    "context": "not-so-continuous-integration/travis-ci/pr"}]
        pr = "/repos/test/blah"

        class Mocked(API):
            def __call__(m, method, path, **kwargs):
                self.assertEqual(pr, path)
                return statuses

        api = Mocked("user", "pat")
        url = "{}{}".format(api.BASE_URL, pr)

        self.assertFalse(prs.has_build_passed(api, url))
