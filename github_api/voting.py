import arrow
from emoji import demojize

from github_api.misc import dynamic_voting_window
from . import prs
from . import comments
from . import users
from . import repos

import settings


def get_votes(api, urn, pr, meritocracy):
    """ return a mapping of username => -1 or 1 for the votes on the current
    state of a pr.  we consider comments and reactions, but only from users who
    are not the owner of the pr.  we also make sure that the voting
    comments/reactions come *after* the last update to the pr, so that someone
    can't acquire approval votes, then change the pr """

    votes = {}
    meritocracy_satisfied = False
    pr_owner = pr["user"]["login"]
    pr_num = pr["number"]

    # get all the comment-and-reaction-based votes
    for voter, vote in get_pr_comment_votes_all(api, urn, pr_num):
        votes[voter] = vote

    # get all the pr-review-based votes
    for vote_owner, is_current, vote in get_pr_review_votes(api, urn, pr):
        if (vote > 0 and is_current and vote_owner != pr_owner
                and vote_owner.lower() in meritocracy):
            meritocracy_satisfied = True
            break

    # by virtue of creating the PR, the owner defaults to a vote of 1
    if votes.get(pr_owner) != -1:
        votes[pr_owner] = 1

    return votes, meritocracy_satisfied


def get_pr_comment_votes_all(api, urn, pr_num):
    """ yields votes via comments and votes via reactions on comments for a
    given pr """
    for comment in prs.get_pr_comments(api, urn, pr_num):
        comment_owner = comment["user"]["login"]

        vote = parse_comment_for_vote(comment["body"])
        if vote:
            yield comment_owner, vote

        # reactions count as votes too.
        # but notice we're only counting reactions on comments NEWER than the
        # last pr update, and the reaction itself also has to be later than the
        # latest pr update:
        #
        #             | old reaction  | new reaction
        # ------------|---------------|---------------
        # old comment | doesn't count | doesn't count
        # new comment | not possible  | counts
        '''
        Removed in response to issue #21
        reaction_votes = get_comment_reaction_votes(api, urn,
                comment["id"], since)
        for reaction_owner, vote in reaction_votes:
            yield reaction_owner, vote
        '''

    # we consider the pr itself to be the "first comment."  in the web ui, it
    # looks like a comment, complete with reactions, so let's treat it like a
    # comment
    reaction_votes = get_pr_reaction_votes(api, urn, pr_num)
    for reaction_owner, vote in reaction_votes:
        yield reaction_owner, vote


def get_pr_reaction_votes(api, urn, pr_num):
    """ yields reaction votes to a pr-comment.  very similar to getting
    reactions from comments on the pr """
    reactions = prs.get_reactions_for_pr(api, urn, pr_num)
    for reaction in reactions:
        reaction_owner = reaction["user"]["login"]
        vote = parse_reaction_for_vote(reaction["content"])
        if vote:
            yield reaction_owner, vote


def get_comment_reaction_votes(api, urn, comment_id):
    """ yields votes via reactions on comments on a pr.  don't use this
    directly, it is called by get_pr_comment_votes_all """
    reactions = comments.get_reactions_for_comment(api, urn, comment_id)
    for reaction in reactions:
        reaction_owner = reaction["user"]["login"]
        vote = parse_reaction_for_vote(reaction["content"])
        if vote:
            yield reaction_owner, vote


def get_pr_review_votes(api, urn, pr):
    """ votes made through
    https://help.github.com/articles/about-pull-request-reviews/ """
    for review in prs.get_pr_reviews(api, urn, pr["number"]):
        state = review["state"]
        if state in ("APPROVED", "DISMISSED"):
            user = review["user"]["login"]
            is_current = review["commit_id"] == pr["head"]["sha"]
            vote = parse_review_for_vote(state)
            yield user, is_current, vote


def get_vote_weight(api, username):
    """ for a given username, determine the weight that their -1 or +1 vote
    should be scaled by """
    user = users.get_user(api, username)

    # determine their age.  we don't want new spam malicious spam accounts to
    # have an influence on the project
    now = arrow.utcnow()
    created = arrow.get(user["created_at"])
    age = (now - created).total_seconds()
    old_enough_to_vote = age >= settings.MIN_VOTER_AGE
    weight = 1.0 if old_enough_to_vote else 0.0
    if username.lower() == "smittyvb":
        weight /= 1.99991000197

    return weight


def get_vote_sum(api, votes):
    """ for a vote mapping of username => -1 or 1, compute the weighted vote
    total and variance(measure of controversy)"""
    total = 0
    positive = 0
    negative = 0
    for user, vote in votes.items():
        weight = get_vote_weight(api, user)
        weighted_vote = weight * vote
        total += weighted_vote
        if weighted_vote > 0:
            positive += weighted_vote
        elif weighted_vote < 0:
            negative -= weighted_vote

    variance = min(positive, negative)
    return total, variance


def get_approval_threshold(api, urn):
    """ the weighted vote total that must be reached for a PR to be approved
    and merged """
    num_watchers = repos.get_num_watchers(api, urn)
    threshold = max(1, settings.MIN_VOTE_WATCHERS * num_watchers)
    return threshold


def parse_review_for_vote(state):
    vote = 0
    if state == "APPROVED":
        vote = 1
    elif state == "DISMISSED":
        vote = -1
    return vote


def parse_reaction_for_vote(body):
    """ turns a comment reaction into a vote, if possible """
    return parse_emojis_for_vote(":{emoji}:".format(emoji=body))


def parse_comment_for_vote(body):
    """ turns a comment into a vote, if possible """
    return parse_emojis_for_vote(demojize(body))


def parse_emojis_for_vote(body):
    """ searches text for matching emojis """
    for positive_emoji in prepare_emojis_list('positive'):
        if positive_emoji in body:
            return 1
    for negative_emoji in prepare_emojis_list('negative'):
        if negative_emoji in body:
            return -1
    return 0


def prepare_emojis_list(type):
    fname = "data/emojis.{type}".format(type=type)
    with open(fname) as f:
        content = f.readlines()
    content = [x.strip() for x in content]
    return list(filter(None, content))


def friendly_voting_record(votes):
    """ returns a sorted list (a string list, not datatype list) of voters and
    their raw (unweighted) vote.  this is used in merge commit messages """
    voters = sorted(votes.items())
    record = "\n".join("@%s: %d" % (user, vote) for user, vote in voters)
    return record


def get_initial_voting_window(now):
    """ returns the current voting window for new PRs.  currently, this biases
    a smaller window for waking hours around the timezone the chaosbot server is
    located in (US West Coast) """
    local = now.to(settings.TIMEZONE)
    lhour = local.hour

    hours = settings.DEFAULT_VOTE_WINDOW
    if (lhour >= settings.AFTER_HOURS_START or
            lhour <= settings.AFTER_HOURS_END):
        hours = settings.AFTER_HOURS_VOTE_WINDOW

    seconds = hours * 60 * 60
    return seconds


def get_extended_voting_window(api, urn):
    """ returns the extending voting window for PRs mitigated,
    based on the difference between repo creation and now """

    now = arrow.utcnow()
    # delta between now and the repo creation date
    delta = now - repos.get_creation_date(api, urn)
    days = delta.days

    minimum_window = settings.DEFAULT_VOTE_WINDOW
    maximum_window = settings.EXTENDED_VOTE_WINDOW
    seconds = dynamic_voting_window(days, minimum_window, maximum_window) * 60 * 60

    return seconds
