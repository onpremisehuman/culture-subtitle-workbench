"""User-launched, windowless entry point. No registry, service or firewall changes."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent
HEALTH_URL = 'http://127.0.0.1:8876/api/health'
WORKBENCH_URL = 'http://127.0.0.1:8876/app/'


def server_ready() -> bool:
    try:
        with urlopen(HEALTH_URL, timeout=1) as response:
            data = json.load(response)
            return response.status == 200 and data.get('ok') is True and data.get('service') == '문화자막 큐'
    except (OSError, ValueError):
        return False


def start_server(lan: bool = False, timeout: float = 25) -> bool:
    """Return True if a start was requested, False if already healthy."""
    if lan:
        raise ValueError('공개판의 자동 시작은 이 PC에서만 지원합니다.')
    if server_ready():
        return False
    # Use this launcher's exact interpreter, never py.exe's changing default.
    pythonw = Path(sys.executable).with_name('pythonw.exe')
    if not pythonw.is_file():
        raise RuntimeError('Python 실행 파일을 찾지 못했습니다. 빠른실행_설치.ps1을 다시 실행해주세요.')
    script = ROOT / 'culture-subtitle-autostart.pyw'
    if not script.is_file():
        raise RuntimeError('문화자막 서버 실행기가 없습니다.')
    subprocess.Popen(
        [str(pythonw), str(script)], cwd=ROOT,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), close_fds=True,
    )
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if server_ready():
            return True
        time.sleep(.25)
    raise RuntimeError('서버가 아직 준비되지 않았습니다. 잠시 후 다시 누르세요.\n로그 위치: ' + str(ROOT / 'data/logs'))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--lan', action='store_true', help='Use the existing trusted-network server mode')
    parser.add_argument('--no-browser', action='store_true', help='Start/check only')
    args = parser.parse_args()
    try:
        start_server(lan=args.lan)
        if not args.no_browser:
            webbrowser.open(WORKBENCH_URL)
        return 0
    except Exception as error:
        if args.no_browser:
            if sys.stderr:
                print(str(error), file=sys.stderr)
        elif os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, str(error), '문화자막 시작 실패', 0x10)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
