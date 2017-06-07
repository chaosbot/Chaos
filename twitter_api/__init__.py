import misc
import twitter


__all__ = ["misc", "twitter"]


class API_TWITTER():
    def __init__(self, path):
        self.__twitter_keys = misc.GetKeys(path)
        self.__api = twitter.Api(consumer_key=str(self.__twitter_keys['consumer_key']),
                                 consumer_secret=str(self.__twitter_keys['consumer_secret']),
                                 access_token_key=str(self.__twitter_keys['access_token']),
                                 access_token_secret=str(self.__twitter_keys['access_secret']))

    def GetApi(self):
        return self.__api
