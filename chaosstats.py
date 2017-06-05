import os
import sys
import json
import inspect

try:
    from flask import Flask 
except ImportError:
    os.system("pip install Flask")
    from flask import Flask 
app = Flask(__name__)

config_file_path = ""

@app.route("/")
def showChaosStats():
    try:
        conf_obj = json.load(config_file_path)
    except:
        return "No config file found at '" + str(config_file_path) + "'"
    
    

if os.getenv("CHAOS_STAT_RUN", "TRUE") == "TRUE":
    cur_file_path = inspect.getframeinfo(inspect.currentframe()).filename
    print(cur_file_path)
    os.system("FLASK_APP=" + cur_file_path + " CHAOS_STAT_RUN=FALSE python -m flask run --host=0.0.0.0")
