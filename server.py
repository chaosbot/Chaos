#create a simple http server
import http.server
import socketserver
PORT = 80
Handler = http.server.SimpleHTTPRequestHandler
httpd = socketserver.TCPServer(("", PORT), Handler)
httpd.serve_forever()
