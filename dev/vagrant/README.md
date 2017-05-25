# Vagrant

To run your own VM for local development, install [Vagrant](https://www.vagrantup.com/downloads.html) and [VirtualBox](https://www.virtualbox.org/wiki/Downloads). Then, type on your host machine:

    vagrant up
    vagrant ssh

When in SSH:

    sudo su
    cd /vagrant
    python3 chaos.py

