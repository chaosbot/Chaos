ln -sf /root/workspace/Chaos/etc/chaos_supervisor.conf /etc/supervisor/conf.d/chaos.conf
ln -sf /root/workspace/Chaos/etc/nginx/chaos_errors /etc/nginx/sites-available/
ln -sf /root/workspace/Chaos/etc/nginx/chaos_uwsgi /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/chaos_errors /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/chaos_uwsgi /etc/nginx/sites-enabled/

service supervisor start
service nginx start

sleep 1

tail -F /root/workspace/Chaos/log/*
