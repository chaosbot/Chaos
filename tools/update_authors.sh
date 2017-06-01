#!/bin/sh
git shortlog -e -s -n | cut -f2-  > AUTHORS
git add AUTHORS
# git commit -m "Updating authors"
