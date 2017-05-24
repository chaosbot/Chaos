import logging
import praw
from praw.models import MoreComments


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


def process_submission(submission):
    log.info("Processing", submission.title)
    for comment in submission.comments:
        if "hey chaosbot" in comment.body.lower():
            comment.reply("Hey {}!".format(comment.author.name))


for submission in subreddit.stream.submissions():
    process_submission(submission)
