#!/bin/bash

while getopts ":rpi:" opt; do
	case $opt in
		\?)
			echo "Invalid option: -$OPTARG" >&2
			exit 1
			;;
		:)
			echo "Building for Rasperry Pi." >&2
			cp ../../requirements.txt .
			docker build -f Dockerfile.rpi -t chaos .
			rm requirements.txt
			exit 1
			;;
	esac
done

cp ../../requirements.txt .
docker build -t chaos .
rm requirements.txt
