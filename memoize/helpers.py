import re
import json


def _time_code_to_seconds(code):
    """ converts a time code into actual seconds """
    try:
        seconds = int(code)
    except ValueError:
        match = re.match("(\d+)(d|s|m|h|w)", code, re.I)
        if not match:
            raise ValueError

        quant = int(match.group(1))
        scale = match.group(2).lower()

        lookup = {
            "s": 1,
            "m": 60,
            "h": 60 * 60,
            "d": 24 * 60 * 60,
            "w": 7 * 24 * 60 * 60,
        }
        seconds = quant * lookup[scale]
    return seconds


def _extract_args(sig_args, sig_defaults, args, kwargs, whitelist, blacklist):
    """ a memoize helper that takes values from a function's signature, the args
    and kwargs it was called with, and a whitelist and blacklist.  using those
    pieces, we return a mapping of arg name and values that the whitelist and
    blacklist allow for.  this is used when we only want to a subset of a
    function's arguments for memoizing """

    # this block creates our mapping from arg name to arg value.  once
    # we have that, we can start filtering out the args by name using
    # the whitelist or blacklist
    all_args = dict(zip(sig_args, args))
    all_args.update(kwargs)
    if sig_defaults:
        for i, defl in enumerate(sig_defaults):
            name = sig_args[-(i + 1)]
            all_args[name] = defl

    # now that we have our mapping of arg name to value, filter through it using
    # the whitelist or blacklist, if provided
    to_use = {}
    if whitelist is not None:
        for key in whitelist:
            val = all_args[key]
            to_use[key] = val

    elif blacklist is not None:
        for key, val in all_args.items():
            if key not in blacklist:
                to_use[key] = val

    else:
        to_use = all_args

    return to_use


def _json_keyify(args):
    """ converts arguments into a deterministic key used for memoizing """
    args = tuple(sorted(args.items(), key=lambda e: e[0]))
    return json.dumps(args)
