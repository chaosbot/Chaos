#!/bin/bash

cd puppet
./pullForge.sh
puppet apply --verbose --modulepath=$PWD/modules/ $PWD/manifests/
