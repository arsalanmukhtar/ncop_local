# project/ncop_internal/cached_fetch.py
# ---------------------------------------------------------------------------
# A small reusable "cached JSON proxy" core for NCOP's third-party data
# integrations — the same policy hawanama_client.py established, packaged
# so new integrations (iwmi_flood_client.py) don't re-implement it:
#   - per-key TTL; a fresh in-memory or on-disk copy is served without an
#     upstream call;
#   - when a refresh fails, the last good copy is served with stale=True,
#     and that key is not retried for `backoff_seconds`, so an outage costs
#     one timeout per key, not one per request;
#   - `validate(payload)` must accept a response before it is cached, so an
#     upstream shape change is never cached as good data;
#   - one refresh per key at a time (concurrent callers wait, then read).
# With no copy at all, get() raises Unavailable.
# ---------------------------------------------------------------------------

import hashlib
import json
import logging
import os
import re
import threading
import time

import requests
from django.conf import settings

logger = logging.getLogger(__name__)


class Unavailable(Exception):
    """No fresh or cached copy of the requested upstream data exists."""


class CachedJsonClient:
    def __init__(self, name, base_url, ttl_seconds, cache_subdir, user_agent,
                 timeout_seconds=30, backoff_seconds=300):
        """`base_url` may be a string or a zero-arg callable (read per call,
        so a settings override applies without a restart). `ttl_seconds` maps
        a TTL name to seconds; a key's TTL name is its prefix before ':'
        unless get(ttl_name=...) says otherwise."""
        self.name = name
        self._base_url = base_url
        self.ttl_seconds = ttl_seconds
        self.cache_subdir = cache_subdir
        self.timeout_seconds = timeout_seconds
        self.backoff_seconds = backoff_seconds
        self._user_agent = user_agent
        self._session = None
        self._session_lock = threading.Lock()
        self._mem = {}
        self._mem_lock = threading.Lock()
        self.last_failure = {}
        self._key_locks = {}
        self._key_locks_guard = threading.Lock()

    # -- plumbing -----------------------------------------------------------

    def base_url(self):
        url = self._base_url() if callable(self._base_url) else self._base_url
        return url.rstrip("/")

    def session(self):
        with self._session_lock:
            if self._session is None:
                s = requests.Session()
                s.headers.update({"User-Agent": self._user_agent, "Accept": "application/json"})
                self._session = s
            return self._session

    def cache_dir(self):
        path = os.path.join(settings.MEDIA_ROOT, self.cache_subdir)
        os.makedirs(path, exist_ok=True)
        return path

    def _cache_file(self, key):
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", key)
        if len(safe) > 120:
            safe = safe[:80] + "_" + hashlib.sha1(key.encode()).hexdigest()[:16]
        return os.path.join(self.cache_dir(), f"{safe}.json")

    def _key_lock(self, key):
        with self._key_locks_guard:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = self._key_locks[key] = threading.Lock()
            return lock

    def http_get(self, path, params=None):
        resp = self.session().get(f"{self.base_url()}/{path.lstrip('/')}", params=params,
                                  timeout=self.timeout_seconds)
        resp.raise_for_status()
        return resp.json()

    def _read_disk(self, key):
        path = self._cache_file(key)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return os.path.getmtime(path), json.load(f)
        except (OSError, ValueError):
            logger.warning("%s: unreadable cache file %s", self.name, path, exc_info=True)
            return None

    def _write_disk(self, key, payload):
        path = self._cache_file(key)
        tmp = f"{path}.tmp{os.getpid()}.{threading.get_ident()}"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(payload, f)
            os.replace(tmp, path)
        except OSError:
            logger.warning("%s: could not write cache file %s", self.name, path, exc_info=True)

    def peek(self, key):
        """The cached payload for `key` (memory, then disk) regardless of
        age, or None — never contacts upstream."""
        with self._mem_lock:
            hit = self._mem.get(key)
        if hit:
            return hit[1]
        disk = self._read_disk(key)
        if disk is not None:
            with self._mem_lock:
                self._mem[key] = disk
            return disk[1]
        return None

    # -- main entry ---------------------------------------------------------

    def get(self, key, path, params=None, ttl_name=None, validate=None):
        """Returns (payload, meta) with meta = {"fetched_at", "stale",
        "source": "memory"|"disk"|"upstream"|"stale-cache"}."""
        ttl = self.ttl_seconds[ttl_name or key.split(":", 1)[0]]
        with self._mem_lock:
            hit = self._mem.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1], {"fetched_at": hit[0], "stale": False, "source": "memory"}

        with self._key_lock(key):
            with self._mem_lock:
                hit = self._mem.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1], {"fetched_at": hit[0], "stale": False, "source": "memory"}
            if hit is None:
                disk = self._read_disk(key)
                if disk is not None:
                    with self._mem_lock:
                        self._mem[key] = disk
                    hit = disk
                    if time.time() - disk[0] < ttl:
                        return disk[1], {"fetched_at": disk[0], "stale": False, "source": "disk"}

            if time.time() - self.last_failure.get(key, 0) >= self.backoff_seconds:
                try:
                    payload = self.http_get(path, params)
                    if validate is not None and not validate(payload):
                        raise ValueError(f"unexpected response shape for {path}")
                except Exception:
                    self.last_failure[key] = time.time()
                    logger.warning("%s: refresh failed for %s (%s)", self.name, key, path, exc_info=True)
                else:
                    self.last_failure.pop(key, None)
                    fetched = time.time()
                    with self._mem_lock:
                        self._mem[key] = (fetched, payload)
                    self._write_disk(key, payload)
                    return payload, {"fetched_at": fetched, "stale": False, "source": "upstream"}

            if hit is not None:
                return hit[1], {"fetched_at": hit[0], "stale": True, "source": "stale-cache"}
            raise Unavailable(f"{self.name}: data unavailable for {key}")

    def cache_state(self, exclude_prefixes=()):
        now = time.time()
        with self._mem_lock:
            items = list(self._mem.items())
        cache = {k: {"age_s": round(now - v[0]), "ttl_s": self.ttl_seconds.get(k.split(":", 1)[0])}
                 for k, v in items if not k.startswith(tuple(exclude_prefixes))}
        failing = {k: round(now - t) for k, t in self.last_failure.items() if now - t < self.backoff_seconds}
        return {"cache": cache, "failing_keys_seconds_ago": failing}

    def reset(self):
        """Test helper: forget every in-memory entry and failure."""
        with self._mem_lock:
            self._mem.clear()
        self.last_failure.clear()
