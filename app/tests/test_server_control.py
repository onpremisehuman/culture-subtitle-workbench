import http.client
import sys
import threading
from pathlib import Path
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server_control as control


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.server = control.ControlServer(('127.0.0.1', 0))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.start_patch = patch.object(control, 'start_server')
        self.start = self.start_patch.start()
        self.health_patch = patch.object(control, 'server_ready', return_value=True)
        self.health_patch.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
        self.start_patch.stop(); self.health_patch.stop()

    def request(self, method='POST', path='/api/ensure', headers=None, body=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            return response.status, response.read(), dict(response.getheaders())
        finally:
            conn.close()

    def test_start_fixed_command_only(self):
        self.assertEqual(self.request(headers={'X-Culture-Start': '1'})[0], 200)
        self.start.assert_called_once_with(timeout=20)

    def test_health_does_not_start(self):
        self.assertEqual(self.request('GET', '/api/health')[0], 200)
        self.start.assert_not_called()

    def test_bad_host_origin_and_form_rejected(self):
        for headers in [dict(Host='evil.example', **{'X-Culture-Start': '1'}),
                        dict(Origin='https://youtube.com', **{'X-Culture-Start': '1'}),
                        dict(Origin='null', **{'X-Culture-Start': '1'})]:
            self.assertEqual(self.request(headers=headers)[0], 403)
        self.assertEqual(self.request()[0], 400)
        self.start.assert_not_called()

    def test_extension_cors_only(self):
        origin = 'chrome-extension://' + 'a' * 32
        status, _, headers = self.request('OPTIONS', headers={'Origin': origin})
        self.assertEqual(status, 200)
        self.assertEqual(headers['Access-Control-Allow-Origin'], origin)
        self.assertEqual(self.request('OPTIONS', headers={'Origin': 'https://evil.example'})[0], 403)
        self.start.assert_not_called()

    def test_body_path_and_methods_cannot_execute_commands(self):
        self.assertEqual(self.request(headers={'X-Culture-Start': '1'}, body='{"command":"anything"}')[0], 400)
        self.assertEqual(self.request(path='/api/ensure?command=anything', headers={'X-Culture-Start': '1'})[0], 404)
        self.assertEqual(self.request('GET', '/api/ensure')[0], 404)
        self.start.assert_not_called()

    def test_failure_does_not_leak_exception_or_credentials(self):
        self.start.side_effect = RuntimeError('sensitive detail')
        status, body, _ = self.request(headers={'X-Culture-Start': '1'})
        self.assertEqual(status, 503)
        self.assertNotIn(b'sensitive detail', body)


if __name__ == '__main__':
    unittest.main()
