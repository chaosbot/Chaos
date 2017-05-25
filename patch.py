"""
inject some memoize caching into our github api functions.  we're keeping the
caching layer separate from the api layer by doing it this way
"""

from os.path import dirname, abspath, join
from functools import partial
import inspect

from memoize import memoize
from memoize.backends import json_backend

import github_api.voting
import github_api.repos

import settings


THIS_DIR = dirname(abspath(__file__))

api_backend = json_backend(join(THIS_DIR, settings.MEMOIZE_CACHE_DIRNAME))

# here we're creating a specialized memoize decorator that ignores the "api"
# argument in a function when constructing the memoize key.  we do this because
# "api" is a resource that should not be considered as part of the memoize
# key
api_memoize = partial(memoize, blacklist={"api"}, backend=api_backend)

# a helper for monkey-patch-decorating functions in different modules
def decorate(fn, dec):
    mod = inspect.getmodule(fn)
    new_fn = dec(fn)
    setattr(mod, fn.__name__, new_fn)

# now let's memoize some very frequent api calls that don't change often
decorate(github_api.voting.get_vote_weight, api_memoize("1d"))
decorate(github_api.repos.get_num_watchers, api_memoize("10m"))
decorate(github_api.prs.get_is_mergeable, api_memoize("2m"))


