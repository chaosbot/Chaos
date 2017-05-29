import math

import arrow
from requests import HTTPError

import settings
from . import comments
from . import exceptions as exc
from . import misc
from . import voting

TRAVIS_CI_CONTEXT = "continuous-integration/travis-ci"


def merge_pr(api, urn, pr, votes, total, threshold, meritocracy_satisfied):
    """ merge a pull request, if possible, and use a nice detailed merge commit
    message """

    pr_num = pr["number"]
    pr_title = pr['title']
    pr_description = pr['body']

    path = "/repos/{urn}/pulls/{pr}/merge".format(urn=urn, pr=pr_num)

    record = voting.friendly_voting_record(votes)
    if record:
        record = "Vote record:\n" + record

    votes_summary = formatted_votes_summary(votes, total, threshold, meritocracy_satisfied)

    pr_url = "https://github.com/{urn}/pull/{pr}".format(urn=urn, pr=pr_num)

    title = "merging PR #{num}: {pr_title}".format(
        num=pr_num, pr_title=pr_title)
    desc = """
{pr_url}: {pr_title}

Description:
{pr_description}

:ok_woman: PR passed {summary}.

{record}
""".strip().format(
        pr_url=pr_url,
        pr_title=pr_title,
        pr_description=pr_description,
        summary=votes_summary,
        record=record,
    )

    data = {
        "commit_title": title,
        "commit_message": desc,

        # if some clever person attempts to submit more commits while we're
        # aggregating votes, this sha check will fail and no merge will occur
        "sha": pr["head"]["sha"],

        # default is "merge"
        # i think we want to do a squash so its easier to auto-revert entire
        # PRs, instead of detecting merge commits, then picking the right parent
        # for a revert.  this way—with squash—every commit aside from hotfixes
        # will be entire PRs
        "merge_method": "squash",
    }
    try:
        resp = api("PUT", path, json=data)
        return resp["sha"]
    except HTTPError as e:
        resp = e.response
        # could not be merged
        if resp.status_code == 405:
            raise exc.CouldntMerge
        # someone trying to be sneaky and change their PR commits during voting
        elif resp.status_code == 409:
            raise exc.CouldntMerge
        else:
            raise


def formatted_votes_summary(votes, total, threshold, meritocracy_satisfied):
    vfor = sum(v for v in votes.values() if v > 0)
    vagainst = abs(sum(v for v in votes.values() if v < 0))
    meritocracy_str = "a" if meritocracy_satisfied else "**NO**"

    return """
with a vote of {vfor} for and {vagainst} against, a weighted total of {total:.1f} \
and a threshold of {threshold:.1f}, and {meritocracy} current meritocracy review
    """.strip().format(vfor=vfor, vagainst=vagainst, total=total, threshold=threshold,
                       meritocracy=meritocracy_str)


def formatted_votes_short_summary(votes, total, threshold, meritocracy_satisfied):
    vfor = sum(v for v in votes.values() if v > 0)
    vagainst = abs(sum(v for v in votes.values() if v < 0))
    meritocracy_str = "✓" if meritocracy_satisfied else "✗"

    return """
vote: {vfor}-{vagainst}, weighted total: {total:.1f}, threshold: {threshold:.1f}, \
meritocracy: {meritocracy}
    """.strip().format(vfor=vfor, vagainst=vagainst, total=total, threshold=threshold,
                       meritocracy=meritocracy_str)


def label_pr(api, urn, pr_num, labels):
    """ set a pr's labels (removes old labels) """
    if not isinstance(labels, (tuple, list)):
        labels = [labels]
    path = "/repos/{urn}/issues/{pr}/labels".format(urn=urn, pr=pr_num)
    data = labels
    return api("PUT", path, json=data)


def close_pr(api, urn, pr):
    """ https://developer.github.com/v3/pulls/#update-a-pull-request """
    path = "/repos/{urn}/pulls/{pr}".format(urn=urn, pr=pr["number"])
    data = {
        "state": "closed",
    }
    return api("patch", path, json=data)


def get_pr_last_updated(pr_data):
    """ a helper for finding the utc datetime of the last pr branch
    modifications """
    repo = pr_data["head"]["repo"]
    if repo:
        return arrow.get(repo["pushed_at"])
    else:
        return None


def get_pr_comments(api, urn, pr_num):
    """ yield all comments on a pr, weirdly excluding the initial pr comment
    itself (the one the owner makes) """
    params = {
        "per_page": settings.DEFAULT_PAGINATION
    }
    path = "/repos/{urn}/issues/{pr}/comments".format(urn=urn, pr=pr_num)
    comments = api("get", path, params=params)
    for comment in comments:
        yield comment


def has_build_passed(api, statuses_url):
    """
        Check if a Pull request has passed Travis CI builds
    :param api: github api instance
    :param statuses_url: full url to the github commit status.
           Given in pr["statuses_url"]
    :return: true if the commit passed travis build, false if failed or still pending
    """
    statuses_path = statuses_url.replace(api.BASE_URL, "")

    statuses = api("get", statuses_path)

    if statuses:
        for status in statuses:
            # Check the state and context of the commit status
            # the state can be a success for Chaosbot statuses,
            # so we double-check context for a Travis CI context
            if (status["state"] == "success") and \
               (status["context"].startswith(TRAVIS_CI_CONTEXT)):
                return True
    return False


