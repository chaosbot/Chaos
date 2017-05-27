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
