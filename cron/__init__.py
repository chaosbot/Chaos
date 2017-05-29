import schedule
import settings

from .poll_pull_requests import poll_pull_requests as poll_pull_requests
from .poll_read_issue_comments import poll_read_issue_comments


def schedule_jobs():
    schedule.every(settings.PULL_REQUEST_POLLING_INTERVAL_SECONDS).seconds.do(
        poll_pull_requests)
    schedule.every(settings.ISSUE_COMMENT_POLLING_INTERVAL_SECONDS).seconds.do(
        poll_read_issue_comments)
