#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
Inject some memoize caching into our github api functions.
We're keeping the caching layer separate from the api layer by doing it this way.
"""

import inspect
import settings
from os.path import dirname, abspath, join
from functools import partial
from memoize import memoize
from memoize.backends import json_backend
import github_api.voting
import github_api.repos


def decorate(fn, dec):
    """helper for monkey-patch-decorating functions in different modules"""
    mod = inspect.getmodule(fn)
    new_fn = dec(fn)
    setattr(mod, fn.__name__, new_fn)


cache_dir = join(dirname(abspath(__file__)), settings.MEMOIZE_CACHE_DIRNAME)
api_memoize = partial(memoize, blacklist={"api"}, backend=json_backend(cache_dir))

# now let's memoize some very frequent api calls that don't change often
decorate(github_api.voting.get_vote_weight, api_memoize("1d"))
decorate(github_api.repos.get_num_watchers, api_memoize("10m"))
decorate(github_api.prs.get_is_mergeable, api_memoize("2m"))
decorate(github_api.repos.get_contributors, api_memoize("1d"))
