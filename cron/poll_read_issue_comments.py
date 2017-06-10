import logging
import arrow
import re
import json
from requests.exceptions import HTTPError

import settings
import github_api as gh

from lib.db.models import Comment, User, ActiveIssueCommands, Issue
from lib.db.models import RunTimes, InactiveIssueCommands, MeritocracyMentioned

'''
Command Syntax
/vote close closes issue when no nay reactions on this comment are added within voting window
/vote reopen reopens issue when see above ^^^
/vote label=<LABEL_TEXT> adds label when ^^^
/vote remove-label=<LABEL_TEXT> removes label when ^^^
/vote assign=<USER> assigns to user when ^^^
/vote unassign=<USER> unassigns from user when ^^^
'''

# If no subcommands, map cmd: None
COMMAND_LIST = {
        "/vote": ("close", "reopen", "fast")
    }

__log = logging.getLogger("read_issue_comments")


def get_seconds_remaining(api, comment_id):
    voting_window = gh.voting.get_initial_voting_window()
    seconds_remaining = gh.issues.voting_window_remaining_seconds(api, settings.URN, comment_id,
                                                                  voting_window)
    seconds_remaining = max(0, seconds_remaining)  # No negative time
    return seconds_remaining


def insert_or_update_issue(api, issue_id, number):
    # get more info on the issue
    gh_issue = gh.issue.open_issue(api, settings.URN, number)

    # get user from db
    user, _ = User.get_or_create(user_id=gh_issue["user"]["id"],
                                 defaults={"login": gh_issue["user"]["login"]})

    # db insert
    issue, _ = Issue.get_or_create(issue_id=issue_id,
                                   defaults={
                                       "issue_id": issue_id,
                                       "number": number,
                                       "user": user,
                                       "created_at": gh_issue["created_at"],
                                       "expedited": False,
                                       "is_pr": "pull_request" in gh_issue,
                                       })

    return issue


def insert_or_update(api, cmd_obj):
    # Find the comment, or create it if it doesn't exit
    comment_id = cmd_obj["global_comment_id"]
    user, _ = User.get_or_create(user_id=cmd_obj["user"]["id"],
                                 defaults={"login": cmd_obj["user"]["login"]})
    issue = insert_or_update_issue(api, cmd_obj["issue_id"], cmd_obj["number"])
    comment, _ = Comment.get_or_create(comment_id=comment_id,
                                       defaults={
                                           "user": user, "text": cmd_obj["comment_text"],
                                           "created_at": cmd_obj["created_at"],
                                           "updated_at": cmd_obj["updated_at"]
                                       })

    command, _ = ActiveIssueCommands.get_or_create(comment=comment,
                                                   issue=issue)

    update_cmd(api, command, cmd_obj["comment_text"])


def update_cmd(api, cmd_obj, comment_text):
    # Need to keep the comment text and time remaining fresh
    comment_id = cmd_obj.comment.comment_id
    Comment.update(text=comment_text).where(Comment.comment_id == comment_id).execute()

    seconds_remaining = get_seconds_remaining(api, comment_id)

    ActiveIssueCommands.update(comment=Comment.get(comment_id=comment_id),
                               seconds_remaining=seconds_remaining).where(
                               ActiveIssueCommands.comment == comment_id).execute()


def has_enough_votes(votes):
    # At least one negative vote will cause vote to not pass
    for user, vote in votes.items():
        if vote < 0:
            # __log.debug("vote less than one")
            return False

    return True


def post_command_status_update(api, cmd, has_votes):
    time = gh.misc.seconds_to_human(cmd.seconds_remaining)
    command_text = cmd.comment.text
    status = "passing :white_check_mark:" if has_votes else "failing :no_entry:"
    body = "> {command}\n\nTime remaining: {time} - Vote status: {status}".format(
                                                                            command=command_text,
                                                                            time=time,
                                                                            status=status)

    if cmd.chaos_response:
        # Update comment
        resp = gh.comments.edit_comment(api, settings.URN, cmd.chaos_response.comment_id, body)
    else:
        # New response comment
        resp = gh.comments.leave_comment(api, settings.URN, cmd.issue.issue_id, body)

    user, _ = User.get_or_create(user_id=resp["user"]["id"],
                                 defaults={"login": resp["user"]["login"]})
    resp_comment, _ = Comment.get_or_create(comment_id=resp["id"],
                                            defaults={
                                                "user": user, "text": body,
                                                "created_at": resp["created_at"],
                                                "updated_at": resp["updated_at"]
                                            })
    ActiveIssueCommands.update(chaos_response=resp_comment).where(
                               ActiveIssueCommands.comment == cmd.comment.comment_id).execute()


