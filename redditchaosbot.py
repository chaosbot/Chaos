import logging
import time
import praw


'''Authenticated instance of Reddit'''
# --------------------------------------------------------------------
# https://praw.readthedocs.io/en/latest/getting_started/installation.html
# https://www.reddit.com/prefs/apps
reddit = praw.Reddit(
    user_agent='Chaosbot social experiment',
    client_id='WbDSRDEenyFRYw',
    client_secret="CzAcNHiH91NM6baL1ypzQnkyFG8",
    username='chaosthebotreborn',
     password='9ws#?&+@3YBHLB~iVH,;5:rRr]@<,tW]J(n]t#`dZ;a7ZbsqJVny)(2yUO3d5d}VjW=L.U7aS4*E<-6x&WE$qa6>#{\Z\d]N-}T7')

subreddit = reddit.subreddit('chaosthebot')
log = logging.getLogger("chaosbot")
handler = logging.StreamHandler()
formatter = logging.Formatter(
        '%(asctime)s %(name)-12s %(levelname)-8s %(message)s')
handler.setFormatter(formatter)
log.addHandler(handler)
log.setLevel(logging.INFO)


already_replied = set()
try:
    with open("redditbot_replied.txt") as f:
        already_replied.update(f.readlines())
except FileNotFoundError:
    pass


def process_comment(comment):
    log.info("Processing comment id %s", comment.id)
    if comment.id not in already_replied and "hey chaosbot" in comment.body.lower():
        comment.reply("Hey {}!".format(comment.author.name))
        already_replied.add(comment.id)


def main():
    try:
        for comment in subreddit.stream.comments():
            try:
                process_comment(comment)
            except praw.exceptions.APIException as ex:
                sleep_time = reddit.auth.limits['reset_timestamp'] - time.time()
                log.info("Sleeping for %d seconds", sleep_time)
                time.sleep(sleep_time)
    finally:
        with open("redditbot_replied.txt", 'a') as f:
            for id in already_replied:
                f.write(id+"\n")

if __name__ == "__main__":
    main()
