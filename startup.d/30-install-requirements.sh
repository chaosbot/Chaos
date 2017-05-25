#!/bin/sh
/root/.virtualenvs/chaos/bin/pip install -Ur requirements.txt
ansible-playbook ansible/apt.yml
