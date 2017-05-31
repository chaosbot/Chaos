import arrow
import logging

import settings
import github_api as gh

__log = logging.getLogger("stale_issues")


def poll_issue_close_stale(api):
    """
    Looks through all open issues. For any open issue, if the issue is
    too old and has not been recently commented on, chaosbot issues a
    /vote close...
    """

    __log.info("Checking for stale issues...")

    # Get all issues
    issues = gh.issues.get_open_issues(api, settings.URN)

    __log.info("There are currently %d open issues" % len(issues))

    for issue in issues:
        number = issue["number"]
        last_updated = arrow.get(issue["updated_at"])

        now = arrow.utcnow()
        delta = (now - last_updated).total_seconds()

        __log.info("Issue %d has not been updated in %d seconds" % (number, delta))

        if delta > settings.ISSUE_STALE_THRESHOLD:
            __log.info("/vote close issue %d" % number)

            # leave an explanatory comment
            body = "This issue hasn't been active for a while." + \
                "To keep it open, react with :-1: on the `vote close` post."
            gh.comments.leave_comment(api, settings.URN, number, body)

            # then vote to close
            body = "/vote close"
            gh.comments.leave_comment(api, settings.URN, number, body)
