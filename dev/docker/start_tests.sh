#!/bin/bash

flake8
python -m unittest discover -p "*_test.py"
