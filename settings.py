from os.path import exists, abspath, dirname, join
import misc


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

with open(_pat_file, "r") as h:
    GITHUB_SECRET = h.read().strip()

# unique globally accessible name for the repo on github.  typically looks like
# "chaosbot/chaos"
URN = misc.get_self_urn()
GITHUB_USER, GITHUB_REPO = URN.split("/")

# TEST SETTING PLEASE IGNORE
TEST = False

# the number of seconds chaosbot should sleep between polling for ready prs
PULL_REQUEST_POLLING_INTERVAL_SECONDS = 60 * 2

# The default number of hours for how large the voting window is
DEFAULT_VOTE_WINDOW = 2.0

# The number of hours for how large the voting window is in the "after hours"
AFTER_HOURS_VOTE_WINDOW = 3.0

# The hour (in the server time zone) when the after hours start
AFTER_HOURS_START = 22

# The hour when the after hours end
AFTER_HOURS_END = 10

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

# PRs that have merge conflicts and haven't been touched in this many hours
# will be closed
PR_STALE_HOURS = 24
