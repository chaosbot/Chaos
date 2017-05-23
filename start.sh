#! /bin/bash

python3 chaos.py
echo "ChaosBot died, restarting in 30 seconds..."
sleep 30
echo "Restarting ChaosBot..."

exec "$ScriptLoc" 
# This is done with a exec instead of a while loop so that the script will be reloaded if it is modified.
