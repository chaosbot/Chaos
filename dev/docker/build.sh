#!/bin/bash
cp ../../requirements.txt .
docker build -t chaos .
rm requirements.txt
