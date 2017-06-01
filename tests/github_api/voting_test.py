import unittest
from unittest.mock import patch

import settings
from github_api import voting


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

    @patch("github_api.voting.get_vote_weight")
    def test_get_vote_sum(self, mock_get_vote_weight):
        mock_get_vote_weight.return_value = 1.0

        # controversial example
        mocked_vote_result = {"a": 1, "b": 1, "c": 1, "d": 1, "x": -1, "y": -1, "z": -1}
        expected_vote_sum = (1, 3)
        self.assertEqual(voting.get_vote_sum('fake_api', mocked_vote_result), expected_vote_sum)

        # all positive example
        mocked_vote_result = {"a": 1, "b": 1, "c": 1, "d": 1, "x": 1, "y": 1, "z": 1}
        expected_vote_sum = (7, 0)
        self.assertEqual(voting.get_vote_sum('fake_api', mocked_vote_result), expected_vote_sum)

        # almost all negative example, level of controversy is low
        mocked_vote_result = {"a": 1, "b": -1, "c": -1, "d": -1, "x": -1, "y": -1, "z": -1}
        expected_vote_sum = (-5, 1)
        self.assertEqual(voting.get_vote_sum('fake_api', mocked_vote_result), expected_vote_sum)

        # users without vote_weight don't add to total and variance
        mocked_vote_result = {"a": 1, "b": 0}
        expected_vote_sum = (1, 0)
        self.assertEqual(voting.get_vote_sum('fake_api', mocked_vote_result), expected_vote_sum)
