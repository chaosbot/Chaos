import unittest

from unittest.mock import patch

import settings
from github_api import voting, API, repos


class TestVotingMethods(unittest.TestCase):
    def test_parse_emojis_for_vote(self):
        self.assertEqual(voting.parse_emojis_for_vote(":+1:"), 1)
        self.assertEqual(voting.parse_emojis_for_vote(":-1:"), -1)

        # having both positive and negative emoji in body
        # always results in a positive vote
        self.assertEqual(voting.parse_emojis_for_vote(":hankey::+1:"), 1)
        self.assertEqual(voting.parse_emojis_for_vote(":+1::hankey:"), 1)

    @patch("github_api.repos.get_num_watchers")
    def test_get_approval_threshold(self, mock_get_num_watchers):
        # if the number of watchers is low, threshold defaults to 1
        mock_get_num_watchers.return_value = 0
        self.assertEqual(voting.get_approval_threshold('nobody', 'cares'), 1)
        mock_get_num_watchers.assert_called_with('nobody', 'cares')

        # otherwise
        number_of_wathers = 1000
        mock_get_num_watchers.return_value = number_of_wathers
        expected_threshold = number_of_wathers * settings.MIN_VOTE_WATCHERS
        self.assertEqual(voting.get_approval_threshold('or', 'not'), expected_threshold)
        mock_get_num_watchers.assert_called_with('or', 'not')

    def test_get_collaborators_parses_github_response_correctly(self):
        test_data = [{
            "given": [{
                "login": "dwightschrute"
            }, {
                "login": "jimhalpert"
            }, {
                "login": "michaelscott"
            }
            ],
            "expected": ["dwightschrute", "jimhalpert", "michaelscott"]
        }, {
            "given": [],
            "expected": []
        }, {
            "given": None,
            "expected": []
        }]

        test_path = "{}/collaborators".format(repos.get_path(settings.URN))

        for data in test_data:
            class Mocked(API):
                def __call__(m, method, path, **kwargs):
                    self.assertEqual(test_path, path)
                    self.assertEqual("get", method)
                    return data["given"]

            api = Mocked("user", "pat")

            self.assertEqual(data["expected"], voting.get_collaborators(api, settings.URN))

    @patch("github_api.voting.get_collaborators")
    @patch("github_api.users.get_user")
    def test_get_user_weight_applies_collab_weight(self, mock_get_user, mock_get_collaborators):
        collaborators = ["johndoe", "dwightschrute"]
        mock_get_user.return_value = {'created_at': '2012-10-23T21:35:35Z'}
        mock_get_collaborators.return_value = collaborators

        voters = [{
            "username": "johndoe",
            "expected": 1.5
        }, {
            "username": "dwightschrute",
            "expected": 1.5
        }, {
            "username": "smittyvb",
            "expected": 1.0 / 2.0
        }, {
            "username": "jimhalpert",
            "expected": 1
        }, {
            "username": "michaelscott",
            "expected": 1
        }]

        for v in voters:
            self.assertEqual(v["expected"], voting.get_vote_weight(
                None, v["username"], v["username"] in collaborators))

    @patch("github_api.voting.get_collaborators")
    @patch("github_api.users.get_user")
    def test_get_vote_sum_collab_weight(self, mock_get_user, mock_get_collaborators):
        collaborators = ["johndoe", "dwightschrute"]
        mock_get_user.return_value = {'created_at': '2012-10-23T21:35:35Z'}
        mock_get_collaborators.return_value = collaborators

        # 1.5 + 1 + 1 + -0.5     = 3.0
        # 3.0 - (1 + 1 + 1)      = 0.0
        self.assertEqual((3.0, 0.0), voting.get_vote_sum(None, {
            "johndoe": 1,
            "michaelscott": 1,
            "jimhalpert": 1,
            "smittyvb": -1,
        }))
