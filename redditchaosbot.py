import praw
from praw.models import MoreComments
import pprint


'''Authenticated instance of Reddit'''
# --------------------------------------------------------------------
# https://praw.readthedocs.io/en/latest/getting_started/installation.html
# https://www.reddit.com/prefs/apps
reddit = praw.Reddit(user_agent='Chaosbot social experiment',
                     client_id='KbKcHMguzNRKUw', client_secret="n-2lxQYOKtJinlJUWJr_Zv7g1rw",
                     username='redditchaosbot', password='cha0sb0t')

reddit.read_only = True

submission = reddit.submission(id='6criij')
subreddit = reddit.subreddit('programming')
# --------------------------------------------------------------------


'''WHAT ARE PEOPLE SAYING ABOUT CHAOSBOT?'''
# --------------------------------------------------------------------
# in reddit thread: https://goo.gl/5ETNmF
submission.comment_sort = 'new'
top_level_comments = list(submission.comments)
newcom = top_level_comments[1]
print(newcom.body)



'''FIND COMMENTS ABOUT CHAOS'''
# --------------------------------------------------------------------
# TBD
# for comment in reddit.subreddit('programming').comments(limit=5):
# import pdb; pdb.set_trace()
