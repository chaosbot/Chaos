import schedule
import settings

from .poll_pull_requests import poll_pull_requests as poll_pull_requests


def schedule_jobs():
    schedule.every(settings.PULL_REQUEST_POLLING_INTERVAL_SECONDS).seconds.do(
        poll_pull_requests)
