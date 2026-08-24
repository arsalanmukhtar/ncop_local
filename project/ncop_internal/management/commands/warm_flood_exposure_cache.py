# project/ncop_internal/management/commands/warm_flood_exposure_cache.py
# ---------------------------------------------------------------------------
# Addresses the "highest priority" production recommendation from the Phase
# 1.5 optimization pass (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md): the
# Overture buildings fetch alone is confirmed live at ~225-270s cold, and the
# full flood_exposure.build_exposure_report() call is ~71s even on a WARM
# cache (roads/drainage network-length computation, §0.11) — both are far
# beyond any reasonable nginx proxy_read_timeout if ever triggered inline by
# a real HTTP request. This command exists so that pre-warming happens as an
# explicit deployment/setup step, run by an operator or a deploy script,
# never lazily on first user request.
#
# Usage:
#   python manage.py warm_flood_exposure_cache                # all pilot catchments
#   python manage.py warm_flood_exposure_cache nullah_lai      # one catchment
#   python manage.py warm_flood_exposure_cache --force         # rebuild every cache
# ---------------------------------------------------------------------------

import time

from django.core.management.base import BaseCommand, CommandError

from ncop_internal import flood_exposure, flood_model


class Command(BaseCommand):
    help = (
        "Pre-warms the flood-model/flood-exposure disk caches (HAND pipeline, "
        "Overture buildings, OSM bridges/hospitals/roads/drainage) for one or "
        "all pilot catchments. Run this as a deployment/setup step — never "
        "let a live HTTP request trigger the first (cold) build of these "
        "caches; the Overture buildings fetch alone is confirmed live at "
        "~225-270s."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "catchment", nargs="?", default=None,
            help="Catchment key to warm (default: every known pilot catchment).",
        )
        parser.add_argument(
            "--force", action="store_true",
            help="Rebuild every cache even if already present (default: skip what's already warm).",
        )

    def handle(self, *args, **options):
        catchment_arg = options["catchment"]
        force = options["force"]

        if catchment_arg:
            if catchment_arg not in flood_model.PILOT_CATCHMENTS:
                raise CommandError(
                    f"Unknown catchment {catchment_arg!r} - known: {list(flood_model.PILOT_CATCHMENTS)}"
                )
            catchments = [catchment_arg]
        else:
            catchments = list(flood_model.PILOT_CATCHMENTS)

        failures = []
        for key in catchments:
            self.stdout.write(f"Warming caches for catchment {key!r} (force={force})...")
            t0 = time.time()
            try:
                report = flood_exposure.build_exposure_report(key, force=force)
            except Exception as exc:
                self.stderr.write(self.style.ERROR(f"  FAILED for {key!r}: {exc}"))
                failures.append(key)
                continue
            elapsed = time.time() - t0
            population = report.get("population") or {}
            self.stdout.write(self.style.SUCCESS(
                f"  done in {elapsed:.1f}s - flood_zone_km2={report['flood_zone_km2']}, "
                f"buildings_source={report['buildings'].get('source')}, "
                f"buildings_in_zone={report['buildings']['buildings_in_flood_zone']}, "
                f"roads_in_zone_km={report['roads']['length_in_flood_zone_km']}, "
                f"drainage_in_zone_km={report['drainage']['length_in_flood_zone_km']}, "
                f"population_in_zone={population.get('total', 'n/a')}"
            ))

        if failures:
            raise CommandError(f"Failed to warm caches for: {failures}")
        self.stdout.write(self.style.SUCCESS(
            f"All {len(catchments)} requested catchment(s) warmed successfully."
        ))
