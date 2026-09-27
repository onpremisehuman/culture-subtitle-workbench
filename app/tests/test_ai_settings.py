from http.client import HTTPConnection
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class SettingsTests(unittest.TestCase):
    def test_authenticated_settings_only(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(server,"AI_SETTINGS",server.agent_cli.BackendSettings(Path(folder)/"settings.json")):
            http=server.ThreadingHTTPServer(("127.0.0.1",0),server.AppHandler);http.access_token="test-only"
            worker=threading.Thread(target=http.serve_forever,daemon=True);worker.start()
            try:
                for method,token,body,expected in [("GET","",None,401),("POST","wrong",{"backend":"claude"},401),("POST","test-only",{"backend":"claude"},200),("GET","test-only",None,200),("POST","test-only",{"backend":"invalid"},400)]:
                    conn=HTTPConnection("127.0.0.1",http.server_port)
                    conn.request(method,"/api/ai-settings",None if body is None else json.dumps(body),{"Authorization":"Bearer "+token,"Content-Type":"application/json"})
                    response=conn.getresponse();data=json.loads(response.read());conn.close()
                    self.assertEqual(response.status,expected)
                    if expected==200:self.assertEqual(data["selected"],"claude")
            finally:http.shutdown();http.server_close();worker.join()
