import arrow
import settings


def get_reactions_for_comment(api, urn, comment_id, since):
    path = "/repos/{urn}/issues/comments/{comment}/reactions"\
            .format(urn=urn, comment=comment_id)
    params = {"per_page": settings.DEFAULT_PAGINATION}
    reactions = api("get", path, params=params)
    for reaction in reactions:
        created = arrow.get(reaction["created_at"])
        if created > since:
            yield reaction

def leave_reject_comment(api, urn, pr):
    body = """
:no_good: This PR did not meet the required vote threshold and will not be merged. \
Closing.

Open a new PR to restart voting.
    """.strip()
    return leave_comment(api, urn, pr, body)


def leave_comment(api, urn, pr, body):
    path = "/repos/{urn}/issues/{pr}/comments".format(urn=urn, pr=pr)
    data = {"body": body}
    resp = api("post", path, json=data)
    return resp
