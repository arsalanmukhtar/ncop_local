"""Fill or refresh the district drought-indicator store (foodsec_eo).

    python manage.py foodsec_eo --backfill    # once, about 5 minutes
    python manage.py foodsec_eo --update      # monthly, about 10 seconds
"""

import time

from django.core.management.base import BaseCommand

from ncop_internal import foodsec_eo as eo


class Command(BaseCommand):
    help = "Refresh the CHIRPS / FLDAS / MODIS district store from Earth Engine"

    def add_arguments(self, p):
        p.add_argument("--backfill", action="store_true")
        p.add_argument("--update", action="store_true")

    def handle(self, *a, **o):
        t = time.time()
        res = eo.refresh(backfill=o["backfill"], log=lambda s: self.stdout.write(s))
        self.stdout.write(f"stored through {res} in {time.time() - t:.0f}s")
