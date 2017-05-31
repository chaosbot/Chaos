import unittest
import arrow
from unittest.mock import patch, MagicMock

from github_api import prs, API


def create_mock_pr(number, title, pushed_at):
    return {
        "number": number,
        "title": title,
        "statuses_url": "statuses_url/{}".format(number),
        "head": {
            "repo": {
                "pushed_at": pushed_at
            }
        }
    }


class TestPRMethods(unittest.TestCase):
    def test_statuses_returns_passed_travis_build(self):
        test_data = [[{"state": "success",
                     "context": "continuous-integration/travis-ci/pr"}],
                     [{"state": "success",
                       "context": "continuous-integration/travis-ci/pr"},
                      {"state": "failure",
                       "context": "chaosbot"}],
                     ]
        pr = "/repos/test/blah"

        for statuses in test_data:
            class Mocked(API):
                def __call__(m, method, path, **kwargs):
                    self.assertEqual(pr, path)
                    return statuses

            api = Mocked("user", "pat")
            url = "{}{}".format(api.BASE_URL, pr)

            self.assertTrue(prs.has_build_passed(api, url))

    def test_statuses_returns_failed_travis_build_in_wrong_context(self):
        test_data = [[{"state": "pending",
                       "context": "some_other_context"}],
                     [{"state": "success",
                       "context": "some_other_context"}],
                     [{"state": "error",
                       "context": "some_other_other_context"}],
                     ]
        pr = "/repos/test/blah"

        for statuses in test_data:
            class Mocked(API):
                def __call__(m, method, path, **kwargs):
                    self.assertEqual(pr, path)
                    return statuses

            api = Mocked("user", "pat")
            url = "{}{}".format(api.BASE_URL, pr)

            self.assertFalse(prs.has_build_passed(api, url))

    def test_statuses_returns_failed_travis_build_in_correct_context(self):
        test_data = [[{"state": "error",
                     "context": "continuous-integration/travis-ci/pr"}],
                     [{"state": "pending",
                       "context": "continuous-integration/travis-ci/pr"}],
                     ]
        pr = "/repos/test/blah"

        for statuses in test_data:
            class Mocked(API):
                def __call__(m, method, path, **kwargs):
                    self.assertEqual(pr, path)
                    return statuses

            api = Mocked("user", "pat")
            url = "{}{}".format(api.BASE_URL, pr)

            self.assertFalse(prs.has_build_passed(api, url))

    @patch("arrow.utcnow")
    @patch("github_api.prs.get_is_mergeable")
    @patch("github_api.prs.get_open_prs")
    def test_get_ready_prs(self, mock_get_open_prs, mock_get_is_mergeable, mock_utcnow):
        mock_get_open_prs.return_value = [
            create_mock_pr(10, "WIP", "2017-01-01T00:00:00Z"),
            create_mock_pr(11, "OK", "2017-01-01T00:00:00Z"),
            create_mock_pr(12, "Not in window", "2017-01-01T00:00:10Z"),
            create_mock_pr(13, "Not mergeable", "2017-01-01T00:00:00Z"),
            create_mock_pr(14, "Stale", "2016-01-01T00:00:00Z")
        ]

        def get_is_mergeable_side_effect(api, urn, pr_num):
            return False if pr_num in [13, 14] else True

        mock_get_is_mergeable.side_effect = get_is_mergeable_side_effect
        mock_utcnow.return_value = arrow.get("2017-01-01T00:00:10Z")
        api = MagicMock()
        api.BASE_URL = "api_base_url"
        ready_prs = prs.get_ready_prs(api, "urn", 5)
        ready_prs_list = [pr for pr in ready_prs]
        self.assertTrue(len(ready_prs_list) is 1)
        self.assertTrue(ready_prs_list[0].get("number") is 11)
