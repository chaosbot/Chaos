# -*- mode: ruby -*-
# vim: ft=ruby :

Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/trusty64"

  # Network settings
  config.vm.network "forwarded_port", guest: 80, host: 80, auto_correct: true
  config.vm.network "private_network", ip: "192.168.33.10"

  # Shared folder, just use /vagrant default (virtualbox style)
  config.vm.synced_folder ".", "/vagrant", type: "virtualbox"

  # Ensure basic python requirements are initialized
  config.vm.provision "shell", inline: <<-SHELL2
    cd /vagrant
    apt-get install python3-pip -y
    pip3 install -r requirements.txt
    echo -e '#!/bin/sh\ncd /vagrant\nsudo python3 chaos.py' > /usr/bin/zalgo
    chmod +x /usr/bin/zalgo
  SHELL2

  # To run, type on host machine:
  #
  #   vagrant up
  #   vagrant ssh
  #
  # When in SSH, to start serving:
  #
  #   zalgo

end
