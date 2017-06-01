#!/bin/bash

previous_migrations_store_path=".migrated"

pushd "$(dirname "$0")" > /dev/null

for file in ./migrations/*; do
    if [ -f "$file" ]; then
        if ! grep -q "^$file$" "$previous_migrations_store_path"; then
            echo "`date` Running migration $file"
            chmod u+x "$file"
            "$file"
            echo "$file" >> "$previous_migrations_store_path"
        fi
    fi
done

popd > /dev/null
