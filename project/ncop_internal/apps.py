import atexit
import faulthandler
import os
import sys
import threading
import traceback
from datetime import datetime

from django.apps import AppConfig


class NcopInternalConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'ncop_internal'

    def ready(self):
        _install_crash_diagnostics()


def _install_crash_diagnostics():
    """Belt-and-braces crash logging — the server has died silently before
    (ERR_CONNECTION_REFUSED, terminal back at the prompt, zero traceback
    visible), which rules out an ordinary Python-level exception: those
    always print a traceback and, for a background thread, don't even
    kill the process. What DOES kill a process with no Python traceback is
    a native/C-extension fault (a segfault/access-violation inside GDAL,
    rasterio, or Earth Engine's grpc code — all real dependencies of this
    app, several called from ThreadPoolExecutor workers). `faulthandler`
    is the one thing that can catch that class of crash at all, since it
    hooks the OS's own fault delivery rather than Python's exception
    machinery. Everything else here is redundant-but-cheap coverage for
    the ordinary-exception case, in case a real one really is getting
    lost somewhere.

    Deliberately does NOT touch file descriptors (an earlier version
    dup2'd stderr through a pipe to also mirror it into crash.log — that
    was reverted after it correlated with the dev server going fully
    unreachable: ERR_CONNECTION_REFUSED right after a clean-looking
    startup banner, i.e. something hung before the socket ever started
    listening. Not worth the risk for what was only a durability nicety —
    faulthandler on sys.stderr is still fully live in the terminal, just
    not additionally mirrored to disk.

    Runs once per process; harmless if it runs twice (e.g. the
    autoreloader's watcher process AND its serving child process each
    call this once — separate PIDs, each just opens its own log handle)."""
    from django.conf import settings

    logs_dir = settings.BASE_DIR / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    crash_log = open(logs_dir / "crash.log", "a", buffering=1, encoding="utf-8")
    crash_log.write(f"\n{'=' * 70}\n[{datetime.now().isoformat()}] worker started (pid {os.getpid()})\n")

    # Live in the terminal, as the crash happens — this is the actual gap:
    # faulthandler isn't enabled by default under `manage.py runserver`, so
    # a native fault currently produces NO output at all, anywhere.
    faulthandler.enable(file=sys.stderr, all_threads=True)

    try:  # line-buffer stdout/stderr so a print right before a crash isn't lost to buffering
        sys.stdout.reconfigure(line_buffering=True)
        sys.stderr.reconfigure(line_buffering=True)
    except Exception:
        pass

    def _log_main_exception(exc_type, exc_value, exc_tb):
        crash_log.write(f"\n[{datetime.now().isoformat()}] UNHANDLED MAIN-THREAD EXCEPTION\n")
        traceback.print_exception(exc_type, exc_value, exc_tb, file=crash_log)
        crash_log.flush()
        sys.__excepthook__(exc_type, exc_value, exc_tb)

    def _log_thread_exception(args):
        crash_log.write(f"\n[{datetime.now().isoformat()}] UNHANDLED EXCEPTION IN THREAD '{args.thread.name}'\n")
        traceback.print_exception(args.exc_type, args.exc_value, args.exc_traceback, file=crash_log)
        crash_log.flush()
        threading.__excepthook__(args)

    def _log_exit():
        crash_log.write(f"[{datetime.now().isoformat()}] worker exiting (pid {os.getpid()})\n")
        crash_log.flush()

    sys.excepthook = _log_main_exception
    threading.excepthook = _log_thread_exception
    atexit.register(_log_exit)
