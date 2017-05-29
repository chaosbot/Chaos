import logging
import arrow
import json
import os
from os.path import join, abspath, dirname

import settings
import github_api as gh

THIS_DIR = dirname(abspath(__file__))
# Hopefully this isn't overwritten on pulls
SAVED_COMMANDS_FILE = join(THIS_DIR, '..', "server/issue_commands_ran.json")
if not os.path.exists(SAVED_COMMANDS_FILE):
    '''
        "comment_ids_ran": [
            {
                "comment_id" : ..,
                "chaos_response_id" : ..
            }
        ]
    '''
    with open(SAVED_COMMANDS_FILE, 'w') as f:
        dummy_data = {"comment_ids_ran": []}
        json.dump(dummy_data, f)

__log = logging.getLogger("chaosbot")

'''
Command Syntax
/vote close closes issue when no nay reactions on this comment are added within voting window
/vote reopen reopens issue when see above ^^^
/vote label=<LABEL_TEXT> adds label when ^^^
/vote remove-label=<LABEL_TEXT> removes label when ^^^
/vote assign=<USER> assigns to user when ^^^
/vote unassign=<USER> unassigns from user when ^^^
'''

COMMAND_LIST = ["/vote"]


def can_run_vote_command(api, votes, comment_id):
    json_data = {}
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        json_data = json.load(f)

    # Already ran this command
    for ids_ran in json_data["comment_ids_ran"]:
        if comment_id == ids_ran["comment_id"]:
            __log.debug("Already ran commmand")
            return False

    # Voting window has passed
    now = arrow.utcnow()
    voting_window = gh.voting.get_initial_voting_window(now)

    voting_window_over = gh.issues.is_issue_comment_in_voting_window(api, settings.URN, comment_id,
                                                                     voting_window)
    if not voting_window_over:  # Still voting
        return False

    # At least one negative vote will cause vote to not pass
    for user, vote in votes.items():
        if vote < 0:
            __log.debug("vote less than one")
            return False

    return True


def update_command_ran(command_id):
    json_data = {}
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        json_data = json.load(f)

    with open(SAVED_COMMANDS_FILE, 'w') as f:
        data = {
            "comment_id": command_id,
            "chaos_response_id": None
        }
        json_data["comment_ids_ran"].append(data)
        json.dump(json_data, f)


def get_command_votes(api, urn, comment_id):
    votes = {}
    for voter, vote in gh.voting.get_comment_reaction_votes(api, urn, comment_id):
        votes[voter] = vote
    return votes


def handle_vote_command(api, command, issue_id, comment_id, votes):
    orig_command = command[:]
    # Check for correct command syntax, ie, subcommands
    log_warning = False
    if len(command):
        sub_command = command.pop(0)
        if sub_command == "close":
            gh.issues.close_issue(api, settings.URN, issue_id)
            gh.comments.leave_issue_closed_comment(api, settings.URN, issue_id)
            update_command_ran(comment_id)
        elif sub_command == "reopen":
            gh.issues.open_issue(api, settings.URN, issue_id)
            gh.comments.leave_issue_reopened_comment(api, settings.URN, issue_id)
            update_command_ran(comment_id)
        else:
            # Implement other commands
            pass
    else:
        log_warning = True

    if log_warning:
        __log.warning("Unknown issue command syntax: /vote {command}".format(command=orig_command))


def handle_comment(api, issue_comment):
    issue_id = issue_comment["issue_id"]
    global_comment_id = issue_comment["global_comment_id"]
    comment_text = issue_comment["comment_text"]

    parsed_comment = list(map(lambda x: x.lower().strip(), comment_text.split(' ')))

    command = parsed_comment.pop(0)
    if command in COMMAND_LIST:
        votes = get_command_votes(api, settings.URN, global_comment_id)
        # We doin stuff boyz
        if can_run_vote_command(api, votes, global_comment_id):
            __log.debug("Handling issue {issue}: comment {comment}".format(issue=issue_id,
                                                                           comment=comment_text))

            if command == "/vote":
                handle_vote_command(api, parsed_comment, issue_id,
                                    global_comment_id, votes)


def poll_read_issue_comments():
    __log.info("looking for issue comments")

    api = gh.API(settings.GITHUB_USER, settings.GITHUB_SECRET)

    issue_comments = gh.comments.get_all_issue_comments(api, settings.URN)

    for issue_comment in issue_comments:
        handle_comment(api, issue_comment)

    __log.info("Waiting %d seconds until next scheduled Issue comment polling",
               settings.ISSUE_COMMENT_POLLING_INTERVAL_SECONDS)
