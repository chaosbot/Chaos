import hug
import json
import linecache
import logging
from http import server


__log = logging.getLogger("webserver")
responses = server.BaseHTTPRequestHandler.responses

index_content = open("/root/workspace/Chaos/server/index.html", "r").read()
errorpage_content = open("/root/workspace/Chaos/server/error.html", "r").read()


@hug.get("/", output=hug.output_format.html)
def render_index():
    return index_content


@hug.get("/api/errorpage", output=hug.output_format.html)
def render_error(code: hug.types.number = 500):
    status = responses[code]
    return errorpage_content % {
        "code": code,
        "message": status[0],
        "explain": status[1]
    }


@hug.get("/api/voters", examples=["amount=20", "amount=0"])
def get_voters(amount: hug.types.number = 20):
    try:
        voters = sorted(json.loads(
            linecache.getline("/root/workspace/Chaos/server/voters.json", 1)).items(),
            key=lambda x: x[1], reverse=True)
        if amount > 0:
            voters = voters[:amount]
        return {x[0]: x[1] for x in voters}
    except:
        __log.exception("Failed to read voters!")


@hug.get("/api/meritocracy", examples=["amount=5", "amount=0"])
def get_meritocracy(amount: hug.types.number = 20):
    try:
        meritocracy = json.loads(
            linecache.getline("/root/workspace/Chaos/server/meritocracy.json", 1))
        if amount > 0:
            meritocracy = meritocracy[:amount]
        return meritocracy
    except:
        __log.exception("Failed to read meritocracy!")
