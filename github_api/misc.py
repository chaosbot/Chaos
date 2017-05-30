from math import exp


def dt_to_github_dt(dt):
    return dt.isoformat() + "Z"


def seconds_to_human(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return "%d:%02d" % (h, m)


def dynamic_voting_window(x, lbound, ubound):
    """ Determine the number of hours for the voting window
    based on the number of day since the project start
    return between a lower and upper bound using sigmoid function.
    Sigmoid functions never reach their upper bound.
    With current settings it will "almost" reach ubound in ~60 days (x=60)"""

    # to make curve more flat
    modified_x = x / 12

    # calculate parameters
    difference = ubound - lbound
    param_a = difference * 2
    param_b = lbound - difference

    # calculate sigmoid function
    sigmoid = 1 / (exp(-modified_x) + 1)

    return param_a * sigmoid + param_b
