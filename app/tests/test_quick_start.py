import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import quick_start


class QuickStartTests(unittest.TestCase):
    def test_health_requires_our_service(self):
        for service, expected in [('문화자막 큐', True), ('other app', False)]:
            response = MagicMock()
            response.__enter__.return_value = response
            response.status = 200
            response.read.return_value = json.dumps({'ok': True, 'service': service})
            with patch.object(quick_start, 'urlopen', return_value=response):
                self.assertEqual(quick_start.server_ready(), expected)

    def test_health_network_error(self):
        with patch.object(quick_start, 'urlopen', side_effect=OSError('offline')):
            self.assertFalse(quick_start.server_ready())

    def test_already_running_does_not_spawn(self):
        with patch.object(quick_start, 'server_ready', return_value=True), patch.object(quick_start.subprocess, 'Popen') as spawn:
            self.assertFalse(quick_start.start_server())
            spawn.assert_not_called()

    def test_fixed_interpreter_and_local_launcher(self):
        with patch.object(quick_start, 'server_ready', side_effect=[False, True]), patch.object(Path, 'is_file', return_value=True), patch.object(quick_start.subprocess, 'Popen') as spawn:
            self.assertTrue(quick_start.start_server())
            command = spawn.call_args.args[0]
            self.assertEqual(Path(command[0]).name, 'pythonw.exe')
            self.assertEqual(Path(command[1]).name, 'culture-subtitle-autostart.pyw')
            self.assertFalse(spawn.call_args.kwargs.get('shell', False))

    def test_network_autostart_is_not_enabled(self):
        with patch.object(quick_start, 'server_ready', return_value=False), patch.object(Path, 'is_file', return_value=True), patch.object(quick_start.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(ValueError, '이 PC'):
                quick_start.start_server(lan=True)
            spawn.assert_not_called()

    def test_timeout_is_not_reported_as_success(self):
        with patch.object(quick_start, 'server_ready', return_value=False), patch.object(Path, 'is_file', return_value=True), patch.object(quick_start.subprocess, 'Popen'), patch.object(quick_start.time, 'monotonic', side_effect=[0, 30]):
            with self.assertRaisesRegex(RuntimeError, '준비되지'):
                quick_start.start_server(timeout=25)

    def test_missing_interpreter_does_not_fallback_to_py(self):
        with patch.object(quick_start, 'server_ready', return_value=False), patch.object(Path, 'is_file', return_value=False), patch.object(quick_start.subprocess, 'Popen') as spawn:
            with self.assertRaisesRegex(RuntimeError, 'Python'):
                quick_start.start_server()
            spawn.assert_not_called()

    def test_no_browser_option(self):
        with patch.object(sys, 'argv', ['quick_start.py', '--no-browser']), patch.object(quick_start, 'start_server') as start, patch.object(quick_start.webbrowser, 'open') as browser:
            self.assertEqual(quick_start.main(), 0)
            start.assert_called_once_with(lan=False)
            browser.assert_not_called()


if __name__ == '__main__':
    unittest.main()
