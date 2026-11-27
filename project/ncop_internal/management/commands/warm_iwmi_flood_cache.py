# project/ncop_internal/management/commands/warm_iwmi_flood_cache.py
# ---------------------------------------------------------------------------
# Pre-warms NCOP's IWMI flood-forecasting caches (iwmi_flood_client.py) so
# no user waits on a cold fetch: the regional Flood Hub gauge list alone is
# ~20 s cold (13 countries), and the GloFAS forecast-day slider needs every
# point's discharge series (~270 calls per GloFAS run, fetched once per run
# and kept). Run on a timer (deploy/iwmi-flood-warm.timer.reference).
#
# Usage:
#   python manage.py warm_iwmi_flood_cache
#   python manage.py warm_iwmi_flood_cache --workers 2
# ---------------------------------------------------------------------------

import time

from django.core.management.base import BaseCommand

from ncop_internal import iwmi_flood_client as ic


class Command(BaseCommand):
    help = "Pre-warms the IWMI flood-forecasting caches (GloFAS points + series, Flood Hub gauges, inundation, status)."

    def add_arguments(self, parser):
        parser.add_argument("--workers", type=int, default=4, help="Concurrent series fetches (keep small: shared upstream).")

    def _step(self, name, fn):
        t = time.time()
        try:
            result = fn()
            self.stdout.write(f"  ok    {name:<24} {time.time() - t:5.1f}s  {result}")
            return True
        except Exception as e:
            self.stdout.write(self.style.WARNING(f"  FAIL  {name:<24} {time.time() - t:5.1f}s  {type(e).__name__}: {e}"))
            return False

    def handle(self, *args, **opts):
        started = time.time()
        self.stdout.write(f"Warming IWMI flood caches for {', '.join(ic.countries())}…")
        ok = [self._step("GloFAS points", lambda: f"{ic.glofas_points_geojson()['metadata']['count']} points")]

        def series():
            pts = ic.glofas_points_geojson()["features"]
            pairs = [(f["properties"]["id"], f["properties"]["forecast_date"]) for f in pts]
            good, bad = ic.prefetch_series(pairs, workers=max(1, min(opts["workers"], 8)))
            return f"{len(pairs)} points: {good} fetched, {bad} failed, {len(pairs) - good - bad} already cached"

        ok.append(self._step("GloFAS discharge series", series))
        ok.append(self._step("GloFAS forecast days", lambda: f"{ic.glofas_forecast_days_geojson()['metadata']['count']} points"))
        ok.append(self._step("Flood Hub gauges", lambda: f"{ic.floodhub_gauges_geojson()['metadata']['count']} gauges"))
        ok.append(self._step("Flood Hub inundation", lambda: f"{ic.floodhub_inundation_geojson()['metadata']['count']} polygons"))
        ok.append(self._step("regional status", lambda: f"{len(ic.regional_status()['countries'])} countries"))
        status = "done" if all(ok) else "done with failures (cached copies are still served)"
        self.stdout.write(self.style.SUCCESS(f"IWMI flood warm-up {status} in {time.time() - started:.1f}s"))
