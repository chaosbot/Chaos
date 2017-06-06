#!/bin/sh

pkill chaos_server

ln -sf /var/log/nginx/access.log /root/workspace/Chaos/log/nginx-access.log
ln -sf /var/log/nginx/error.log /root/workspace/Chaos/log/nginx-error.log

nginx -t
service nginx force-reload
