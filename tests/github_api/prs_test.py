import unittest
import arrow
from unittest.mock import patch, MagicMock

from github_api import prs


def create_mock_pr(number, title, pushed_at, created_at):
    return {
        "number": number,
        "title": title,
        "statuses_url": "statuses_url/{}".format(number),
        "head": {
            "sha": "sha{}".format(number),
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
    def setUp(self):
        self.api = MagicMock()

    def test_statuses_returns_passed_travis_build(self):

        test_data = [
                     # single successfull run
                     [{"state": "success",
                       "context": "continuous-integration/travis-ci/pr"}],
                     # other contexts don't change result
                     [{"state": "success",
                       "context": "continuous-integration/travis-ci/pr"},
                      {"state": "failure",
                       "context": "chaosbot"}],
                     # no travis - no problems
                     [{"state": "pending",
                       "context": "some_other_context"}]
                     ]

        for statuses in test_data:
            self.api.return_value = {"statuses": statuses}
            self.assertTrue(prs.has_build_passed(self.api, "urn", "ref"))
            self.api.assert_called_once_with("get", "/repos/urn/commits/ref/status")
            self.api.reset_mock()

    def test_statuses_returns_failed_travis_build(self):
        test_data = [
                     # Travis failed
                     [{"state": "failure",
                       "context": "continuous-integration/travis-ci/pr"}],
                     # Travis pending
                     [{"state": "pending",
                       "context": "continuous-integration/travis-ci/pr"}],
                     ]

        for statuses in test_data:
            self.api.return_value = {"statuses": statuses}
            self.assertFalse(prs.has_build_passed(self.api, "urn", "ref"))
            self.api.assert_called_once_with("get", "/repos/urn/commits/ref/status")
            self.api.reset_mock()

    @patch("github_api.prs.has_build_passed")
    @patch("github_api.prs.get_events")
    @patch("github_api.prs.get_open_prs")
    @patch("github_api.prs.get_is_mergeable")
    @patch("arrow.utcnow")
    def test_get_ready_prs(self, mock_utcnow, mock_get_is_mergeable,
                           mock_get_open_prs, mock_get_events, mock_has_build_passed):
        # Title of each PR describes it's state
        mock_get_open_prs.return_value = [
            create_mock_pr(10, "WIP", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(11, "OK", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(12, "Not in window", "2017-01-01T00:00:10Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(13, "Not mergeable", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(14, "Stale", "2016-01-01T00:00:00Z", "2017-01-01T00:00:00Z"),
            create_mock_pr(15, "Build failed", "2017-01-01T00:00:00Z", "2017-01-01T00:00:00Z")
        ]

        master_build_status = True

        def get_is_mergeable_side_effect(api, urn, pr_num):
            return False if pr_num in [13, 14] else True

        def has_build_passed_side_effect(api, urn, ref):
            if ref is "master":
                return master_build_status
            return False if "15" in ref else True

        mock_get_is_mergeable.side_effect = get_is_mergeable_side_effect
        mock_has_build_passed.side_effect = has_build_passed_side_effect
        mock_utcnow.return_value = arrow.get("2017-01-01T00:00:10Z")
        mock_get_events.return_value = []
        api = MagicMock()
        api.BASE_URL = "api_base_url"

        # In this scenario only PR with number 11 should be returned.
        ready_prs = prs.get_ready_prs(api, "urn", 5)
        ready_prs_list = [pr for pr in ready_prs]
        self.assertEqual(len(ready_prs_list), 1)
        self.assertEqual(ready_prs_list[0].get("number"), 11)

        # Test for the case when master branch is failing.
        # PR 15 will be also returned in this case as we don't
        # block PRs if master is also failing
        master_build_status = False
        ready_prs = prs.get_ready_prs(api, "urn", 5)
        ready_prs_list = [pr for pr in ready_prs]
        self.assertTrue(len(ready_prs_list) is 2)
        self.assertTrue(ready_prs_list[0].get("number") is 11)
        self.assertTrue(ready_prs_list[1].get("number") is 15)

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
