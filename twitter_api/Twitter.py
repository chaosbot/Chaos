import logging

log = logging.getLogger("twitter")


def PostTwitter(message, api_twitter):
    if len(message) > 140:
        print('Post has more of 140 chars')
    api = api_twitter
    try:
        api.PostUpdate(message)
    except:
        log.exception("Failed to post to Twitter")
    return 0
