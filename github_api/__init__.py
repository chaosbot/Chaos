import time
import re
import math
import requests
from requests.auth import HTTPBasicAuth
import logging
import settings

from . import comments
from . import exceptions
from . import issues
from . import misc
from . import prs
from . import repos
from . import users
from . import voting

__all__ = ["comments", "exceptions", "issues", "misc", "prs", "repos", "users", "voting"]

log = logging.getLogger("github_api")


def compute_api_cooldown(remaining, reset):
    """ remaining is the number of api requests, reset is the amount of time
    until our api call counter gets refreshed.  it returns a number of seconds
    to sleep before an api call.  this yields a nice curve where we'll spend
    more time waiting as we have fewer api calls left, and less time weighting
    if our refresh time is sooner.  graph it """

    # i've seen github's api fail with a 403 when we had 5 requests remaining,
    # as confirmed by their response headers.  so we'll take that kind of
    # fluctuation into account.
    #
    # also account for a potential divide by zero
    actual_remaining = max(remaining - 30, 1)

    cooldown = ((reset / actual_remaining) ** 3) / 10.0

    # it doesn't make sense to ever sleep longer than the point where github
    # refreshes our api counter, but let's also pad that value a little bit
    cooldown = min(reset + settings.API_COOLDOWN_RESET_PADDING, cooldown)

    return cooldown


class API(object):
    """ our github api class.  very simple, an instance of this class behaves
    like a function which does rate limiting.  see __call__ for the general
    usage """

    BASE_URL = "https://api.github.com"
    BASE_HEADERS = {
        # "Accept": "application/vnd.github.v3+json"
        # so we have access to the reactions api
        "Accept": "application/vnd.github.squirrel-girl-preview+json"
    }

    def __init__(self, user, pat):
        self._auth = HTTPBasicAuth(user, pat)
        self._remaining = math.inf
        self._reset = 0

    def __call__(self, method, path, **kwargs):
        # sleep for a cooldown period, so we don't exhaust our api requests in
        # the middle of doing something important
        now = time.time()
        reset_in = max(self._reset - now, 0)
        cooldown = compute_api_cooldown(self._remaining, reset_in)
        log.debug("requests remaining: %s, reset in: %ds, cooldown sleep: %0.2fs",
                  self._remaining, reset_in, cooldown)
        time.sleep(cooldown)

        url = self.BASE_URL + path
        if re.match("https?://", path):
            url = path

        headers = self.BASE_HEADERS.copy()

        log.info("requesting %s to %r", method.upper(), path)
        resp = requests.request(method, url, headers=headers, auth=self._auth,
                                **kwargs)

        h = resp.headers

        # keep our rate limit details up-to-date
        try:
            self._remaining = int(h["X-RateLimit-Remaining"])
            self._reset = int(h["X-RateLimit-Reset"])
        # on error, we won't receive these headers
        except KeyError:
            pass

        resp.raise_for_status()

        # wait 5 seconds, then retry request due to 202 status code
        if resp.status_code == 202:
            time.sleep(5)
            return self.__call__(method, path, **kwargs)

        # not all requests return json, and this will raise for those
        try:
            data = resp.json()
        except:
            data = None

        return data
