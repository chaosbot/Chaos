#!/usr/bin/env python
# -*- coding: utf-8 -*-

import abc


class AbstractAdapter(abc.ABCMeta):
    def __init__(self, config):
        self.config = config

    @abc.abstractmethod
    def connect(self):
        raise NotImplementedError()

    @abc.abstractmethod
    def disconnect(self):
        raise NotImplementedError()

    @abc.abstractmethod
    def query(self, query, params=()):
        raise NotImplementedError()

    @abc.abstractmethod
    def row(self, query, params=()):
        raise NotImplementedError()

    @abc.abstractmethod
    def one(self, query, params=()):
        raise NotImplementedError()
