#!/bin/sh
/root/.virtualenvs/chaos/bin/pip install -Ur requirements.txt
apt-get -y install ansible
ansible-playbook ansible/apt.yml
ansible-playbook ansible/netdata.yml
