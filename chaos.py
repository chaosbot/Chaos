#!/usr/bin/env python
# -*- coding: utf-8 -*-

import time
import os
import sys
import logging
import threading
import http.server
import random
import subprocess
import settings
import patch
import schedule

from os.path import dirname, abspath, join

import cron
import github_api as gh
import github_api.prs
import github_api.voting
import github_api.repos
import github_api.comments

# Has a sideeffect of creating private key if one doesn't exist already
import encryption

from github_api import exceptions as gh_exc


class HTTPServerRequestHandler(http.server.BaseHTTPRequestHandler):

    def __init__(self):
        # Load fortunes
        self.fortunes = []
        with open("data/fortunes.txt", "r", encoding="utf8") as f:
            self.fortunes = f.read().split("\n%\n")
        # Call superclass constructor
        super(HTTPServerRequestHandler, self).__init__()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.end_headers()

        self.wfile.write(random.choice(self.fortunes).encode("utf8"))

def http_server():
    s = http.server.HTTPServer(('', 8080), HTTPServerRequestHandler)
    s.serve_forever()


def start_http_server():
    http_server_thread = threading.Thread(target=http_server)
    http_server_thread.start()

def main():
    logging.basicConfig(level=logging.DEBUG,
                            format='%(asctime)s %(name)-12s %(levelname)-8s %(message)s',
                            datefmt='%m-%d %H:%M')
    logging.getLogger("requests").propagate = False
    logging.getLogger("sh").propagate = False

    log = logging.getLogger("chaosbot")

    api = gh.API(settings.GITHUB_USER, settings.GITHUB_SECRET)

    log.info("starting up and entering event loop")

    os.system("pkill chaos_server")

    server_dir = join(dirname(abspath(__file__)), "server")
    subprocess.Popen([sys.executable, "server.py"], cwd=server_dir)

    #log.info("starting http server")
    #start_http_server()

    # Schedule all cron jobs to be run
    cron.schedule_jobs()

    while True:
        # Run any scheduled jobs on the next second.
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()
