import http.client
import socket
import sys
import threading
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

EXTENSION = 'chrome-extension://' + 'a' * 32


class AllowedRequestTests(unittest.TestCase):
    def test_ip_and_localhost_hosts(self):
        for host in ['127.0.0.1:8876', 'localhost:8876', '[::1]:8876', '192.168.0.10:8876', '100.101.102.103:8876']:
            self.assertTrue(server.is_allowed_request(host, None, ''), host)

    def test_named_host_needs_opt_in(self):
        self.assertFalse(server.is_allowed_request('attacker.example:8876', None, ''))
        self.assertFalse(server.is_allowed_request('', None, ''))
        self.assertFalse(server.is_allowed_request(None, None, ''))
        self.assertTrue(server.is_allowed_request('pc.tail.ts.net:8876', None, 'pc.tail.ts.net'))

    def test_origin_must_be_same_site_or_extension(self):
        host = '127.0.0.1:8876'
        self.assertTrue(server.is_allowed_request(host, 'http://127.0.0.1:8876', ''))
        self.assertTrue(server.is_allowed_request(host, EXTENSION, ''))
        for origin in ['https://evil.example', 'null', 'http://localhost:8876', 'chrome-extension://evil']:
            self.assertFalse(server.is_allowed_request(host, origin, ''), origin)


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.server = server.ThreadingHTTPServer(('127.0.0.1', 0), server.AppHandler)
        self.server.access_token = 'test-only'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            conn.close()

    def test_foreign_site_cannot_read_pairing_token(self):
        status, body, headers = self.request('GET', '/api/bootstrap', {'Origin': 'https://evil.example'})
        self.assertEqual(status, 403)
        self.assertNotIn(b'test-only', body)
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_rebound_host_rejected(self):
        status, body, _ = self.request('GET', '/api/bootstrap', {'Host': 'attacker.example'})
        self.assertEqual(status, 403)
        self.assertNotIn(b'test-only', body)

    def test_extension_and_same_origin_still_pair(self):
        port = self.server.server_port
        for origin in [None, EXTENSION, f'http://127.0.0.1:{port}']:
            status, body, headers = self.request('GET', '/api/bootstrap', {'Origin': origin} if origin else {})
            self.assertEqual(status, 200, origin)
            self.assertIn(b'test-only', body)
            self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_foreign_origin_blocked_on_writes(self):
        headers = {'Origin': 'https://evil.example', 'Authorization': 'Bearer test-only'}
        for method in ['POST', 'PATCH', 'DELETE']:
            self.assertEqual(self.request(method, '/api/jobs/x', headers)[0], 403, method)

    def test_preflight_gets_no_cors_grant(self):
        status, _, headers = self.request('OPTIONS', '/api/jobs', {'Origin': 'https://evil.example'})
        self.assertNotIn('Access-Control-Allow-Origin', headers)
        self.assertGreaterEqual(status, 400)

    def test_negative_content_length_rejected_without_hanging(self):
        with socket.create_connection(('127.0.0.1', self.server.server_port), timeout=4) as sock:
            sock.sendall(b'POST /api/playlists HTTP/1.1\r\nHost: 127.0.0.1\r\n'
                         b'Authorization: Bearer test-only\r\nContent-Length: -1\r\n\r\nx')
            self.assertIn(b' 400 ', sock.recv(4096).split(b'\r\n', 1)[0])


if __name__ == '__main__':
    unittest.main()
