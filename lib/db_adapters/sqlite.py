#!/usr/bin/env python
# -*- coding: utf-8 -*-

import sqlite3
from sqlite3 import Connection  # NOQA

from . import interface


class Sqlite(interface.AbstractAdapter):
    def __init__(self, config):
        super().__init__(config)
        self.filename = self.config['filename']
        self.conn = None  # type: Connection

    def connect(self):
        self.conn = sqlite3.connect(database=self.filename)
        self.conn.row_factory = sqlite3.Row

    def disconnect(self):
        self.conn.close()

    def query(self, query, params=()):
        cursor = self.conn.cursor()
        rows = cursor.execute(query, params).fetchall()
        self.conn.commit()
        return rows

    def row(self, query, params=()):
        return self.query(query, params)[0]

    def one(self, query, params=()):
        return self.row(query, params)[0]
