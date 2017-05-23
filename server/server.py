import http.server
import socketserver

import os
import random

from flask import Flask, Markup, render_template
app = Flask(__name__, template_folder='.')

@app.route("/")
def server_random_content():
    stuff = os.listdir('content')
    chosen_one = random.choice(stuff)
    with open(os.path.join('content', chosen_one), 'r') as fp:
        return render_template('index.html', content=Markup(fp.read()))

#set the process name to "chaos_server" so we can easily kill it with "pkill chaos_server"
def set_proc_name(newname):
    from ctypes import cdll, byref, create_string_buffer
    libc = cdll.LoadLibrary('libc.so.6')
    buff = create_string_buffer(len(newname)+1)
    buff.value = newname.encode("ascii")
    libc.prctl(15, byref(buff), 0, 0, 0)
set_proc_name("chaos_server")

# initialize random seed
random.seed()

#start server on port 80
PORT = 80
#Handler = http.server.SimpleHTTPRequestHandler
#httpd = socketserver.TCPServer(("", PORT), Handler)
#httpd.serve_forever()

app.run(host="0.0.0.0", port=8080, threaded=False)
