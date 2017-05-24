import arrow
import settings


def get_reactions_for_comment(api, urn, comment_id):
    path = "/repos/{urn}/issues/comments/{comment}/reactions"\
            .format(urn=urn, comment=comment_id)
    params = {"per_page": settings.DEFAULT_PAGINATION}
    reactions = api("get", path, params=params)
    for reaction in reactions:
        yield reaction

def leave_reject_comment_not_enough_votes(api, urn, pr):
    body = """
:no_good: This PR did not meet the required vote threshold and will not be merged. \
Closing.

Open a new PR to restart voting.
    """.strip()
    return leave_comment(api, urn, pr, body)

def leave_reject_comment_too_selfish(api, urn, pr):
    body = """
:no_good: This PR did not meet the required selflessness criteria and will not be merged. \
Closing.

Open a new PR *without adding your own username to the codebase* to restart voting.
    """.strip()
    return leave_comment(api, urn, pr, body)


def leave_comment(api, urn, pr, body):
    path = "/repos/{urn}/issues/{pr}/comments".format(urn=urn, pr=pr)
    data = {"body": body}
    resp = api("post", path, json=data)
    return resp
