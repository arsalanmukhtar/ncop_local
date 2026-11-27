# project/ncop_internal/management/commands/warm_hawanama_cache.py
# ---------------------------------------------------------------------------
# Pre-warms NCOP's Hawanama (Pakistan Air Quality Initiative) caches so the
# first user to open an Air Quality layer never waits on an upstream fetch:
# the JSON endpoints (stations, nowcast, fire outlook/seasons, tile dates,
# providers, health), the rendered forecast frames, and the newest day(s)
# of daily PM2.5 estimate tiles at the zooms a national view actually uses.
#
# Run on a timer (see deploy/hawanama-warm.timer.reference): every 30 min
# keeps every JSON cache inside its TTL; tiles for a completed day are
# fetched once and kept forever (they never change), so later runs only
# request tiles that are not on disk yet.
#
# Usage:
#   python manage.py warm_hawanama_cache                  # JSON + newest day's tiles, z5-8
#   python manage.py warm_hawanama_cache --days 3 --max-zoom 9
#   python manage.py warm_hawanama_cache --no-tiles
# ---------------------------------------------------------------------------

import math
import time
from concurrent.futures import ThreadPoolExecutor

from django.core.management.base import BaseCommand

from ncop_internal import hawanama_client as hc


def _tiles_for_bounds(z, bounds):
    w, s, e, n = bounds

    def tx(lon):
        return int((lon + 180.0) / 360.0 * 2 ** z)

    def ty(lat):
        r = math.radians(lat)
        return int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * 2 ** z)

    for x in range(tx(w), tx(e) + 1):
        for y in range(ty(n), ty(s) + 1):
            if hc.tile_in_coverage(z, x, y):
                yield x, y


class Command(BaseCommand):
    help = "Pre-warms the Hawanama air-quality caches (JSON endpoints, forecast frames, daily estimate tiles)."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=1, help="Newest N complete days of tiles to warm (default 1).")
        parser.add_argument("--min-zoom", type=int, default=5)
        parser.add_argument("--max-zoom", type=int, default=8)
        parser.add_argument("--workers", type=int, default=4, help="Concurrent tile requests (keep small: shared upstream).")
        parser.add_argument("--no-tiles", action="store_true")

    def _step(self, name, fn):
        t = time.time()
        try:
            result = fn()
            self.stdout.write(f"  ok    {name:<22} {time.time() - t:5.1f}s  {result}")
            return True
        except Exception as e:
            self.stdout.write(self.style.WARNING(f"  FAIL  {name:<22} {time.time() - t:5.1f}s  {type(e).__name__}: {e}"))
            return False

    def handle(self, *args, **opts):
        started = time.time()
        self.stdout.write("Warming Hawanama JSON caches…")
        ok = [
            self._step("stations", lambda: f"{len(hc.stations_geojson()['features'])} features"),
            self._step("nowcast", lambda: f"{len(hc.nowcast_geojson()['features'])} features"),
            self._step("forecast frames", lambda: f"{len(hc.forecast_frames(lambda n: n)['frames'])} frames"),
            self._step("fires outlook", lambda: f"{len(hc.fires_outlook_geojson()['features'])} cities"),
            self._step("fire season punjab", lambda: f"{len(hc.fire_season('punjab')['years'])} years"),
            self._step("fire season IN punjab", lambda: f"{len(hc.fire_season('indian-punjab')['years'])} years"),
            self._step("health", lambda: f"{len(hc.health()['upstream_sources'] or [])} sources"),
        ]
        dates = []
        if self._step("tile dates", lambda: f"{len(hc.tile_dates()['dates'])} dates"):
            dates = hc.tile_dates()["dates"][-max(opts["days"], 1):]
            for d in dates:
                self._step(f"stations daily {d}", lambda d=d: f"{len(hc.stations_daily_geojson(d)['features'])} features")

        if not opts["no_tiles"] and dates:
            jobs = [(d, z, x, y) for d in dates
                    for z in range(opts["min_zoom"], opts["max_zoom"] + 1)
                    for x, y in _tiles_for_bounds(z, hc.TILE_BOUNDS)]
            self.stdout.write(f"Warming {len(jobs)} tiles for {', '.join(dates)} (z{opts['min_zoom']}-{opts['max_zoom']})…")
            counts = {"ok": 0, "failed": 0}

            def fetch(job):
                try:
                    hc.tile_png(*job)
                    return True
                except Exception:
                    return False

            t = time.time()
            with ThreadPoolExecutor(max_workers=max(1, min(opts["workers"], 8))) as pool:
                for good in pool.map(fetch, jobs):
                    counts["ok" if good else "failed"] += 1
            self.stdout.write(f"  tiles: {counts['ok']} ok, {counts['failed']} failed in {time.time() - t:.1f}s")

        status = "done" if all(ok) else "done with failures (cached copies are still served)"
        self.stdout.write(self.style.SUCCESS(f"Hawanama warm-up {status} in {time.time() - started:.1f}s"))
