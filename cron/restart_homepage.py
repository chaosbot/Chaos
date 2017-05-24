import logging
import os
import requests

__log = logging.getLogger("chaosbot")

def restart_homepage():
    """Restarts ChaosBot if the web server appears to be broken"""

    __log.info("Checking if the homepage is responding")

    html = requests.get("http://chaosthebot.com/").text

    if "ChaosBot" in html:
        __log.info("The server is working as usual, no restart necessary")
    else:
        __log.info("The server doesn't appear to be working, initiating restart sequence")
        startup_path = join(dirname(__file__), "startup.sh")
        os.execl(startup_path, startup_path)