def can_run_vote_command(api, cmd):
    if cmd.seconds_remaining > 0:
        return False

    return True


def update_command_ran(api, comment_id, text):
    cmd = ActiveIssueCommands.get(ActiveIssueCommands.comment == comment_id)
    InactiveIssueCommands.get_or_create(comment=cmd.comment)
    body = "> {command}\n\n{text}".format(command=cmd.comment.text, text=text)
    gh.comments.edit_comment(api, settings.URN, cmd.chaos_response.comment_id, body)
    cmd.delete_instance()


def get_command_votes(api, urn, comment_id):
    votes = {}

    try:
        for voter, vote in gh.voting.get_comment_reaction_votes(api, urn, comment_id):
            votes[voter] = vote
    except HTTPError as e:
        # Command possibly deleted
        __log.error("Unable to get votes for command id: {id} - {msg}".format(id=comment_id,
                                                                              msg=str(e)))
        raise e
        # Figure out what happened later
    return votes


def get_meritocracy(api):
    with open('server/voters.json', 'r+') as fp:
        total_votes = {}
        fs = fp.read()
        if fs:
            total_votes = json.loads(fs)

        top_contributors = sorted(gh.repos.get_contributors(api, settings.URN),
                                  key=lambda user: user["total"], reverse=True)
        top_contributors = [item["author"]["login"].lower() for item in top_contributors]
        top_contributors = top_contributors[:settings.MERITOCRACY_TOP_CONTRIBUTORS]
        top_contributors = set(top_contributors)

        top_voters = sorted(total_votes, key=total_votes.get, reverse=True)
        top_voters = map(lambda user: user.lower(), top_voters)
        top_voters = list(filter(lambda user: user not in settings.MERITOCRACY_VOTERS_BLACKLIST,
                                 top_voters))
        top_voters = set(top_voters[:settings.MERITOCRACY_TOP_VOTERS])
        meritocracy = top_voters | top_contributors

        return meritocracy


def fast_vote(api, cmdmeta):
            comment_updated_at = cmdmeta.comment.updated_at
            comment_created_at = cmdmeta.comment.created_at
            comment_poster = cmdmeta.comment.user
            issue_created_at = cmdmeta.issue.created_at

            # This must be a PR
            if not cmdmeta.issue.is_pr:
                return

            # The post should not have been updated
            if comment_updated_at != comment_created_at:
                return

            # The comment poster must be in the meritocracy
            meritocracy = get_meritocracy(api)
            if comment_poster not in meritocracy:
                return

            # The comment must posted within 5 min of the issue
            if (arrow.get(comment_created_at) -
                    arrow.get(issue_created_at)).total_seconds() > 5*60:
                return

            # Leave a note on the issue that it is expedited
            Issue.update(expedited=True).where(Issue.issue_id == cmdmeta.issue.issue_id).execute()

            # mention the meritocracy immediately
            try:
                pr = gh.prs.get_pr(api, settings.URN, cmdmeta.issue.number)
                commit = pr["head"]["sha"]

                mm, created = MeritocracyMentioned.get_or_create(commit_hash=commit)
                if created:
                    meritocracy_mentions = meritocracy - {pr["user"]["login"].lower(),
                                                          "chaosbot"}
                    gh.comments.leave_expedite_comment(api,
                                                       settings.URN, pr["number"],
                                                       meritocracy_mentions)
            except:
                __log.exception("Failed to process meritocracy mention")


