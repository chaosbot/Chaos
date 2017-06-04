cd %~dp0\..\..\
docker run -it --rm -v %cd%:/root/workspace/Chaos -p 8082:80 -p 8081:8081 chaos bash /root/workspace/Chaos/dev/docker/start_tests.sh
