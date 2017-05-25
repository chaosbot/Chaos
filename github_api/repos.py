
def get_num_watchers(api, urn):
    """ returns the number of watchers for a repo """
    path = "/repos/{urn}".format(urn=urn)
    data = api("get", path)
    # this is the field for watchers.  do not be tricked by "watchers_count"
    # which always matches "stargazers_count"
    return data["subscribers_count"]

