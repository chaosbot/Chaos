#!/bin/bash
cd /tmp/
[ -d netdata ] && exit

curl -Ss 'https://raw.githubusercontent.com/firehol/netdata-demo-site/master/install-required-packages.sh' >/tmp/kickstart.sh && bash /tmp/kickstart.sh -i netdata-all --dont-wait

git clone https://github.com/firehol/netdata.git --depth=1
cd netdata

sudo ./netdata-installer.sh -u --dont-wait
