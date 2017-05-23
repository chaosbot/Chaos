from math import log
import arrow
import re

from . import prs
from . import comments
from . import users
from . import repos

import settings


def get_votes(api, urn, pr):
    """ return a mapping of username => -1 or 1 for the votes on the current
    state of a pr.  we consider comments and reactions, but only from users who
    are not the owner of the pr.  we also make sure that the voting
    comments/reactions come *after* the last update to the pr, so that someone
    can't acquire approval votes, then change the pr """

    votes = {}
    pr_owner = pr["user"]["login"]
    pr_num = pr["number"]
    since = prs.get_pr_last_updated(pr)

    # get all the comment-and-reaction-based votes
    for voter, vote in get_pr_comment_votes_all(api, urn, pr_num, since):
        votes[voter] = vote

    # get all the pr-review-based votes
    for vote_owner, vote in get_pr_review_votes(api, urn, pr_num):
        if vote and vote_owner != pr_owner:
            votes[vote_owner] = vote

    # by virtue of creating the PR, the owner casts his vote as 1
    votes[pr_owner] = 1

    return votes


def get_pr_comment_votes_all(api, urn, pr_num, since):
    """ yields votes via comments and votes via reactions on comments for a
    given pr """
    for comment in prs.get_pr_comments(api, urn, pr_num, since):
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
    reaction_votes = get_pr_reaction_votes(api, urn, pr_num, since)
    for reaction_owner, vote in reaction_votes:
        yield reaction_owner, vote



def get_pr_reaction_votes(api, urn, pr_num, since):
    """ yields reaction votes to a pr-comment.  very similar to getting
    reactions from comments on the pr """
    reactions = prs.get_reactions_for_pr(api, urn, pr_num, since)
    for reaction in reactions:
        reaction_owner = reaction["user"]["login"]
        vote = parse_reaction_for_vote(reaction["content"])
        if vote:
            yield reaction_owner, vote


def get_comment_reaction_votes(api, urn, comment_id, since):
    """ yields votes via reactions on comments on a pr.  don't use this
    directly, it is called by get_pr_comment_votes_all """
    reactions = comments.get_reactions_for_comment(api, urn, comment_id, since)
    for reaction in reactions:
        reaction_owner = reaction["user"]["login"]
        vote = parse_reaction_for_vote(reaction["content"])
        if vote:
            yield reaction_owner, vote


def get_pr_review_votes(api, urn, pr_num):
    """ votes made through
    https://help.github.com/articles/about-pull-request-reviews/ """
    for review in prs.get_pr_reviews(api, urn, pr_num):
        state = review["state"]
        if state in ("APPROVED", "DISMISSED"):
            user = review["user"]["login"]
            vote = parse_review_for_vote(state)
            yield user, vote



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
    age_weight = 1.0 if old_enough_to_vote else 0.0

    # here we use some basic social proof to weight their vote.  the theory here
    # is that a user's followers has a log relationship to their coding
    # judgement?  there's probably something better to use here
    followers = user["followers"]
    social_weight = log(followers + 1, settings.FOLLOWER_LOG_BASE)

    weight = age_weight * social_weight
    return weight


def get_vote_sum(api, votes):
    """ for a vote mapping of username => -1 or 1, compute the weighted vote
    total """
    total = 0
    for user, vote in votes.items():
        weight = get_vote_weight(api, user)
        total += weight * vote

    return total


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
    try:
        vote = int(body)
    except ValueError:
        vote = 0
    return vote


def parse_comment_for_vote(body):
    """ turns a comment into a vote, if possible """
    vote = 0
    m = re.search(":((?:\+|\-)1):", body, re.M)
    if m:
        vote = int(m.group(1))
    return vote


def friendly_voting_record(votes):
    """ returns a sorted list (a string list, not datatype list) of voters and
    their raw (unweighted) vote.  this is used in merge commit messages """
    voters = sorted(votes.items())
    record = "\n".join("@%s: %d" % (user, vote) for user, vote in voters)
    return record


def get_voting_window(now):
    """ returns the current voting window for new PRs. Some men just want to watch the world burn."""
    return 5