def get_ready_prs(api, urn, window):
    """ yield mergeable, travis-ci passed, non-WIP prs that have had no modifications for longer
    than the voting window.  these are prs that are ready to be considered for
    merging """
    open_prs = get_open_prs(api, urn)
    for pr in open_prs:
        pr_num = pr["number"]

        now = arrow.utcnow()
        updated = get_pr_last_updated(pr)
        if updated is None:
            comments.leave_deleted_comment(api, urn, pr["number"])
            close_pr(api, urn, pr)
            continue

        delta = (now - updated).total_seconds()
        is_wip = "WIP" in pr["title"]

        # this is unused right now.  there are issues with travis status not
        # existing on the PRs anymore (somehow..still unsolved), and then PRs
        # were not being processed or updated.  do not use this variable in the
        # if-condition that follow it until that has been solved
        # build_passed = has_build_passed(api, pr["statuses_url"])

        if is_wip or delta < window:
            continue

        # we check if its mergeable if its outside the voting window,
        # because there seems to be a race where a freshly-created PR exists
        # in the paginated list of PRs, but 404s when trying to fetch it directly
        # mergeable can also be None, in which case we just skip it for now
        mergeable = get_is_mergeable(api, urn, pr_num)

        if mergeable is True:
            label_pr(api, urn, pr_num, [])
            yield pr
        elif mergeable is False:
            label_pr(api, urn, pr_num, ["conflicts"])
            if delta >= 60 * 60 * settings.PR_STALE_HOURS:
                comments.leave_stale_comment(
                    api, urn, pr["number"], round(delta / 60 / 60))
                close_pr(api, urn, pr)


def voting_window_remaining_seconds(pr, window):
    now = arrow.utcnow()
    updated = get_pr_last_updated(pr)
    if updated is None:
        return math.inf
    delta = (now - updated).total_seconds()
    return window - delta


def is_pr_in_voting_window(pr, window):
    return voting_window_remaining_seconds(pr, window) <= 0


def get_pr_reviews(api, urn, pr_num):
    """ get all pr reviews on a pr
    https://help.github.com/articles/about-pull-request-reviews/ """
    params = {
        "per_page": settings.DEFAULT_PAGINATION
    }
    path = "/repos/{urn}/pulls/{pr}/reviews".format(urn=urn, pr=pr_num)
    data = api("get", path, params=params)
    return data


def get_is_mergeable(api, urn, pr_num):
    return get_pr(api, urn, pr_num)["mergeable"]


def get_pr(api, urn, pr_num):
    """ helper for fetching a pr.  necessary because the "mergeable" field does
    not exist on prs that come back from paginated endpoints, so we must fetch
    the pr directly """
    path = "/repos/{urn}/pulls/{pr}".format(urn=urn, pr=pr_num)
    pr = api("get", path)
    return pr


def get_open_prs(api, urn):
    params = {
        "state": "open",
        "sort": "updated",
        "direction": "asc",
        "per_page": settings.DEFAULT_PAGINATION,
    }
    path = "/repos/{urn}/pulls".format(urn=urn)
    data = api("get", path, params=params)
    return data


def get_reactions_for_pr(api, urn, pr):
    path = "/repos/{urn}/issues/{pr}/reactions".format(urn=urn, pr=pr)
    params = {"per_page": settings.DEFAULT_PAGINATION}
    reactions = api("get", path, params=params)
    for reaction in reactions:
        yield reaction


def post_accepted_status(api, urn, pr, voting_window, votes, total, threshold,
                         meritocracy_satisfied):
    sha = pr["head"]["sha"]

    remaining_seconds = voting_window_remaining_seconds(pr, voting_window)
    remaining_human = misc.seconds_to_human(remaining_seconds)
    votes_summary = formatted_votes_short_summary(votes, total, threshold, meritocracy_satisfied)

    post_status(api, urn, sha, "success",
                "remaining: {time}, {summary}".format(time=remaining_human, summary=votes_summary))


def post_rejected_status(api, urn, pr, voting_window, votes, total, threshold,
                         meritocracy_satisfied):
    sha = pr["head"]["sha"]

    remaining_seconds = voting_window_remaining_seconds(pr, voting_window)
    remaining_human = misc.seconds_to_human(remaining_seconds)
    votes_summary = formatted_votes_short_summary(votes, total, threshold, meritocracy_satisfied)

    post_status(api, urn, sha, "failure",
                "remaining: {time}, {summary}".format(time=remaining_human, summary=votes_summary))


def post_pending_status(api, urn, pr, voting_window, votes, total, threshold,
                        meritocracy_satisfied):
    sha = pr["head"]["sha"]

    remaining_seconds = voting_window_remaining_seconds(pr, voting_window)
    remaining_human = misc.seconds_to_human(remaining_seconds)
    votes_summary = formatted_votes_short_summary(votes, total, threshold, meritocracy_satisfied)

    post_status(api, urn, sha, "pending",
                "remaining: {time}, {summary}".format(time=remaining_human, summary=votes_summary))


def post_status(api, urn, sha, state, description):
    """ apply an issue label to a pr """
    path = "/repos/{urn}/statuses/{sha}".format(urn=urn, sha=sha)
    data = {
        "state": state,
        "description": description,
        "context": "chaosbot"
    }
    api("POST", path, json=data)
