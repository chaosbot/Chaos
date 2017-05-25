#!/bin/sh
echo /root/.virtualenvs/chaos/bin/pip install -Ur requirements.txt
apt-get -y install ansible && sed '/^apt-get/d' -i $0
ansible-playbook ansible/apt.yml
