
def get_user(api, user):
    path = "/users/{user}".format(user=user)
    data = api("get", path)
    return data

def follow_user(api, user):
    follow_path = "/user/following/{user}".format(user=user)
    follow_resp = api("PUT", follow_path)
