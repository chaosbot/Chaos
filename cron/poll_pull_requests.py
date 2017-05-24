import arrow
import logging
import os
from os.path import join, abspath, dirname

import settings
import github_api as gh

THIS_DIR = dirname(abspath(__file__))

__log = logging.getLogger("chaosbot")

def poll_pull_requests():
    __log.info("looking for PRs")

    api = gh.API(settings.GITHUB_USER, settings.GITHUB_SECRET)
    now = arrow.utcnow()
    voting_window = gh.voting.get_voting_window(now)
    prs = gh.prs.get_ready_prs(api, settings.URN, voting_window)

    needs_update = False
    for pr in prs:
        pr_num = pr["number"]
        __log.info("processing PR #%d", pr_num)

        votes = gh.voting.get_votes(api, settings.URN, pr)

        # is our PR approved or rejected?
        vote_total = gh.voting.get_vote_sum(api, votes)
        threshold = gh.voting.get_approval_threshold(api, settings.URN)
        is_approved = vote_total >= threshold

        if is_approved:
            __log.info("PR %d approved for merging!", pr_num)
            try:
                gh.prs.merge_pr(api, settings.URN, pr, votes, vote_total,
                        threshold)
            # some error, like suddenly there's a merge conflict, or some
            # new commits were introduced between findint this ready pr and
            # merging it
            except gh.exceptions.CouldntMerge:
                __log.info("couldn't merge PR %d for some reason, skipping",
                        pr_num)
                gh.prs.label_pr(api, settings.URN, pr_num, ["can't merge"])
                continue

            gh.prs.label_pr(api, settings.URN, pr_num, ["accepted"])

            # chaosbot rewards merge owners with a follow
            pr_owner = pr["user"]["login"]
            gh.users.follow_user(api, pr_owner)

            needs_update = True

        else:
            __log.info("PR %d rejected, closing", pr_num)
            gh.comments.leave_reject_comment(api, settings.URN, pr_num)
            gh.prs.label_pr(api, settings.URN, pr_num, ["rejected"])
            gh.prs.close_pr(api, settings.URN, pr)

    # we approved a PR, restart
    if needs_update:
        __log.info("updating code and requirements and restarting self")
        startup_path = join(THIS_DIR, "..", "startup.sh")
        os.execl(startup_path, startup_path)

    __log.info("Waiting %d seconds until next scheduled PR polling event", settings.PULL_REQUEST_POLLING_INTERVAL_SECONDS)

