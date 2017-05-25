import arrow
import settings
from . import prs

def get_reactions_for_comment(api, urn, comment_id):
    path = "/repos/{urn}/issues/comments/{comment}/reactions"\
            .format(urn=urn, comment=comment_id)
    params = {"per_page": settings.DEFAULT_PAGINATION}
    reactions = api("get", path, params=params)
    for reaction in reactions:
        yield reaction

def leave_reject_comment(api, urn, pr, votes, total, threshold):
    votes_summary = prs.formatted_votes_summary(votes, total, threshold)
    body = """
:no_good: PR rejected {summary}.

Open a new PR to restart voting.
    """.strip().format(summary=votes_summary)
    return leave_comment(api, urn, pr, body)


def leave_accept_comment(api, urn, pr, sha, votes, total, threshold):
    votes_summary = prs.formatted_votes_summary(votes, total, threshold)
    body = """
:ok_woman: PR passed {summary}.

See merge-commit {sha} for more details.
    """.strip().format(summary=votes_summary, sha=sha)
    return leave_comment(api, urn, pr, body)

def leave_stale_comment(api, urn, pr, hours):
    body = """
:no_good: This PR has merge conflicts, and hasn't been touched in {hours} hours. Closing.

Open a new PR with the merge conflicts fixed to restart voting.
    """.strip().format(hours=hours)
    return leave_comment(api, urn, pr, body)

def leave_comment(api, urn, pr, body):
    path = "/repos/{urn}/issues/{pr}/comments".format(urn=urn, pr=pr)
    data = {"body": body}
    resp = api("post", path, json=data)
    return resp
