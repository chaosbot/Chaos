import logging
import arrow
import json
import os
import re
from os.path import join, abspath, dirname

import settings
import github_api as gh

THIS_DIR = dirname(abspath(__file__))
# Hopefully this isn't overwritten on pulls
SAVED_COMMANDS_FILE = join(THIS_DIR, '..', "server/issue_commands_ran.json")
if not os.path.exists(SAVED_COMMANDS_FILE):
    '''
        "comment_id": [ // the actual id
            {
                "comment_id" : int,
                "has_ran" : bool,
                "command": string
                "chaos_response_id" : int, // chaos status comment id
                "time_remaining": int
            }
        ]
    '''
    with open(SAVED_COMMANDS_FILE, 'w') as f:
        json.dump({}, f)

__log = logging.getLogger("poll_issue_commands")

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


def update_db(comment_id, data_fields, db=None):

    if not db:
        with open(SAVED_COMMANDS_FILE, 'r') as f:
            db = json.load(f)

    for field, value in data_fields.items():
        db[comment_id][field] = value

    with open(SAVED_COMMANDS_FILE, 'w') as f:
        json.dump(db, f)


def select_db(comment_id, fields):
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        db = json.load(f)
        data = {}
        for field in fields:
            data[field] = db[comment_id][field]
        return data


def set_time_remaining(api, comment_id, comment_txt):
    command_history = {}
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        command_history = json.load(f)

    comment_data = command_history.get(comment_id, None)

    if not comment_data:
        comment_data = {
            "comment_id": comment_id,
            "has_ran": False,
            # "command": comment_txt,
            "chaos_response_id": None,
            "time_remaining": None
        }
        command_history[comment_id] = comment_data

    if comment_data["has_ran"]:
        return

    now = arrow.utcnow()
    voting_window = gh.voting.get_initial_voting_window(now)

    seconds_remaining = gh.issues.voting_window_remaining_seconds(api, settings.URN, comment_id,
                                                                  voting_window)

    data = {
        "time_remaining": seconds_remaining,
        "command": comment_txt  # Keep this fresh so nobody edits their command post..
        }
    update_db(comment_id, data, db=command_history)


def has_enough_votes(votes):
    # At least one negative vote will cause vote to not pass
    for user, vote in votes.items():
        if vote < 0:
            __log.debug("vote less than one")
            return False

    return True


def post_command_status_update(api, issue_id, comment_id, has_votes):

    # First find out if we have posted a status update for this command already
    # Todo, stop opening all these files
    command_history = {}
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        command_history = json.load(f)

    # Todo - stop doing loops
    comment_data = command_history[comment_id]
    if comment_data["has_ran"]:
        return

    seconds_remaining = comment_data["time_remaining"]
    command_text = comment_data["command"]

    time = gh.misc.seconds_to_human(seconds_remaining)
    status = "passing" if has_votes else "failing"
    body = "> {command}\n\nTime remaining: {time} - Vote status: {status}".format(
                                                                            command=command_text,
                                                                            time=time,
                                                                            status=status)

    if comment_data["chaos_response_id"]:
        resp = gh.comments.edit_comment(api, settings.URN, comment_data["chaos_response_id"], body)
    else:
        resp = gh.comments.leave_comment(api, settings.URN, issue_id, body)
        update_db(comment_id, {"chaos_response_id": str(resp["id"])}, db=command_history)


def can_run_vote_command(api, votes, comment_id):
    json_data = {}
    with open(SAVED_COMMANDS_FILE, 'r') as f:
        json_data = json.load(f)

    comment_data = json_data[comment_id]

    if comment_data["has_ran"]:
        __log.debug("Already ran command")
        return False

    time_left = comment_data["time_remaining"]
    if time_left > 0:
        __log.debug("Time remaining: " + gh.misc.seconds_to_human(time_left))
        return False

    return True


def update_command_ran(api, comment_id):
    update_db(comment_id, {"has_ran": True})
    body = "Command has been run"
    gh.comments.edit_comment(api, settings.URN, comment_id, body)


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
            update_command_ran(api, comment_id)
        elif sub_command == "reopen":
            gh.issues.open_issue(api, settings.URN, issue_id)
            gh.comments.leave_issue_reopened_comment(api, settings.URN, issue_id)
            update_command_ran(api, comment_id)
        else:
            # Implement other commands
            pass
    else:
        log_warning = True

    if log_warning:
        __log.warning("Unknown issue command syntax: /vote {command}".format(command=orig_command))


def handle_comment(api, issue_comment):
    issue_id = issue_comment["issue_id"]
    global_comment_id = str(issue_comment["global_comment_id"])
    comment_text = issue_comment["comment_text"]

    comment_text = re.sub('\s+', ' ', comment_text)
    parsed_comment = list(map(lambda x: x.lower(), comment_text.split(' ')))
    orig_parsed = parsed_comment[:]
    command = parsed_comment.pop(0)
    if command in COMMAND_LIST:
        __log.debug("Got command: {command}, parsed: {parsed}".format(command=comment_text,
                                                                      parsed=orig_parsed))
        votes = get_command_votes(api, settings.URN, global_comment_id)
        set_time_remaining(api, global_comment_id, comment_text)
        can_run = can_run_vote_command(api, votes, global_comment_id)
        has_votes = has_enough_votes(votes)
        post_command_status_update(api, issue_id, global_comment_id, has_votes)

        # We doin stuff boyz
        if can_run and has_votes:
            __log.debug("Handling issue {issue}: comment {comment}".format(issue=issue_id,
                                                                           comment=comment_text))

            if command == "/vote":
                handle_vote_command(api, parsed_comment, issue_id,
                                    global_comment_id, votes)
        elif can_run and not has_votes:
            # oops we didn't pass
            update_db(global_comment_id, {"has_run": True})
            db_fields = select_db(global_comment_id, ("chaos_response_id", "command"))
            resp_id = db_fields["chaos_response_id"]
            command = db_fields["command"]
            body = "> {command}\n\nVote failed".format(command=command)
            gh.comments.edit_comment(api, settings.URN, resp_id, body)
    else:
        __log.debug("comment: {comment} is not a command, " +
                    "parsed: {parsed}".format(comment=comment_text, parsed=orig_parsed))

        
def poll_read_issue_comments(api):
    __log.info("looking for issue comments")

    issue_comments = gh.comments.get_all_issue_comments(api, settings.URN)
    __log.info("found {count} issue comments".format(count=len(issue_comments)))

    for issue_comment in issue_comments:
        handle_comment(api, issue_comment)

    __log.info("Waiting %d seconds until next scheduled Issue comment polling",
               settings.ISSUE_COMMENT_POLLING_INTERVAL_SECONDS)
