"""Scheduled, windowless controller; a failure exits so Task Scheduler can retry."""
from server_control import main, ROOT
import traceback

if __name__ == '__main__':
    try:
        main()
    except Exception:
        folder = ROOT / 'data/logs'
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / 'server-control-error.log').open('a', encoding='utf-8') as log:
            traceback.print_exc(file=log)
        raise SystemExit(1)
