from __future__ import annotations

import json
import os
import runpy
import sys
import time
import traceback
import ctypes
from pathlib import Path
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parent
SERVER = ROOT / "server.py"
LOG_DIR = ROOT / "data" / "logs"
HEALTH_URL = "http://127.0.0.1:8876/api/health"
MUTEX_NAME = "Local\\CultureSubtitleWorkbenchSupervisor"


def server_is_healthy() -> bool:
    try:
        with urlopen(HEALTH_URL, timeout=2) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return response.status == 200 and payload.get("ok") is True
    except Exception:
        return False


def main() -> None:
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.windll.kernel32.GetLastError() == 183:
        ctypes.windll.kernel32.CloseHandle(mutex)
        return
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with (
            (LOG_DIR / "autostart-server.log").open("a", encoding="utf-8", buffering=1) as stdout_log,
            (LOG_DIR / "autostart-server-error.log").open("a", encoding="utf-8", buffering=1) as stderr_log,
        ):
            sys.stdout = stdout_log
            sys.stderr = stderr_log
            os.chdir(ROOT)
            while True:
                if server_is_healthy():
                    time.sleep(15)
                    continue
                sys.argv = [str(SERVER)]
                try:
                    runpy.run_path(str(SERVER), run_name="__main__")
                except BaseException:
                    traceback.print_exc(file=stderr_log)
                time.sleep(5)
    finally:
        ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
