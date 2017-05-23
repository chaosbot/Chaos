from os.path import exists, abspath, dirname, join
THIS_DIR = dirname(abspath(__file__))

# this is a personal access token used by chaosbot to perform merges and other
# api requests.  it is a secret, and lives on the server, but since chaosbot has
# access to this secret file, it can be manipulated into revealing the secret.
# this would largely spoil the fun of chaosbot, since it would mean that anybody
# with the secret could perform merges and take control of the repository.
# please play nice and please don't make chaosbot reveal this secret.  and
# please reject PRs that attempt to reveal it :)

# a shim for moving the github pat secret out of the current dir, this way
# features like https://github.com/chaosbot/chaos/pull/10 can be used
pat_fname = "github_pat.secret"
old_pat = join(THIS_DIR, pat_fname)
new_pat = join("/etc", pat_fname)
abs_pat_file = new_pat if exists(new_pat) else old_pat

with open(abs_pat_file) as h:
    GITHUB_SECRET = h.read().strip()

GITHUB_USER = "chaosbot"

# TEST SETTING PLEASE IGNORE
TEST = False 

# the amount of time chaosbot should sleep between polling for ready prs
SLEEP_TIME = 30

# the scaling factor for how big voting windows are
VOTE_WINDOW_SCALE = 1.0

OWNER = "chaosbot"
PROJECT = "Chaos"
URN = OWNER + "/" + PROJECT

# voter controls below
## how old do they have to be for their vote to count?
MIN_VOTER_AGE = 1 * 30 * 24 * 60 * 60 # 1 month
## at what follower count does a voter's social weight become 1.0?
FOLLOWER_LOG_BASE = 15

# for a pr to be merged, the vote total must have at least this fraction of the
# number of watchers in order to pass.  this is to prevent early manipulation of
# the project by requiring some basic consensus.  i'm not sure its necessary, so
# it's 0
MIN_VOTE_WATCHERS = 0

# unauthenticated api requests get 60 requests/hr, so we need to get as much
# data from each request as we can.  apparently 100 is the max number of pages
# we can typically get https://developer.github.com/v3/#pagination
DEFAULT_PAGINATION = 100

# the directory, relative to the project directory, where memoize cache files will
# be stored
MEMOIZE_CACHE_DIRNAME = "api_cache"

# used for calculating how long our voting window is
TIMEZONE = "US/Pacific"
