#! /bin/bash

while true ; do
    python3 chaos.py
    echo "ChaosBot died, restarting in 30 seconds..."
    sleep 30
    echo "Restarting ChaosBot..."
done
