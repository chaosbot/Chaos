import unittest
import arrow
from unittest.mock import patch, MagicMock

from github_api import prs, API


def create_mock_pr(number, title, pushed_at, created_at):
    return {
        "number": number,
        "title": title,
        "statuses_url": "statuses_url/{}".format(number),
        "head": {
            "repo": {
                "pushed_at": pushed_at,
                "name": "test_repo",
            },
            "ref": "test_ref"
        },
        "user": {
            "login": "test_user",
        },
        "created_at": created_at,
    }


def create_mock_events(events):

    def produce_event(event):
        if event[0] == "PushEvent":
            return {
                    "type": "PushEvent",
                    "payload": {
                        "ref": "/ref/heads/%s" % event[1],
                        },
                    "created_at": event[2],
                    }
        else:
            return {"type": event[0]}

    return list(map(produce_event, events))


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

    @patch("github_api.prs.get_events")
    @patch("github_api.prs.get_open_prs")
    @patch("github_api.prs.get_is_mergeable")
    @patch("arrow.utcnow")
    def test_get_ready_prs(self, mock_utcnow, mock_get_is_mergeable,
                           mock_get_open_prs, mock_get_events):
        mock_get_open_prs.return_value = [
            create_mock_pr(10, "WIP", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(11, "OK", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(12, "Not in window", "2017-01-01T00:00:10Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(13, "Not mergeable", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(14, "Stale", "2016-01-01T00:00:00Z", "2017-01-01T00:00:00Z")
        ]

        def get_is_mergeable_side_effect(api, urn, pr_num):
            return False if pr_num in [13, 14] else True

        mock_get_is_mergeable.side_effect = get_is_mergeable_side_effect
        mock_utcnow.return_value = arrow.get("2017-01-01T00:00:10Z")
        mock_get_events.return_value = []
        api = MagicMock()
        api.BASE_URL = "api_base_url"
        ready_prs = prs.get_ready_prs(api, "urn", 5)
        ready_prs_list = [pr for pr in ready_prs]
        self.assertEqual(len(ready_prs_list), 1)
        self.assertEqual(ready_prs_list[0].get("number"), 11)

    @patch("github_api.prs.get_events")
    def test_get_pr_last_updated_with_early_events(self, mock_get_events):
        mock_get_events.return_value = \
            create_mock_events([("PushEvent", "test_ref", "2017-01-01T00:00:10Z"),
                                ("PushEvent", "blah", "2017-01-03T00:00:10Z")])

        api = MagicMock()
        api.BASE_URL = "api_base_url"

        last_updated = prs.get_pr_last_updated(api,
                                               create_mock_pr(10, "OK", "2017-01-05T00:00:00Z",
                                                              "2017-01-02T00:00:00Z"))

        self.assertEqual(last_updated, arrow.get("2017-01-02T00:00:00Z"))

    @patch("github_api.prs.get_events")
    def test_get_pr_last_updated_without_events(self, mock_get_events):
        mock_get_events.return_value = \
                create_mock_events([("PublicEvent",),
                                    ("PushEvent", "blah", "2017-01-03T00:00:10Z")])

        api = MagicMock()
        api.BASE_URL = "api_base_url"

        last_updated = prs.get_pr_last_updated(api,
                                               create_mock_pr(10, "OK", "2017-01-05T00:00:00Z",
                                                              "2017-01-02T00:00:00Z"))

        self.assertEqual(last_updated, arrow.get("2017-01-05T00:00:00Z"))

    @patch("github_api.prs.get_events")
    def test_get_pr_last_updated_with_events(self, mock_get_events):
        mock_get_events.return_value = \
            create_mock_events([("PushEvent", "test_ref", "2017-01-04T00:00:10Z"),
                                ("PushEvent", "blah", "2017-01-03T00:00:10Z")])

        api = MagicMock()
        api.BASE_URL = "api_base_url"

        last_updated = prs.get_pr_last_updated(api,
                                               create_mock_pr(10, "OK", "2017-01-05T00:00:00Z",
                                                              "2017-01-02T00:00:00Z"))

        self.assertEqual(last_updated, arrow.get("2017-01-04T00:00:10Z"))
