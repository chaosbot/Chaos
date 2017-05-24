#!/bin/sh
supervisorctl reread
supervisorctl update
supervisorctl restart chaos
