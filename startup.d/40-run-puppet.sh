#!/usr/bin/env bash
cd puppet
puppet apply --verbose --modulepath="$PWD/modules/" "$PWD/manifests/"
