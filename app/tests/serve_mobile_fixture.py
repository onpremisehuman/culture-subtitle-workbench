"""Real API/UI with an isolated temporary queue and NO processing worker."""
from contextlib import contextmanager, ExitStack
from pathlib import Path
from unittest.mock import patch
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


@contextmanager
def isolated_queue():
    with tempfile.TemporaryDirectory(prefix="culture-mobile-qa-") as folder, ExitStack() as stack:
        root = Path(folder)
        for key, value in {
            "DATA_DIR": root, "JOBS_DIR": root / "jobs", "DB_PATH": root / "queue.sqlite3",
            "TOKEN_PATH": root / "access_token.txt",
            "AI_SETTINGS": server.agent_cli.BackendSettings(root / "ai-settings.json"),
        }.items():
            stack.enter_context(patch.object(server, key, value))
        stack.enter_context(patch.object(server, "seed_demo"))
        yield server.init_storage()


if __name__ == "__main__":
    with isolated_queue() as token:
        http = server.ThreadingHTTPServer(("127.0.0.1", 8878), server.AppHandler)
        http.access_token = token
        try:
            http.serve_forever()
        finally:
            http.server_close()
