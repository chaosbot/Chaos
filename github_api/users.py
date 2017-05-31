
def get_user(api, user):
    path = "/users/{user}".format(user=user)
    return api("get", path)


def follow_user(api, user):
    follow_path = "/user/following/{user}".format(user=user)
    return api("PUT", follow_path)
