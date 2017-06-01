from math import exp
import inspect
import itertools
from functools import wraps


def peek(iterable):
    try:
        first = next(iterable)
    except StopIteration:
        return None
    return first, itertools.chain([first], iterable)


def dt_to_github_dt(dt):
    return dt.isoformat() + "Z"


def seconds_to_human(seconds):
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    return "%d:%02d" % (h, m)


def dynamic_voting_window(x, lbound, ubound):
    """ Determine the number of hours for the voting window
    based on the number of day since the project start
    return between a lower and upper bound using sigmoid function.
    Sigmoid functions never reach their upper bound.
    With current settings it will "almost" reach ubound in ~60 days (x=60)"""

    # to make curve more flat
    modified_x = x / 12

    # calculate parameters
    difference = ubound - lbound
    param_a = difference * 2
    param_b = lbound - difference

    # calculate sigmoid function
    sigmoid = 1 / (exp(-modified_x) + 1)

    return param_a * sigmoid + param_b


def handle_pagination_all(method):
    """Handles the "all" keyword argument, looping over the method page by
    page until the page is empty and then returning a list of items.

    Expects @param page="all, 1,2,.." etc
    """

    def helper(page_results):
        """ Test if page results are json, or a generator.
            We want to keep going while json is returned,
            or we are getting non empty generators
         """
        condition = page_results
        is_gen = inspect.isgeneratorfunction(page_results)
        is_gen |= inspect.isgenerator(page_results)
        if is_gen:
            # Generator not empty
            condition = peek(page_results) is not None
        return condition

    @wraps(method)
    def wrapper(self, *args, **kwargs):
        kwargs = dict(kwargs)
        page = kwargs.pop("page", None)

        # Want all pages
        if page == "all":
            kwargs["page"] = 1
            result = method(self, *args, **kwargs)
            condition = helper(result)

            while condition:
                yield result
                kwargs['page'] += 1
                try:
                    result = method(self, *args, **kwargs)
                    condition = helper(result)
                except:
                    break

        # Not all pages, 1 specific page so put param back
        kwargs["page"] = page
        yield method(self, *args, **kwargs)

    return wrapper