def handle_vote_command(api, command, cmdmeta, votes):
    issue_id = cmdmeta.issue.issue_id

    orig_command = command[:]
    # Check for correct command syntax, ie, subcommands
    log_warning = False
    if len(command):
        sub_command = command.pop(0)
        if sub_command == "close":
            gh.issues.close_issue(api, settings.URN, issue_id)
        elif sub_command == "reopen":
            gh.issues.open_issue(api, settings.URN, issue_id)
        elif sub_command == "fast":
            fast_vote(api, cmdmeta)

        else:
            # Implement other commands
            pass
    else:
        log_warning = True

    if log_warning:
        __log.warning("Unknown issue command syntax: /vote {command}".format(command=orig_command))


def handle_comment(api, cmd):
    issue_id = cmd.issue.issue_id
    comment_id = cmd.comment.comment_id
    comment_text = cmd.comment.text

    comment_text = re.sub('\s+', ' ', comment_text)
    parsed_comment = list(map(lambda x: x.lower(), comment_text.split(' ')))
    command = parsed_comment.pop(0)

    votes = get_command_votes(api, settings.URN, comment_id)
    update_cmd(api, cmd, comment_text)
    can_run = can_run_vote_command(api, cmd)
    has_votes = has_enough_votes(votes)
    post_command_status_update(api, cmd, has_votes)

    # We doin stuff boyz
    if can_run and has_votes:
        __log.debug("Handling issue {issue}: command {comment}".format(issue=issue_id,
                                                                       comment=comment_text))

        if command == "/vote":
            handle_vote_command(api, parsed_comment, cmd, votes)

        update_command_ran(api, comment_id, "Command Ran")

    elif can_run and not has_votes:
        # oops we didn't pass
        update_command_ran(api, comment_id, "Vote Failed")


def is_command(comment):
    comment = re.sub('\s+', ' ', comment)
    parsed_comment = list(map(lambda x: x.lower(), comment.split(' ')))
    cmd = parsed_comment[0]
    is_cmd = False

    if cmd in COMMAND_LIST:
        subcommands = COMMAND_LIST.get(cmd, None)

        # 4 cases
        # 1. No subcommands for command
        # 2. Subcommands exist, and args has it
        # 3. Subcommands exist, and args don't have it
        # 4. Args specify non existant subcommand
        if subcommands is None:
            is_cmd = True  # Already have the command
        else:
            sub_cmd_with_args = parsed_comment[1:]

            if len(sub_cmd_with_args) > 0:
                sub_cmd = sub_cmd_with_args[0]

                # Check cond 2
                if sub_cmd in subcommands:
                    is_cmd = True
                else:
                    is_cmd = False
            else:
                # Cond 3
                is_cmd = False

    return is_cmd


def poll_read_issue_comments(api):
    __log.info("looking for issue comments")

    run_time, created = RunTimes.get_or_create(command="issue_commands")

    # No last ran time if just created
    if created:
        last_ran = None
    else:
        last_ran = arrow.get(run_time.last_ran)

    paged_results = gh.comments.get_all_issue_comments(api,
                                                       settings.URN,
                                                       page='all',
                                                       since=last_ran)

    # This now only finds new entries that have been either posted or updated
    # Add them to our database
    # If page=all, you have to loop through pages as well
    for page in paged_results:
        for issue_comment in page:
            # Get info and store in db
            # Do a check to make sure comment_id isn't a command that already ran
            if is_command(issue_comment["comment_text"]):
                _id = issue_comment["global_comment_id"]
                # HOTFIX to not re-add command if it was already ran.
                try:
                    InactiveIssueCommands.get(comment=_id)
                except InactiveIssueCommands.DoesNotExist:
                    insert_or_update(api, issue_comment)

    cmds = ActiveIssueCommands.select().order_by(ActiveIssueCommands.seconds_remaining)
    for cmd in cmds:
        try:
            handle_comment(api, cmd)
        except HTTPError as e:
            # Check if 404 here
            # Maybe remove response comment too?
            cmd.comment.delete_instance()
            cmd.delete_instance()

    last_ran = gh.misc.dt_to_github_dt(arrow.utcnow())
    RunTimes.update(last_ran=last_ran).where(RunTimes.command == "issue_commands").execute()
    __log.info("Waiting %d seconds until next scheduled Issue comment polling",
               settings.ISSUE_COMMENT_POLLING_INTERVAL_SECONDS)
