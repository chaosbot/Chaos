import arrow
import logging
import os
import sys
from os.path import join, abspath, dirname

import settings
import github_api as gh

THIS_DIR = dirname(abspath(__file__))

__log = logging.getLogger("chaosbot")


def poll_pull_requests(api):
    __log.info("looking for PRs")

    # get voting window
    now = arrow.utcnow()
    voting_window = gh.voting.get_initial_voting_window(now)

    # get all ready prs (disregarding of the voting window)
    prs = gh.prs.get_ready_prs(api, settings.URN, 0)

    needs_update = False
    for pr in prs:
        pr_num = pr["number"]
        __log.info("processing PR #%d", pr_num)

        # gather all current votes
        votes = gh.voting.get_votes(api, settings.URN, pr)

        # is our PR approved or rejected?
        vote_total, variance = gh.voting.get_vote_sum(api, votes)
        threshold = gh.voting.get_approval_threshold(api, settings.URN)
        is_approved = vote_total >= threshold

        # the PR is mitigated or the threshold is not reached ?
        if variance >= threshold or not is_approved:
            voting_window = gh.voting.get_extended_voting_window(api, settings.URN)

        # is our PR in voting window?
        in_window = gh.prs.is_pr_in_voting_window(pr, voting_window)

        if is_approved:
            __log.info("PR %d status: will be approved", pr_num)

            gh.prs.post_accepted_status(
                api, settings.URN, pr, voting_window, votes, vote_total, threshold)

            if in_window:
                __log.info("PR %d approved for merging!", pr_num)

                try:
                    sha = gh.prs.merge_pr(api, settings.URN, pr, votes, vote_total,
                                          threshold)
                # some error, like suddenly there's a merge conflict, or some
                # new commits were introduced between finding this ready pr and
                # merging it
                except gh.exceptions.CouldntMerge:
                    __log.info("couldn't merge PR %d for some reason, skipping",
                               pr_num)
                    gh.prs.label_pr(api, settings.URN, pr_num, ["can't merge"])
                    continue

                gh.comments.leave_accept_comment(
                    api, settings.URN, pr_num, sha, votes, vote_total, threshold)
                gh.prs.label_pr(api, settings.URN, pr_num, ["accepted"])

                # chaosbot rewards merge owners with a follow
                pr_owner = pr["user"]["login"]
                gh.users.follow_user(api, pr_owner)

                # save votes to voting record
                gh.voting.persist_votes(votes)

                needs_update = True

        else:
            __log.info("PR %d status: will be rejected", pr_num)

            if in_window:
                gh.prs.post_rejected_status(
                    api, settings.URN, pr, voting_window, votes, vote_total, threshold)
                __log.info("PR %d rejected, closing", pr_num)
                gh.comments.leave_reject_comment(
                    api, settings.URN, pr_num, votes, vote_total, threshold)
                gh.prs.label_pr(api, settings.URN, pr_num, ["rejected"])
                gh.prs.close_pr(api, settings.URN, pr)

                # save votes to voting record
                gh.voting.persist_votes(votes)
            elif vote_total < 0:
                gh.prs.post_rejected_status(
                    api, settings.URN, pr, voting_window, votes, vote_total, threshold)
            else:
                gh.prs.post_pending_status(
                    api, settings.URN, pr, voting_window, votes, vote_total, threshold)

    # we approved a PR, restart
    if needs_update:
        __log.info("updating code and requirements and restarting self")
        startup_path = join(THIS_DIR, "..", "startup.sh")

        # before we exec, we need to flush i/o buffers so we don't lose logs or voters
        sys.stdout.flush()
        sys.stderr.flush()

        os.execl(startup_path, startup_path)

    __log.info("Waiting %d seconds until next scheduled PR polling event",
               settings.PULL_REQUEST_POLLING_INTERVAL_SECONDS)
