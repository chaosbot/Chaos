import http.server
import socketserver
import socket

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

class NoTimeWaitTCPServer(socketserver.ThreadingTCPServer):
    """ when a socket does is shutdown dance, it ends up in a TIME-WAIT state,
    which can prevent rebinding on it quickly.  here we say "shut up, socket",
    let me rebind anyways even if you're in TIME-WAIT."  that will teach it. """
    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(self.server_address)

httpd = NoTimeWaitTCPServer(("", PORT), Handler)
httpd.serve_forever()
