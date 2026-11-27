# project/ncop_internal/management/commands/warm_gefs.py
# ---------------------------------------------------------------------------
# Builds the newest complete NOAA GEFS 00Z run (35-day outlook) so users
# never wait on NOAA: ~280 small range requests, ~30 s, ~2.5 MB on disk per
# run (two runs kept). The 00Z run's days 1-16 upload ~04-07 UTC and its
# extension to day 35 later; only a COMPLETE run is built, so running every
# 3 h picks each new run up within hours of completion.
#
# Run on a timer (see deploy/gefs-warm.timer.reference).
#   python manage.py warm_gefs            # build newest complete run if missing
#   python manage.py warm_gefs --run 2026111900
# ---------------------------------------------------------------------------

from django.core.management.base import BaseCommand, CommandError

from ncop_internal import gefs_client as gc
from ncop_internal import gefs_districts as gd


class Command(BaseCommand):
    help = "Builds the newest complete NOAA GEFS 35-day outlook run (precipitation + 2 m temperature frames)."

    def add_arguments(self, parser):
        parser.add_argument("--run", help="Specific run (YYYYMMDD00) instead of the newest complete one.")

    def handle(self, *args, **opts):
        run = opts.get("run")
        if run:
            ok = gc.build_run(run)
        else:
            served = gc.refresh(force_check=True)
            self.stdout.write(f"serving run: {served}  ({gc.health()})")
            self._districts()
            return
        if not ok:
            raise CommandError("another GEFS build is running")
        self.stdout.write(f"built {run}")
        self._districts()

    def _districts(self):
        # Per-district table for the Weather Report panel (one-time boundary
        # index, then ~0.5 s per run). Never fails the warm-up itself.
        try:
            gd.ensure_index(block=True)
            n = len(gd.district_stats("precip")["districts"])
            self.stdout.write(f"district table ready: {n} districts")
        except Exception as e:
            self.stdout.write(f"district table skipped: {e}")
