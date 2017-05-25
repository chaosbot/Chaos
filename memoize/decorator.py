from functools import wraps
import time
import inspect

from . import helpers


def memoize(ttl_spec, whitelist=None, blacklist=None,
            key_fn=helpers._json_keyify, backend=lambda fn: dict(),
            get_now=time.time):
    """ memoize/cache the decorated function for ttl amount of time """

    ttl = helpers._time_code_to_seconds(ttl_spec)

    def wrapper(fn):
        sig = inspect.getfullargspec(fn)
        cache = backend(fn)

        @wraps(fn)
        def wrapper2(*args, **kwargs):
            # extract the arg names and values to use in our memoize key
            to_use = helpers._extract_args(sig.args, sig.defaults, args, kwargs,
                                           whitelist, blacklist)

            # and construct our memoize key
            key = key_fn(to_use)

            now = get_now()
            needs_refresh = True

            # we have a cached value already, let's check if it's old and needs
            # to be refreshed
            if key in cache:
                inserted, res = cache[key]
                needs_refresh = now - inserted > ttl

            # if it's old, re-call the decorated function and re-cache the
            # result with a new timestamp
            if needs_refresh:
                res = fn(*args, **kwargs)
                cache[key] = (now, res)

            return res
        return wrapper2

    return wrapper
