
def dt_to_github_dt(dt):
    return dt.isoformat() + "Z"

def seconds_to_human(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return "%d:%02d" % (h, m)
