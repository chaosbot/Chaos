#!/bin/sh
cd puppet
puppet apply --verbose --modulepath="$PWD/modules/" "$PWD/manifests/"
