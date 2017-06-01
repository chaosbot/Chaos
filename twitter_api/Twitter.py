import twitter

import misc


def PostTwitter(message):
    if len(message) > 140:
        print('Post has more of 140 chars')
        return 1
    keys = misc.GetKeys()
    api = twitter.Api(consumer_key=str(keys['consumer_key']),
                      consumer_secret=str(keys['consumer_secret']),
                      access_token_key=str(keys['access_token']),
                      access_token_secret=str(keys['access_secret']))
    api.PostUpdate(message)
    return 0
