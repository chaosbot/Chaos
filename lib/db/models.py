import peewee as pw
import logging

from settings import DB_CONFIG
__log = logging.getLogger("db")


DB = pw.SqliteDatabase(DB_CONFIG["filename"])


class BaseModel(pw.Model):
    class Meta:
        database = DB


class User(BaseModel):
    login = pw.CharField(unique=True)
    user_id = pw.IntegerField(primary_key=True)


class Comment(BaseModel):
    comment_id = pw.IntegerField(primary_key=True)
    user = pw.ForeignKeyField(User, related_name='comments')
    text = pw.CharField()
    created_at = pw.DateField()
    updated_at = pw.DateField()


class Issue(BaseModel):
    issue_id = pw.IntegerField(primary_key=True)
    number = pw.IntegerField()
    created_at = pw.DateField()
    user = pw.ForeignKeyField(User, related_name='poster')
    is_pr = pw.BooleanField()
    expedited = pw.BooleanField()


class ActiveIssueCommands(BaseModel):
    comment = pw.ForeignKeyField(Comment, related_name="command")
    issue = pw.ForeignKeyField(Issue)
    chaos_response = pw.ForeignKeyField(Comment,
                                        related_name="command_response",
                                        null=True)
    seconds_remaining = pw.IntegerField(null=True)

    class Meta:
        primary_key = pw.CompositeKey("comment", "issue")


class InactiveIssueCommands(BaseModel):
    comment = pw.ForeignKeyField(Comment, primary_key=True)


class RunTimes(BaseModel):
    command = pw.CharField(primary_key=True)
    last_ran = pw.CharField(null=True)


class MeritocracyMentioned(BaseModel):
    m_id = pw.PrimaryKeyField()
    commit_hash = pw.CharField(max_length=40)


try:
    DB.connect()
    DB.create_tables([User, Comment, Issue, RunTimes,
                      ActiveIssueCommands, MeritocracyMentioned,
                      InactiveIssueCommands], safe=True)
    DB.close()
except Exception as e:
    __log.exception("Something went wrong with the db")
    raise e
