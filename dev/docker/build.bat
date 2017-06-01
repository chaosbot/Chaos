copy ..\..\requirements.txt .
docker build -t chaos .
del requirements.txt
