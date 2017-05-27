
def dt_to_github_dt(dt):
    return dt.isoformat() + "Z"


def seconds_to_human(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return "%d:%02d" % (h, m)


def dynamic_voting_window(x, lower):
    """ determine the number of hours for the voting window
    based on the number of day since the project start 
    return between lower and 9, the value on the 16th day"""

    if x < 3:
        return lower
    elif x < 8:
        return lower + 0.2 * (x - 2)
    elif x < 13:
        return lower + 1 + 0.4 * (x - 7)
    elif x < 16:
        return lower + 3 + (x - 12) * (0.5 + (0.1 * (x - 13)))
    else:
        return 9
