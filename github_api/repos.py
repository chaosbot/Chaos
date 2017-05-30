import arrow
import settings

def get_path(urn):
    """ return the path for the repo """
    return "/repos/{urn}".format(urn=urn)


def get_num_watchers(api, urn):
    """ returns the number of watchers for a repo """
    data = api("get", get_path(urn))
    # this is the field for watchers.  do not be tricked by "watchers_count"
    # which always matches "stargazers_count"
    return data["subscribers_count"]


def set_desc(api, urn, desc):
    """ Set description and homepage of repo """
    path = get_path(urn)
    data = {
        "name": settings.GITHUB_REPO,
        "description": desc,
        "homepage": settings.HOMEPAGE,
    }
    api("patch", path, json=data)


def get_creation_date(api, urn):
    """ returns the creation date of the repo """
    data = api("get", get_path(urn))
    return arrow.get(data["created_at"])


def get_languages(api, urn):
    """ List languages for the specified repository. 
        The value on the right of a language is the 
        number of bytes of code written in that language. """
    return api("get", get_path(urn) + "/languages")