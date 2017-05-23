import time
import os
import sys
import sh
from os.path import dirname, abspath, join
import logging

import arrow

import settings

import github_api as gh
import github_api.prs
import github_api.voting
import github_api.repos
import github_api.comments
from github_api import exceptions as gh_exc

import patch


if not os.path.isfile("usestartscript"):
    open("usestartupscript", 'a').close()
    subprocess.call("start.sh", shell=True)


THIS_DIR = dirname(abspath(__file__))

logging.basicConfig(level=logging.DEBUG)
logging.getLogger("requests").propagate = False
logging.getLogger("sh").propagate = False

log = logging.getLogger("chaosbot")

api = gh.API(settings.GITHUB_USER, settings.GITHUB_SECRET)



def update_self_code():
    """ pull the latest commits from master """
    sh.git.pull("origin", "master")


def restart_self():
    """ restart our process """
    sys.exit() # Restarting is handled in start.sh, allowing for more flexible things with stdout and stderr.



if __name__ == "__main__":
    logging.info("starting up and entering event loop")
    while True:
        log.info("looking for PRs")

        now = arrow.utcnow()
        voting_window = gh.voting.get_voting_window(now)
        prs = gh.prs.get_ready_prs(api, settings.URN, voting_window)

        needs_update = False
        for pr in prs:
            pr_num = pr["number"]
            logging.info("processing PR #%d", pr_num)

            votes = gh.voting.get_votes(api, settings.URN, pr)
        
            # is our PR approved or rejected?
            vote_total = gh.voting.get_vote_sum(api, votes)
            threshold = gh.voting.get_approval_threshold(api, settings.URN)
            is_approved = vote_total >= threshold

            if is_approved:
                log.info("PR %d approved for merging!", pr_num)
                try:
                    gh.prs.merge_pr(api, settings.URN, pr, votes, vote_total,
                            threshold)
                # some error, like suddenly there's a merge conflict, or some
                # new commits were introduced between findint this ready pr and
                # merging it
                except gh_exc.CouldntMerge:
                    log.info("couldn't merge PR %d for some reason, skipping",
                            pr_num)
                    gh.prs.label_pr(api, settings.URN, pr_num, ["can't merge"])
                    continue

                gh.prs.label_pr(api, settings.URN, pr_num, ["accepted"])
                needs_update = True

            else:
                log.info("PR %d rejected, closing", pr_num)
                gh.comments.leave_reject_comment(api, settings.URN, pr_num)
                gh.prs.label_pr(api, settings.URN, pr_num, ["rejected"])
                gh.prs.close_pr(api, settings.URN, pr)


        # we approved a PR, restart
        if needs_update:
            logging.info("updating code and restarting self")
            update_self_code()
            restart_self()

        logging.info("sleeping for %d seconds", settings.SLEEP_TIME)
        time.sleep(settings.SLEEP_TIME)
