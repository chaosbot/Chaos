#!/usr/bin/env bash
cd "$(dirname "$0")"
node ./replication/api.js
for file in startup.d/*; do
  [[ -f "$file" && -x "$file" ]] && "$file"
done
