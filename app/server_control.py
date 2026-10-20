"""Private start-only controller. No arbitrary commands, files or queue access."""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import time

from quick_start import ROOT, server_ready, start_server

PORT = 8875
START_LOCK = threading.Lock()


def allowed_origin(origin):
    # Browser pages cannot POST via a form or cross-origin fetch. CLI has no Origin.
    return origin is None or re.fullmatch(r'chrome-extension://[a-p]{32}', origin) is not None


class ControlServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, ControlHandler)


class ControlHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        origin = self.headers.get('Origin')
        if origin and allowed_origin(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'X-Culture-Start')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        hosts = {f'{host}:{self.server.server_port}' for host in ('127.0.0.1', 'localhost')}
        if (self.headers.get('Host') not in hosts or not allowed_origin(self.headers.get('Origin'))
                or self.client_address[0] not in {'127.0.0.1', '::1'}):
            self.reply(403, {'error': '이 PC에서만 사용할 수 있습니다.'})
            return False
        return True

    def do_OPTIONS(self):
        if self.authorized():
            self.reply(200, {'ok': True})

    def do_GET(self):
        if not self.authorized():
            return
        if self.path != '/api/health':
            self.reply(404, {'error': 'Not found'})
            return
        self.reply(200, {'ok': True, 'service': 'culture-subtitle-control', 'serverReady': server_ready()})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != '/api/ensure':
            self.reply(404, {'error': 'Not found'})
            return
        if self.headers.get('X-Culture-Start') != '1' or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length', '0') != '0':
            self.reply(400, {'error': '본문 없는 시작 요청만 허용됩니다.'})
            return
        # Serialize starts; non-blocking acquisition keeps duplicate requests bounded.
        if not START_LOCK.acquire(timeout=1):
            self.reply(202, {'ok': True, 'starting': True})
            return
        try:
            start_server(timeout=20)
            self.reply(200, {'ok': True, 'ready': True})
        except Exception:
            self.reply(503, {'error': '서버 시작에 실패했습니다. PC의 실행 로그를 확인해주세요.'})
        finally:
            START_LOCK.release()


def maintain_server():
    while True:
        try:
            with START_LOCK:
                start_server(timeout=20)
        except Exception:
            pass  # The regular server supervisor owns its detailed error log.
        time.sleep(15)


def main():
    with ControlServer(('127.0.0.1', PORT)) as server:
        threading.Thread(target=maintain_server, daemon=True).start()
        server.serve_forever()


if __name__ == '__main__':
    main()
