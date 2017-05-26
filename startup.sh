#!/usr/bin/env sh
cd "$(dirname "$0")"

for file in startup.d/*; do
  [[ -f "$file" && -x "$file" ]] && "$file"
done
