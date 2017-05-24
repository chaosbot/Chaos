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

from github_api import exceptions as gh_exc


# TODO: HTTP server has been fixed to serve static content, I'm not a python dev so unsure how to incorporate fortunes.
# TODO: Should this fortune code be removed and use static content moving forward?
class HTTPServerRequestHandler(http.server.BaseHTTPRequestHandler):

    def __init__(self):
        # Load fortunes
        self.fortunes = []
        with open("fortunes.txt", "r", encoding="utf8") as f:
            self.fortunes = f.read().split("\n%\n")

        # Call superclass constructor
        super(HTTPServerRequestHandler, self).__init__()

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/html; charset=utf-8")
        self.end_headers()

        self.wfile.write(random.choice(self.fortunes).encode("utf8"))

# TODO: See comment above.
def http_server():
    s = http.server.HTTPServer(('', 8080), HTTPServerRequestHandler)
    s.serve_forever()

# TODO: See comment above.
def start_http_server():
    http_server_thread = threading.Thread(target=http_server)
    http_server_thread.start()

def main():
    logging.basicConfig(level=logging.DEBUG)
    logging.getLogger("requests").propagate = False
    logging.getLogger("sh").propagate = False

    log = logging.getLogger("chaosbot")

    log.info("starting up and entering event loop")

    # TODO: I know this is probably hideous but, again, I'm not a python dev :(
    log.info("starting http server")
    os.chdir(THIS_DIR + "/public")
    Handler = http.server.SimpleHTTPRequestHandler
    httpd = socketserver.TCPServer(("", 80), Handler)
    httpd.serve_forever()

    # Schedule all cron jobs to be run
    cron.schedule_jobs()

    while True:
        # Run any scheduled jobs on the next second.
        schedule.run_pending()
        time.sleep(1)

if __name__ == "__main__":
    main()
