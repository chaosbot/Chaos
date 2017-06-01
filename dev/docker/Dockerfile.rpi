FROM armhf/debian:jessie

# clean and update dependencies
RUN apt-get clean && apt-get update

# get locale dependency
RUN apt-get install locales

# set locales
RUN locale-gen en_US.UTF-8
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

RUN rm -vfr /var/lib/apt/lists/*
RUN apt-get -y update

# system dependencies
RUN apt-get -y install\
        git\
        nginx\
        python-software-properties\
        software-properties-common\
        supervisor\
        curl

# python requirement dependencies
RUN apt-get -y install\
        # dependencies for ansible's dependency module "cryptography"
        build-essential\
        libssl-dev\
        libffi-dev

# download python 3.6 source
RUN curl https://www.python.org/ftp/python/3.6.0/Python-3.6.0.tgz -o Python-3.6.0.tgz -s && tar -xzvf Python-3.6.0.tgz
RUN cd Python-3.6.0/ && ./configure && make -j 2 && make install

RUN curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py | python3.6 -
RUN pip3 install virtualenv

ENV venvs=/root/.virtualenvs
ENV venv=$venvs/chaos
ENV chaosdir=/root/workspace/Chaos

RUN mkdir -p $chaosdir
RUN mkdir $venvs
RUN virtualenv $venv

ENV PATH="$venv/bin:$PATH"

WORKDIR $chaosdir

COPY requirements.txt .
RUN pip install -r requirements.txt
RUN rm requirements.txt

RUN rm /etc/nginx/sites-enabled/default

RUN printf "\
    ln -sf /root/workspace/Chaos/etc/chaos_supervisor.conf /etc/supervisor/conf.d/chaos.conf\n\
    ln -sf /root/workspace/Chaos/etc/nginx/chaos_errors /etc/nginx/sites-available/\n\
    ln -sf /etc/nginx/sites-available/chaos_errors /etc/nginx/sites-enabled/\n\

    service supervisor start\n\
    service nginx start\n\

    sleep 1\n\

    tail -F /root/workspace/Chaos/log/*"\
    >> /root/start_chaos.sh

EXPOSE 80 8081
ENTRYPOINT bash /root/start_chaos.sh
