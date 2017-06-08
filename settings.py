from os.path import abspath, dirname, exists, join

import misc
import logging


THIS_DIR = dirname(abspath(__file__))

# this is a personal access token used by chaosbot to perform merges and other
# api requests.  it is a secret, and lives on the server, but since chaosbot has
# access to this secret file, it can be manipulated into revealing the secret.
# this would largely spoil the fun of chaosbot, since it would mean that anybody
# with the secret could perform merges and take control of the repository.
# please play nice and please don't make chaosbot reveal this secret.  and
# please reject PRs that attempt to reveal it :)
_pat_name = "github_pat.secret"

# look for local PAT first
_pat_file = join(THIS_DIR, _pat_name)

# otherwise fall back to system pat
if not exists(_pat_file):
    _pat_file = join("/etc/", _pat_name)

if exists(_pat_file):
    with open(_pat_file, "r") as h:
        GITHUB_SECRET = h.read().strip()
else:
    GITHUB_SECRET = None

# unique globally accessible name for the repo on github.  typically looks like
# "chaosbot/chaos"
URN = misc.get_self_urn()
GITHUB_USER, GITHUB_REPO = URN.split("/")

# if we are running in production
# if we switch to an org this will need changing
IN_PRODUCTION = GITHUB_USER == "chaosbot"

HOMEPAGE = "http://chaosthebot.com"

# TEST SETTING PLEASE IGNORE
TEST = False

# How much logging should we do? Pick a log level for stdout and stderr.
# Log levels are (in order) DEBUG, INFO, WARNING, ERROR, CRITICAL
# stdout gets everything from LOG_LEVEL_OUT to (but not including) LOG_LEVEL_ERR
# stderr gets the rest (any higher levels go here)
LOG_LEVEL_OUT = logging.INFO
LOG_LEVEL_ERR = logging.WARNING

# the number of seconds chaosbot should sleep between polling for ready prs
PULL_REQUEST_POLLING_INTERVAL_SECONDS = 30
ISSUE_COMMENT_POLLING_INTERVAL_SECONDS = 60 * 10  # 10 min interval on polling comments
ISSUE_CLOSE_STALE_INTERVAL_SECONDS = 60 * 60 * 2  # 2 hour interval on polling issues

# The default number of hours for how large the voting window is
DEFAULT_VOTE_WINDOW = 3.0

# The maximum number of hours for how large the voting window is (extended window)
EXTENDED_VOTE_WINDOW = 8.0

# how old do voters have to be for their vote to count?
MIN_VOTER_AGE = 1 * 30 * 24 * 60 * 60  # 1 month

# for a pr to be merged, the vote total must have at least this fraction of the
# number of watchers in order to pass.  this is to prevent early manipulation of
# the project by requiring some basic consensus.
MIN_VOTE_WATCHERS = 0.05

# unauthenticated api requests get 60 requests/hr, so we need to get as much
# data from each request as we can.  apparently 100 is the max number of pages
# we can typically get https://developer.github.com/v3/#pagination
DEFAULT_PAGINATION = 100

# the directory, relative to the project directory, where memoize cache files will
# be stored
MEMOIZE_CACHE_DIRNAME = "api_cache"

# used for calculating how long our voting window is
TIMEZONE = "US/Pacific"


# repo description
with open("description.txt", "r") as h:
    REPO_DESCRIPTION = h.read().strip()

# repo labels
REPO_LABELS = {
    "accepted": "0e8a16",
    "rejected": "ededed",
    "conflicts": "fbca04",
    "mergeable": "dddddd",
    "can't merge": "ededed",
    "ci failed": "ff9800",
    "crash report": "ff0000"
}

# PRs that have merge conflicts and haven't been touched in this many hours
# will be closed
PR_STALE_HOURS = 36

API_COOLDOWN_RESET_PADDING = 30

# The name of the file created upon failures -- also found in chaos_wrapper.py
# If you are going to change it, change it there too.
CHAOSBOT_FAILURE_FILE = "/tmp/chaosbot_failed"

# The location of error log -- also found in the supervisor conf.
# If you are going to change it, change it there too.
CHAOSBOT_STDERR_LOG = join(THIS_DIR, "log/supervisor-stderr.log")

# The threshold for how old an issue has to be without comments before we try to
# auto-close it. i.e. if an issue goes this long without comments
ISSUE_STALE_THRESHOLD = 60 * 60 * 24 * 3  # 3 days

# The top n contributors will be allowed in the meritocracy
MERITOCRACY_TOP_CONTRIBUTORS = 10

# The top n voters will be allowed in the meritocracy
MERITOCRACY_TOP_VOTERS = 10

# These users are not allowed in the meritorcracy through being a top voter
MERITOCRACY_VOTERS_BLACKLIST = {"e-beach"}
# Make sure usernames are lowercased
MERITOCRACY_VOTERS_BLACKLIST = {user.lower() for user in MERITOCRACY_VOTERS_BLACKLIST}

# Database settings
DB_ADAPTER = "sqlite"
DB_CONFIG = {
    "filename": "db.sqlite"
}
# MySQL example
# DB_CONFIG = {
#     "host ": "localhost",
#     "user ": "chaos",
#     "password ": "chaos",
#     "db ": "db"
# }
