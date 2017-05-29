import arrow
import math


def close_issue(api, urn, issue_id):
    path = "/repos/{urn}/issues/{issue}".format(urn=urn, issue=issue_id)
    data = {"state": "closed"}
    resp = api("PATCH", path, json=data)
    return resp


def open_issue(api, urn, issue_id):
    path = "/repos/{urn}/issues/{issue}".format(urn=urn, issue=issue_id)
    data = {"state": "open"}
    resp = api("PATCH", path, json=data)
    return resp


def get_issue_comment_last_updated(api, urn, comment):
    path = "/repos/{urn}/issues/comments/{comment}".format(urn=urn, comment=comment)
    comment = api("get", path)
    updated = arrow.get(comment["updated_at"])
    return updated


def voting_window_remaining_seconds(api, urn, comment, window):
    """ returns the number of seconds until voting is over.  can be negative,
    meaning voting has been over for that long """
    now = arrow.utcnow()
    issue_comment_updated = get_issue_comment_last_updated(api, urn, comment)

    # this is how many seconds ago the issue comment has been updated.
    # if we don't have a last update time, we're setting this to negative
    # infinity, which is a mind-bender, but makes the maths work out
    elapsed_last_update = -math.inf
    if issue_comment_updated:
        elapsed_last_update = (now - issue_comment_updated).total_seconds()

    return window - elapsed_last_update


def is_issue_comment_in_voting_window(api, urn, comment, window):
    return voting_window_remaining_seconds(api, urn, comment, window) <= 0


def create_issue(api, urn, title, body, labels):
    path = "/repos/{urn}/issues".format(urn=urn)
    data = {
            "title": title,
            "body": body,
            "labels": labels,
            }
    resp = api("post", path, json=data)
    return resp
