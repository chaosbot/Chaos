#!/usr/bin/env python
# -*- coding: utf-8 -*-

import http.server
import socketserver
import socket


def set_proc_name(newname):
    """Change the process name using libc.so.6"""
    from ctypes import cdll, byref, create_string_buffer
    libc = cdll.LoadLibrary('libc.so.6')
    buff = create_string_buffer(len(newname) + 1)
    buff.value = newname.encode("ascii")
    libc.prctl(15, byref(buff), 0, 0, 0)


class NoTimeWaitTCPServer(socketserver.ThreadingTCPServer):
    """When a socket does is shutdown dance, it ends up in a TIME-WAIT state,
    which can prevent rebinding on it quickly. Here we say "shut up, socket",
    let me rebind anyways even if you're in TIME-WAIT." That will teach it."""

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(self.server_address)


def main():
    # set the process name to "chaos_server" so we can easily kill it with:
    # pkill chaos_server
    set_proc_name("chaos_server")

    with open("error.html", "r") as f:
        errorpage = f.read()

    port = 80
    handler = http.server.SimpleHTTPRequestHandler
    handler.error_message_format = errorpage
    httpd = NoTimeWaitTCPServer(("", port), handler)

    # serve HTTP on port 80
    httpd.serve_forever()


if __name__ == "__main__":
    main()
