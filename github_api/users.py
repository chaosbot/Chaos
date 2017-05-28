
def get_user(api, user):
    path = "/users/{user}".format(user=user)
    return api("get", path)


def follow_user(api, user):
    follow_path = "/user/following/{user}".format(user=user)
    return api("PUT", follow_path)


def set_blocklist(api, blocklist):
    # allows access to blocking APIs
    headers = {"accept": "application/vnd.github.giant-sentry-fist-preview+json"}
    blocklist = [user.strip().lower() for user in blocklist]
    blocked = [user["login"].lower() for user in api("get", "/user/blocks", headers=headers)]
    for user in blocklist:
        if user:
            if user not in blocked:
                api("put", "/user/blocks/{user}".format(user=user), headers=headers)
