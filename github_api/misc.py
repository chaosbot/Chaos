from math import log


def dt_to_github_dt(dt):
    return dt.isoformat() + "Z"


def seconds_to_human(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return "%d:%02d" % (h, m)


def dynamic_voting_window(x, lbound, ubound):
    """ determine the number of hours for the voting window
    based on the number of day since the project start
    return between a lower and upper bound """

    # current settings reaches ubound in ~50 days (x=50)
    multiplier = 21
    log_base = 2

    return min(log(max(x * multiplier, 1), log_base) + lbound, ubound)
