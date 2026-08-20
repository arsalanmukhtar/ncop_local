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
        _warm_up_translation_model()


def _warm_up_translation_model():
    """Pre-loads the local NLLB Urdu-translation model (see translate.py)
    on a background thread at process start, instead of lazily on the
    first real /api/translate/ request. A real production 504 was traced
    to nginx's gateway timeout expiring while the FIRST request had to
    pay the ~2.4GB cold-load cost itself, on top of actually translating.
    Loading it here means that cost happens once, off the request path,
    before any real user ever reaches the endpoint — by the time a real
    request arrives, translate.py's own _get_model() singleton is already
    populated and returns instantly.

    Fire-and-forget: translate.py's _get_model() already handles/logs a
    load failure gracefully, and every caller already tolerates a slow or
    failed load (falls back to English text) — this thread finishing
    late, or failing outright, never blocks Django startup or breaks
    anything; it's a pure head-start, not a new dependency.

    Skipped in the autoreloader's own watcher process (the outer
    `manage.py runserver` process before its child spawns) — that process
    never serves a real request, so warming the ~1.2GB model there is
    pure waste; moot for production (Waitress has no such watcher, so
    `is_reloader_watcher` is always False there).

    Deliberately delayed a few seconds rather than starting immediately:
    `ready()` runs BEFORE urls.py/views.py get imported, which is where
    initialize_earth_engine() fires (a real network + native-library init
    of its own, observed taking 20+ seconds under a flaky connection) —
    starting PyTorch's own native model load at the exact same moment
    would run it genuinely concurrently with that. This app has ALREADY
    hit one confirmed, reproduced native-library crash from underestimated
    concurrency (GDAL/PROJ — see the widened _MON_PRED_GDAL_LOCK in
    views.py); PyTorch and grpc/Earth Engine's own native code aren't
    known to share that specific failure mode, but there's no upside to
    testing that the hard way on production. A short delay costs nothing
    real — a live translate request is never going to land within seconds
    of a fresh deploy — and meaningfully shrinks the overlap window."""
    is_reloader_watcher = "runserver" in sys.argv and os.environ.get("RUN_MAIN") != "true"
    if is_reloader_watcher:
        return
    try:
        from . import translate
    except Exception:
        return
    timer = threading.Timer(15.0, translate.warm_up)
    timer.name = "nllb-warmup-timer"
    timer.daemon = True
    timer.start()


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
