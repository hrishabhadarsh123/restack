# -*- coding: utf-8 -*-
"""Legacy Python 2 entry point serving a tiny inventory app."""
import BaseHTTPServer
import json
import db

from handlers import render_inventory, render_health


def main():
    db.init('data/inventory.db')

    class Handler(BaseHTTPServer.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == '/health':
                body = render_health()
            elif self.path.startswith('/inventory'):
                body = render_inventory(db.all_items())
            else:
                body = '<h1>Not found</h1>'
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(body.encode('utf-8'))

    print 'Serving on http://0.0.0.0:8000'
    server = BaseHTTPServer.HTTPServer(('', 8000), Handler)
    server.serve_forever()


if __name__ == '__main__':
    main()
