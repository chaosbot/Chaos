import http.server
import socketserver

#set the process name to "chaos_server" so we can easily kill it with "pkill chaos_server"
def set_proc_name(newname):
    from ctypes import cdll, byref, create_string_buffer
    libc = cdll.LoadLibrary('libc.so.6')
    buff = create_string_buffer(len(newname)+1)
    buff.value = newname.encode("ascii")
    libc.prctl(15, byref(buff), 0, 0, 0)
set_proc_name("chaos_server")

#start server on port 80
PORT = 80
Handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(("", PORT), Handler)
httpd.serve_forever()
