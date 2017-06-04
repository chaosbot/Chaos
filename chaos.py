#!/usr/bin/env python
# -*- coding: utf-8 -*-

from os.path import exists
import os
import time
import sys
import logging
import subprocess
import settings
import schedule
import cron
import shutil

# this import must happen before any github api stuff gets imported.  it sets
# up caching on the api functions so we don't run out of api requests
import patch  # noqa: F401

import github_api as gh
import github_api.prs
import github_api.voting
import github_api.repos
import github_api.comments
import github_api.issues

# Has a sideeffect of creating private key if one doesn't exist already
# Currently imported just for the sideeffect (not currently being used)
import encryption  # noqa: F401


class LessThanFilter(logging.Filter):
    """
    Source: https://stackoverflow.com/questions/2302315
    """
    def __init__(self, exclusive_maximum, name=""):
        super(LessThanFilter, self).__init__(name)
        self.max_level = exclusive_maximum

    def filter(self, record):
        """
        non-zero return means we log this message
        """
        return 1 if record.levelno < self.max_level else 0


def main():
    # Set up logging stuff
    logging_handler_out = logging.StreamHandler(sys.stdout)
    logging_handler_out.setLevel(settings.LOG_LEVEL_OUT)
    logging_handler_out.addFilter(LessThanFilter(settings.LOG_LEVEL_ERR))

    logging_handler_err = logging.StreamHandler(sys.stderr)
    logging_handler_err.setLevel(settings.LOG_LEVEL_ERR)

    logging.basicConfig(level=logging.NOTSET,
                        format='%(asctime)s %(name)-12s %(levelname)-8s %(message)s',
                        datefmt='%m-%d %H:%M',
                        handlers=[logging_handler_out, logging_handler_err])

    logging.getLogger("requests").propagate = False
    logging.getLogger("sh").propagate = False

    log = logging.getLogger("chaosbot")

    if exists("voters.json"):
        log.info("Moving voters.json to server directory!")
        shutil.move("./voters.json", "./server/voters.json")

    api = gh.API(settings.GITHUB_USER, settings.GITHUB_SECRET)

    log.info("checking if I crashed before...")

    # check if chaosbot is not on the tip of the master branch
    check_for_prev_crash(api, log)

    log.info("starting up and entering event loop")

    os.system("pkill uwsgi")

    subprocess.Popen(["/root/.virtualenvs/chaos/bin/uwsgi",
                      "--socket", "127.0.0.1:8085",
                      "--wsgi-file", "webserver.py",
                      "--callable", "__hug_wsgi__",
                      "--check-static", "/root/workspace/Chaos/server/",
                      "--daemonize", "/root/workspace/Chaos/log/uwsgi.log"])

    # Schedule all cron jobs to be run
    cron.schedule_jobs(api)

    log.info("Setting description to {desc}".format(desc=settings.REPO_DESCRIPTION))
    github_api.repos.set_desc(api, settings.URN, settings.REPO_DESCRIPTION)

    log.info("Ensure creation of issue/PR labels")
    for label, color in settings.REPO_LABELS.items():
        github_api.repos.create_label(api, settings.URN, label, color)

    while True:
        # Run any scheduled jobs on the next second.
        schedule.run_pending()
        time.sleep(1)


def check_for_prev_crash(api, log):
    """
    Check if Chaosbot is attempting a recovery from a failure. If it is, then
    read the failure file created by chaos_wrapper.sh and make a github issue
    for the failure.
    """
    if exists(settings.CHAOSBOT_FAILURE_FILE):
        with open(settings.CHAOSBOT_FAILURE_FILE, "r") as cff:
            log.info("it looks like I did... posting on github...")

            # read the failure file... the format is
            #
            #   FAILED_GIT_SHA CURRENT_GIT_SHA
            #
            # where FAILED_GIT_SHA is the one that crashed, and CURRENT_GIT_SHA
            # is the one currently running.
            failed, current = cff.readline().split(" ")

            # read the error log
            # Currently, I'm just reading the last 200 lines... which I think
            # ought to be enough, but if anyone has a better way to do this,
            # please do it.
            dump = subprocess.check_output(["tail", "-n", "200", settings.CHAOSBOT_STDERR_LOG])

            # Create a github issue for the problem
            title = "Help! I crashed! --CB"
            labels = ["crash report"]
            body = """
Oh no! I crashed!

Failed on SHA {failed}
Rolled back to SHA {current}

Error log:
```
{dump}
```
""".format(failed=failed, current=current, dump=bytes.decode(dump))

            gh.issues.create_issue(api, settings.URN, title, body, labels)

            # remove the error file
            os.remove(settings.CHAOSBOT_FAILURE_FILE)


if __name__ == "__main__":
    main()
