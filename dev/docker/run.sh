#!/bin/bash
docker run -it --rm\
    -v $(cd ../../; pwd):/root/workspace/Chaos\
    -p 8082:80\
    -p 8081:8081\
    chaos
