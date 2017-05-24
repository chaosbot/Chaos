import json
import os
import logging

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
SAVE_FILE_PATH = os.path.join(THIS_DIR, "called_functions.json")

def callOnce(func):
    with open(SAVE_FILE_PATH, "r") as save_file:
        called_funcs_set = set(json.load(save_file))
        if func.__name__ in called_funcs_set:
            logging.info("Function was called before: " + str(func.__name__))
        else:
            called_funcs_set.add(func.__name__)
            func()
    with open(SAVE_FILE_PATH, "w") as save_file:
        json.dump(list(called_funcs_set), save_file)
