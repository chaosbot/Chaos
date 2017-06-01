#!/usr/bin/env python
# -*- coding: utf-8 -*-
import logging
import json
import sys
import time
import praw

log = logging.getLogger("chaosbot")
handler = logging.StreamHandler()
formatter = logging.Formatter(
        '%(asctime)s %(name)-12s %(levelname)-8s %(message)s')
handler.setFormatter(formatter)
log.addHandler(handler)
log.setLevel(logging.INFO)

'''Authenticated instance of Reddit'''
# --------------------------------------------------------------------
# https://praw.readthedocs.io/en/latest/getting_started/installation.html
# https://www.reddit.com/prefs/apps

try:
    with open("redditbot.config") as config_file:
        config = json.load(config_file)
except FileNotFoundError as ex:
    log.critical(ex)
    sys.exit(1)

reddit = praw.Reddit(
    user_agent='Chaosbot social experiment',
    client_id=config['client_id'],
    client_secret=config['client_secret'],
    username='chaosthebotreborn',
     password=config['password'])

subreddit = reddit.subreddit('chaosthebot')


already_replied = set()
try:
    with open("redditbot_replied.txt") as f:
        already_replied.update(f.readlines())
except FileNotFoundError:
    pass


def process_comment(comment):
    log.info("Processing comment id %s", comment.id)
    if comment.id not in already_replied and "hey chaosbot" in comment.body.lower():
        log.info("Attempting to reply to comment %s", comment.id)
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
        with open("redditbot_replied.txt", 'w') as f:
            for id in already_replied:
                f.write(id+"\n")

if __name__ == "__main__":
    main()
