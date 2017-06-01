#!/usr/bin/env python
# -*- coding: utf-8 -*-

import pymysql
import logging
from . import interface

__log = logging.getLogger("mysql")


class Mysql(interface.AbstractAdapter):
    def __init__(self, config):
        super().__init__(config)
        self.host = self.config['host']
        self.user = self.config['user']
        self.password = self.config['password']
        self.db = self.config['db']
        self.conn = None

    def connect(self):
        self.conn = pymysql.connect(host=self.host,
                                    user=self.user,
                                    password=self.password,
                                    db=self.db,
                                    charset='utf8mb4',
                                    cursorclass=pymysql.cursors.DictCursor)

    def disconnect(self):
        if self.conn:
            self.conn.close()

    def query(self, query, params=()):
        if not self.conn:
            __log.warning("do_select: database connection not established")
            return

        with self.conn.cursor() as cur:
            cur.execute(query, params)
            results = cur.fetchall()
            return results

    def row(self, query, params=()):
        return self.query(query, params)[0]

    def one(self, query, params=()):
        return self.row(query, params)[0]
