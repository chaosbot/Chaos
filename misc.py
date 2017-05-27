import sh
from urllib.parse import urlparse


def removeDotGit(url):
    """ Remove trailing `.git` from the git remote url """
    if url.endswith('.git'):
        return url[:-4]
    return url


def get_self_urn():
    """ determine the URN for the repo on github by looking at the remote named
    "origin", and parsing it, or using a sensible default.  this will allow
    local tests on a developer's fork """

    # remote is one of these:
    #  git@github.com:amoffat/chaos
    #  git@github.com:amoffat/chaos.git
    #  https://github.com/chaosbot/chaos
    #  https://github.com/chaosbot/chaos.git
    remote = removeDotGit(sh.git.config("--get", "remote.origin.url").strip())

    if remote:
        if remote.startswith("git@"):
            urn = remote.split(":")[1]
        else:
            parts = urlparse(remote)
            urn = parts.path[1:]

    # we're not in a git repo, or we have no remotes, so just assume a sensible
    # default
    else:
        urn = "chaosbot/chaos"

    return urn
