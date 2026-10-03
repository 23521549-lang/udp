import os
from http.server import BaseHTTPRequestHandler, HTTPServer


class Health(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        ok = self.path == "/healthz"
        self.send_response(200 if ok else 404)
        self.end_headers()
        if ok:
            self.wfile.write(b"ok")


HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Health).serve_forever()
