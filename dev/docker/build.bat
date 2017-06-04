cd %~dp0
copy ..\..\requirements.txt .
docker build -t chaos .
del requirements.txt
