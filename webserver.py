import hug
import json
import linecache
import logging


__log = logging.getLogger("webserver")


@hug.get("/voters", examples=["amount=20", "amount=0"])
def get_voters(amount: hug.types.number = 20):
    try:
        voters = sorted(json.loads(
            linecache.getline("/root/workspace/Chaos/server/voters.json", 1)).items(),
            key=lambda x: x[1])
        if amount > 0:
            voters = voters[:amount]
        return {x[0]: x[1] for x in voters}
    except:
        __log.exception("Failed to read voters!")


@hug.get("/meritocracy", examples=["amount=5", "amount=0"])
def get_meritocracy(amount: hug.types.number = 20):
    try:
        meritocracy = json.loads(
            linecache.getline("/root/workspace/Chaos/server/meritocracy.json", 1))
        if amount > 0:
            meritocracy = meritocracy[:amount]
        return meritocracy
    except:
        __log.exception("Failed to read meritocracy!")
