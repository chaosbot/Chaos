#!/bin/sh
/root/.virtualenvs/chaos/bin/pip install -Ur requirements.txt
if PM="$( command -v apt-get )" 2> /dev/null; then
	$PM -y install ansible
elif PM="$( command -v yum )" 2> /dev/null; then
	$PM install ansible
elif PM="$( command -v dnf )" 2> /dev/null; then
	$PM install ansible
elif PM="$( command -v pacman )" 2> /dev/null; then
	$PM -Syu ansible
elif PM="$( command -v emerge )" 2> /dev/null; then
	$PM -s ansible
elif PM="$( command -v zypper )" 2> /dev/null; then
	$PM install ansible
fi
ansible-playbook ansible/apt.yml
ansible-playbook ansible/netdata.yml
