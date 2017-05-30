import pymysql
import logging


__log = logging.getLogger("DB")

class DB(object):
    def __init__(self):
        self.conn = None

    def connect(self, host, user, password, db):
        self.conn = pymysql.connect(host=host,
                                    user=user,
                                    password=password,
                                    db=db,
                                    charset='utf8mb4',
                                    cursorclass=pymysql.cursors.DictCursor)

    def do_select(self, sql, params):
        if not self.conn:
            __log.warning("do_select: database connection " +
                          "not established")
            return

        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            results = cur.fetchall()
            return results


    def do_update(self, sql, params):
        if not self.conn:
            __log.warning("do_update: database connection " +
                          "not established")
            return

        with self.conn.cursor() as cur:
            cur.execute(sql, params)
            conn.commit()

    def __del__(self):
        if self.conn:
            self.conn.close()


host = 'localhost'
user = 'chaos'
password = 'chaos'
db = 'db'