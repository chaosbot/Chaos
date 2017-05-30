#!/bin/sh
ln -s /var/log/supervisor/chaos-stderr.log ./server/chaos.log

# just in case
chmod +r ./server/chaos.log
