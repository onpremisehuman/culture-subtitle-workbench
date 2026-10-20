from http.client import HTTPConnection
import json
import threading
import unittest
from serve_mobile_fixture import isolated_queue, server


class PlaybackTests(unittest.TestCase):
    def setUp(self):
        self.scope = isolated_queue()
        self.token = self.scope.__enter__()
        self.job = server.create_job('https://youtu.be/7ifpw18OCwg', 'culture', 'en')
        server.update_job(self.job['id'], status='completed')

    def tearDown(self):
        self.scope.__exit__(None, None, None)

    def payload(self, **kw):
        return dict(position=123.5, duration=600, completed=False, revision=0, **kw)

    def test_shared_revision_persists_and_library_includes_progress(self):
        self.assertEqual(server.get_playback(self.job['id'])['revision'], 0)
        result = server.save_playback(self.job['id'], self.payload())
        self.assertEqual(result['revision'], 1)
        self.assertEqual(server.get_playback(self.job['id'])['position'], 123.5)
        self.assertEqual(server.list_jobs()[0]['playback']['position'], 123.5)
        with self.assertRaises(RuntimeError):  # stale phone tab must not erase laptop
            server.save_playback(self.job['id'], self.payload())
        again = {**self.payload(), 'revision': 1, 'position': 0}
        self.assertEqual(server.save_playback(self.job['id'], again)['position'], 0)

    def test_bad_payloads_never_write(self):
        for data in [None, {}, {**self.payload(), 'position': -1}, {**self.payload(), 'position': float('nan')},
                     {**self.payload(), 'duration': float('inf')}, {**self.payload(), 'duration': 0},
                     {**self.payload(), 'position': 999}, {**self.payload(), 'revision': True},
                     {**self.payload(), 'completed': True}, {**self.payload(), 'position': True},
                     {**self.payload(), 'extra': 'field'}]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                server.save_playback(self.job['id'], data)
        self.assertEqual(server.get_playback(self.job['id'])['revision'], 0)

    def test_complete_restart_and_delete(self):
        server.save_playback(self.job['id'], {**self.payload(), 'position': 600, 'completed': True})
        self.assertTrue(server.get_playback(self.job['id'])['completed'])
        server.init_storage()
        self.assertTrue(server.get_playback(self.job['id'])['completed'])
        server.delete_job(self.job['id'])
        with server.db() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM playback').fetchone()[0], 0)

    def test_media_keys_shared_for_same_youtube_but_separate_for_local(self):
        a = server.get_job(self.job['id'])
        b = {**a, 'id': 'another-translation'}
        self.assertEqual(server.playback_key(a), server.playback_key(b))
        self.assertNotEqual(server.playback_key({**a, 'source_type': 'local'}), server.playback_key({**b, 'source_type': 'local'}))

    def test_http_auth_missing_object_validation_and_conflict(self):
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.AppHandler)
        http.access_token = self.token
        thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
        def req(method, credential, data=None, job_id=None):
            c = HTTPConnection('127.0.0.1', http.server_port)
            c.request(method, f"/api/jobs/{job_id or self.job['id']}/playback", json.dumps(data) if data else None,
                      {'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json'})
            r = c.getresponse(); body = json.loads(r.read()); c.close()
            return r.status, body
        try:
            for credential in ('', 'another-workbench-token'):
                self.assertEqual(req('GET', credential)[0], 401)
                self.assertEqual(req('PATCH', credential, self.payload())[0], 401)
            for method in ('GET', 'PATCH'):
                self.assertEqual(req(method, self.token, self.payload(), 'missing')[0], 404)
            self.assertEqual(req('PATCH', self.token, {**self.payload(), 'position': -2})[0], 400)
            self.assertEqual(req('PATCH', self.token, self.payload())[0], 200)
            self.assertEqual(req('PATCH', self.token, self.payload())[0], 409)
            self.assertEqual(req('GET', self.token)[1]['playback']['position'], 123.5)
        finally:
            http.shutdown(); http.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
