def PostTwitter(message, api_twitter):
    if len(message) > 140:
        print('Post has more of 140 chars')
        return 1
    api = api_twitter
    api.PostUpdate(message)
    return 0
