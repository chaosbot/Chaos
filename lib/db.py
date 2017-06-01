#!/usr/bin/env python
# -*- coding: utf-8 -*-

from importlib import import_module

import settings
from lib.db_adapters.interface import AbstractAdapter


class DB(object):
    """ our database abstraction layer """

    instance = None  # type: DB

    @staticmethod
    def get_instance():
        """ singleton implementation """
        if DB.instance is None:
            DB.instance = DB(settings.DB_ADAPTER, settings.DB_CONFIG)
        return DB.instance

    @staticmethod
    def create_adapter(adapter_name, config) -> AbstractAdapter:
        """ helper method to get adapter instance """
        module_name = "lib.db_adapters." + adapter_name
        class_name = adapter_name[0].upper() + adapter_name[1:]
        module_instance = import_module(module_name)
        return getattr(module_instance, class_name)(config)

    def __init__(self, adapter_name, config):
        """ initialize adapter with config """
        self.adapter = self.create_adapter(adapter_name, config)
        self.adapter.connect()

    def __del__(self):
        self.adapter.disconnect()

    def query(self, query, params=()):
        return self.adapter.query(query, params)

    def row(self, query, params=()):
        return self.adapter.row(query, params)

    def one(self, query, params=()):
        return self.adapter.one(query, params)
