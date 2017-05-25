#!/bin/sh

# Prepare code auditing environment
REPO_URL=$(git remote get-url origin)
TEST_DIR=$(mktemp -d)
git clone "$REPO_URL" "$TEST_DIR";
pushd "$TEST_DIR";

# Code auditing section
find . -name '*.py' -print0 | xargs -0 python -m py_compile;
if [ "$?" != "0" ]
then
  echo "There is syntax error. This may endanger chaos. Pauses updates."
  exit 45
fi

# End code auditing section
popd

git checkout master
git pull
