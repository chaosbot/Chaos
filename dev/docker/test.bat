cd ..\..\
docker run -it --rm -v %cd%:/root/workspace/Chaos -p 8082:80 -p 8081:8081 chaos python -m unittest discover -p "*_test.py"
