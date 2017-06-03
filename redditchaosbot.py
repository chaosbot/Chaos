#!/usr/bin/env python
# -*- coding: utf-8 -*-
import logging
import json
import sys
import time
from atomicwrites import atomic_write
import praw
from cryptography.fernet import Fernet
from symmetric_keys import KeyManager
from server.server import set_proc_name

set_proc_name("chaos_redditbot")
log = logging.getLogger("chaos_redditbot")
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
    with open("redditbot.config", 'rb') as config_file:
        with KeyManager() as key_manager:
            key = key_manager.get_key("redditchaosbot")
        fernet = Fernet(key)
        config = json.loads(fernet.decrypt(config_file.read()).decode('utf-8'))
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
replied_file = "redditbot_replied.json"
try:
    with open(replied_file) as f:
        already_replied.update(json.load(f)['already_replied'])
except:
    pass


def save_already_replied(replied_list):
    with atomic_write(replied_file, overwrite=True) as f:
        json.dump({'already_replied': list(replied_list)}, f)


def process_comment(comment):
    log.info("Processing comment id %s", comment.id)
    if comment.id not in already_replied and "hey chaosbot" in comment.body.lower():
        log.info("Attempting to reply to comment %s", comment.id)
        comment.reply("Hey {}!".format(comment.author.name))
        already_replied.add(comment.id)
        # Save every chance we get
        save_already_replied(already_replied)


def main():
    try:
        for comment in subreddit.stream.comments():
            try:
                process_comment(comment)
            except praw.exceptions.APIException:
                # Save every chance we get
                save_already_replied(already_replied)
                sleep_time = reddit.auth.limits['reset_timestamp'] - time.time()
                log.info("Sleeping for %d seconds", sleep_time)
                time.sleep(sleep_time)
    finally:
        save_already_replied(already_replied)
if __name__ == "__main__":
    main()
