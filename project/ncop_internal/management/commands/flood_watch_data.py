"""Data jobs of the National Flood Watch early-warning layer.

    python manage.py flood_watch_data --backfill   # once, about 15 minutes
    python manage.py flood_watch_data --update     # every 6 hours, about 1 minute
    python manage.py flood_watch_data --atlas      # once: districts, people and facilities on flood plains
    python manage.py flood_watch_data --hydraulic  # once, about an hour on 8 cores: depth and arrival catalogue
    python manage.py flood_watch_data --action pre-season --status done --by "PDMA Punjab" --note "..."
    python manage.py flood_watch_data --maps       # once: national flood-susceptibility map and its test
"""

import time

from django.core.management.base import BaseCommand, CommandError

from ncop_internal import flood_eo, flood_store


class Command(BaseCommand):
    help = "Fill or refresh the flood-watch river, rain and exposure stores"

    def add_arguments(self, p):
        for a in ("--backfill", "--update", "--atlas", "--maps", "--hydraulic"):
            p.add_argument(a, action="store_true")
        p.add_argument("--action", metavar="ID", help="record what an organisation reported about an open action")
        p.add_argument("--status", choices=("open", "in progress", "done"))
        p.add_argument("--by", help="who reported it")
        p.add_argument("--note")

    def handle(self, *a, **o):
        t = time.time()
        if o["action"]:
            from ncop_internal import flood_ops
            try:
                self.stdout.write(str(flood_ops.report_status(o["action"], o["status"], o["by"], o["note"])))
            except (KeyError, ValueError) as e:
                raise CommandError(e.args[0])
            return
        say = lambda s: self.stdout.write(f"[{time.time() - t:5.0f}s] {s}")
        if o["backfill"] or o["update"]:
            flood_store.refresh(full=o["backfill"])
            say("FFD history stored")
            say(str(flood_eo.refresh(backfill=o["backfill"], log=say)))
        if o["atlas"]:
            from ncop_internal import flood_atlas
            say(str(flood_atlas.build(log=say)))
        if o["maps"]:
            from ncop_internal import flood_suscept
            say(str(flood_suscept.build(log=say)))
        if o["hydraulic"]:
            from ncop_internal import flood_hydraulic
            say(str(flood_hydraulic.build(log=say)))
