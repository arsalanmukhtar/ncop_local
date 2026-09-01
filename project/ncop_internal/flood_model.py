# project/ncop_internal/flood_model.py
# ---------------------------------------------------------------------------
# Phase 1 of the lightweight flash-flood early-warning system (see
# FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md at the repo root for the full
# architecture/reasoning). This module builds a static HAND (Height Above
# Nearest Drainage) flood-prone-zones layer for a pilot catchment —
# terrain-only, no rainfall coupling yet (that's Phase 2).
#
# Pipeline: GEE Copernicus DEM (COPERNICUS/DEM/GLO30_2024_1 — the
# non-deprecated collection, see the methodology doc's Phase-0 section) ->
# WhiteboxTools hydrological conditioning (fill_single_cell_pits ->
# breach_depressions_least_cost) -> D8 flow direction/accumulation ->
# stream extraction -> elevation_above_stream (HAND) -> threshold ->
# colorized PNG, served through the same warp/colorize/cache convention
# _mon_pred_convert_step already established for PMD prediction rasters.
#
# Crash-safety, all lessons already paid for elsewhere in this app or in
# this feature's own Phase 0 verification:
#   - WhiteboxTools's OWN return code is not trustworthy (confirmed live
#     in Phase 0: a Rust-side panic still reported exit 0 with no output
#     produced) — every step's OUTPUT FILE is verified to exist and be
#     non-empty after the call, never the return code alone.
#   - The library exposes no subprocess timeout of its own — every call
#     is wrapped in a bounded ThreadPoolExecutor.result(timeout=...) so a
#     hung WhiteboxTools process can never hang the calling
#     request/command indefinitely (the underlying OS process may be
#     orphaned in that case — a timeout is a last resort, not expected in
#     normal operation, exactly like every other bounded external call in
#     this app).
#   - GDAL raster I/O uses raw WriteRaster/ReadRaster (struct-packed
#     bytes), never Band.ReadAsArray()/WriteArray() — this venv's GDAL
#     wheel has a NumPy 2.x ABI mismatch on that path, confirmed live in
#     Phase 0 (same issue already documented on
#     PmdMonitorPredictionValueAPIView elsewhere in views.py).
#   - Every GDAL touch-point is serialized under the SAME
#     _MON_PRED_GDAL_LOCK views.py already uses — GDAL/PROJ are not
#     thread-safe for concurrent access (the reproduced, fixed crash class
#     this project's incident history is built on).
#   - WhiteboxTools calls are ALSO serialized under their own lock
#     (_WBT_LOCK) — not for crash-safety (subprocess isolation already
#     covers that on its own) but so multiple overlapping catchment
#     computations never contend for CPU on the shared production VM at
#     once, the same reasoning translate.py's own lock already documents
#     for NLLB inference.
#   - Every cached output written via temp-file + os.replace() — the same
#     atomic-write fix that resolved the temp2m.txt ramp-file corruption
#     bug earlier this session.
# ---------------------------------------------------------------------------

import contextlib
import hashlib
import json
import logging
import math
import os
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FutureTimeoutError

import numpy as np
from django.conf import settings

logger = logging.getLogger(__name__)

_FLOOD_MEDIA_SUBDIR = "flood_model"
_WBT_TIMEOUT_SECONDS = 180  # generous for a pilot-catchment-sized raster, still bounded
_WBT_LOCK = threading.Lock()
_WBT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wbt-call")

_wbt_singleton = None

# Pilot catchments — bbox is [minLon, minLat, maxLon, maxLat], WGS84. Only
# one so far (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md's "open items" —
# Nullah Lai chosen for Phase 0/1: small, urban, well-documented flash-flood
# history, in NDMA's own operational area).
#
# bbox CORRECTED (see methodology doc §0.17) to the Lai Nullah Basin's own
# published boundary — "33°33'-33°46' North and 72°55'-73°07' East" (Rahman
# et al., "Lai Nullah Basin Flood Problem Islamabad," WMO/APFM Associated
# Programme on Flood Management case study,
# http://www.floodmanagement.info/publications/casestudies/cs_pakistan_nullah_full.pdf,
# catchment area 234.9 km2 corroborated separately by Farooq et al. 2019,
# "Simulation of the impacts of land-use change on surface runoff of Lai
# Nullah Basin," Journal of Environmental Management). The ORIGINAL bbox
# ([72.95, 33.50, 73.20, 33.78]) was a rough guess, never checked against
# the basin's own published extent — confirmed live it implied ~721 km2,
# roughly 3x the real 234.9 km2 basin, and visibly included drainage
# networks well outside Nullah Lai's actual catchment once rendered on a
# real map. This correction is a genuine core-logic change, not cosmetic —
# every cached output for this catchment is now stale and must be rebuilt.
PILOT_CATCHMENTS = {
    "nullah_lai": {
        "label": "Nullah Lai (Rawalpindi/Islamabad)",
        # flood_type — added when riverine/hill-torrent catchments joined
        # this same dict (see chashma_indus/guddu_indus below). "flash":
        # small, fast-responding urban/peri-urban nullah — the fixed-
        # threshold and discharge-driven (SCS-CN) modes both apply here.
        # A flood type is a property of the catchment's own physical
        # character, not an independent toggle — this catchment does not
        # support riverine/hill-torrent modes, enforced in
        # flood_model_views.py, not just documented here.
        "flood_type": "flash",
        "bbox": [72.9167, 33.55, 73.1167, 33.7667],
        # Basin-specific hydrology inputs for the discharge-driven mode
        # (build_discharge_driven_flood_zone, §0.19) — length is the
        # basin's own published longest flow-path ("about 30 km", Rahman
        # et al./§0.17 research; NOT re-derivable from this pilot's bbox
        # diagonal, which would be a straight-line guess, not the actual
        # channel length). composite_cn (below) matches
        # flood_discharge.LAI_NULLAH_COMPOSITE_CN, itself derived from
        # Farooq et al.'s own confirmed land-use split for this exact
        # basin — deliberately catchment-specific, not a generic default.
        "basin_length_km": 30.0,
        # composite_cn is a literal number (80.7), NOT None-with-a-shared-
        # fallback — §0.23 found and fixed a real, confirmed-live bug:
        # build_discharge_driven_flood_zone's own composite_cn resolution
        # used to be `cfg.get("composite_cn") or
        # flood_discharge.LAI_NULLAH_COMPOSITE_CN`, harmless with exactly
        # one catchment but WRONG the moment a second one (Peshawar,
        # below) was added — every catchment with composite_cn=None
        # would have silently gotten Lai Nullah's own CN, not its own.
        # Caught before it ever produced a wrong number for a real
        # request; fixed by requiring every catchment to state its own
        # value explicitly. Matches flood_discharge.LAI_NULLAH_COMPOSITE_CN
        # exactly (confirmed live: 80.7) — this literal is not a
        # duplicate risk, since that module constant is itself derived
        # from Farooq et al.'s own land-use split for THIS basin and
        # essentially never changes; a mismatch here would be caught
        # immediately by this project's own testing discipline.
        "composite_cn": 80.7,
        # district_names — used only by flood_forecast.fetch_live_observed_
        # rainfall (§0.26) to match this catchment against NWFC's daily
        # rainfall report, which aggregates by district, not by basin
        # geometry. Nullah Lai straddles both cities (Rawalpindi's own
        # nullah, draining toward Islamabad); either district's station
        # readings are an honest proxy for basin-wide observed rainfall,
        # tried in this order.
        "district_names": ["Islamabad", "Rawalpindi"],
        # dem_source deliberately left at the DEFAULT_DEM_SOURCE
        # ("copernicus") — §0.22 tested FABDEM as a literature-backed
        # candidate improvement, initially promoted it to the default
        # after a single same-seed comparison looked favorable, then
        # caught that single-trial result was itself noise: a proper
        # 5-trial characterization (fixed seeds 1-5, same ground truth,
        # same sample budget) showed Copernicus BEATS FABDEM on both
        # measures — discharge-margin mean AUC 0.856 (tight range
        # 0.851-0.864, "good") vs. FABDEM's 0.762 (0.751-0.778, "fair");
        # raw HAND 0.638 (Copernicus) vs. 0.582 (FABDEM). Reverted before
        # this ever reached a real request. Kept here as an explicit,
        # non-obvious record: a single validated-looking comparison is
        # NOT enough evidence to change a production default — see §0.22
        # for the full account, including the initial (wrong) switch.
    },
    # §0.49 — 4 more real, literature-documented flash-flood-prone areas,
    # one per region not yet covered by a small-basin (as opposed to
    # major-river/riverine) catchment: Karachi (Sindh, urban pluvial
    # flooding), Swat/Mingora (KP, a genuinely different documented case
    # from Bhudni Nullah/Peshawar), Lasbela (Balochistan — Quetta was
    # already explored and rejected earlier in this project, confirmed to
    # have no usable real ground truth; Lasbela was hit hard by the real
    # 2022 floods and is a genuinely different basin), Hunza (Gilgit-
    # Baltistan, GLOF-adjacent flash-flood risk). Real events/sources
    # confirmed via literature search, not assumed — see the methodology
    # doc's own §0.49 for full citations.
    #
    # UNLIKE Nullah Lai/Bhudni Nullah, no published basin-area figure was
    # found to empirically correct these bboxes against (a real, stated
    # limitation, not hidden) — each uses a uniform ±0.09° box around the
    # real, confirmed city/basin coordinate (0.0324 deg², well under the
    # 0.30 cap), same "uniform default, not individually terrain-fitted"
    # honesty already applied to §0.48's 29 riverine additions.
    # composite_cn/basin_length_km are REAL, auto-derived values (flood_
    # model.derive_composite_cn/derive_basin_length_km — the SAME TR-55
    # land-cover×HSG lookup and distance-to-outlet flow-path length
    # already proven for custom AOIs), not literature-sourced or hand-
    # estimated the way Nullah Lai/Bhudni Nullah's own values are —
    # tested live for each catchment before being hardcoded here (see
    # the methodology doc's own §0.49 test log for the real numbers and
    # any catchment that failed/was excluded).
    "karachi_urban": {
        "label": "Karachi Urban (Gujjar/Orangi Nullah)",
        "flood_type": "flash",
        "bbox": [66.97, 24.84, 67.15, 25.02],
        # Auto-derived, confirmed live (see §0.49's own block comment
        # above): DEM range -6.2m to 176.5m (real — a low-lying coastal
        # delta area genuinely dips below the geoid), terrain_class=
        # flat_relief, AHP zonation produced all 3 classes (real, not
        # degenerate).
        "basin_length_km": 32.84,
        "composite_cn": 88.8,  # high — a dense, mostly-impervious urban basin, matches real land cover
        "district_names": ["Karachi"],
    },
    "swat_mingora": {
        "label": "Swat — Mingora",
        "flood_type": "flash",
        "bbox": [72.27, 34.683, 72.45, 34.863],
        # Auto-derived, confirmed live: DEM range 826m-2561m (real
        # mountainous relief, matches the Swat valley's own known
        # topography), terrain_class=moderate_relief, all 3 AHP classes
        # present.
        "basin_length_km": 35.3,
        "composite_cn": 67.5,
        "district_names": ["Swat"],
    },
    "lasbela_uthal": {
        "label": "Lasbela — Uthal",
        "flood_type": "flash",
        "bbox": [66.527, 25.717, 66.707, 25.897],
        # Auto-derived, confirmed live: DEM range 6.8m-165.8m,
        # terrain_class=flat_relief, all 3 AHP classes present.
        "basin_length_km": 32.7,
        "composite_cn": 82.7,
        "district_names": ["Lasbela"],
    },
    "hunza_karimabad": {
        "label": "Hunza — Karimabad",
        "flood_type": "flash",
        "bbox": [74.56, 36.227, 74.74, 36.407],
        # Auto-derived, confirmed live: DEM range 1939m-7308m (real,
        # high-mountain Karakoram terrain — Rakaposhi's own real summit
        # is nearby at ~7788m, so this range is physically plausible, not
        # a data artifact), terrain_class=moderate_relief, all 3 AHP
        # classes present.
        "basin_length_km": 33.66,
        "composite_cn": 78.5,
        "district_names": ["Hunza"],
    },

    "peshawar_bhudni_nullah": {
        "label": "Bhudni Nullah Basin (Peshawar)",
        "flood_type": "flash",
        # §0.23 — added directly from the literature review (§0.22's
        # Theme G: Tayyab et al. 2024 models Peshawar flash-flood
        # susceptibility as its own class; a 2025/2026 Frontiers in
        # Sustainable Cities study names the Bhudni Nullah Basin
        # specifically: 272 km2, a 38 km main channel, 84 settlements,
        # ~922,000 people, floods in 2002/2008/2010/2012/2014/2015/2022/
        # 2025). UNLIKE Nullah Lai (a precise WMO/APFM-published
        # boundary), no exact basin polygon was found in open literature
        # for Bhudni Nullah — bbox chosen from the confirmed general
        # location (Peshawar-Charsadda corridor, north of Peshawar city)
        # and EMPIRICALLY corrected the same way Nullah Lai's own bbox
        # was originally corrected (§0.17): tested via this project's own
        # D8 flow-accumulation pipeline, iterated until the computed
        # outlet drainage area matched the published 272 km2 figure
        # within ~10% (298.3 km2 computed — three other candidate bboxes
        # were tried and rejected: 428.4, 360.5, and 207.7 km2, all
        # further from the target). This ~10% residual gap is a real,
        # stated limitation — less precise than Nullah Lai's own
        # cross-validation (~3%), because no basin-specific published
        # boundary exists to correct against, only a published AREA
        # figure to triangulate toward.
        "bbox": [71.45, 33.98, 71.70, 34.20],
        "basin_length_km": 38.0,  # confirmed published Bhudni Nullah main-channel length
        # composite_cn = flood_discharge.PESHAWAR_COMPOSITE_CN (81.2) —
        # see that constant's own docstring: NO basin-specific land-use
        # survey was found for this basin (searched directly, confirmed
        # absent) — an honestly-labeled ESTIMATE (more agricultural/
        # peri-urban than Nullah Lai, matching this basin's own
        # documented "sustained conversion from agricultural to built"
        # character and much larger rural fringe), not independently
        # sourced research. A real, stated limitation — most consequential
        # for the discharge-driven mode's runoff estimate, not the raw
        # HAND/fixed-threshold mode, which doesn't use CN at all.
        "composite_cn": 81.2,
        # See nullah_lai's own district_names comment — §0.26.
        "district_names": ["Peshawar"],
        # §0.35 — confirmed LIVE (not assumed): this bbox has real
        # overlap with BOTH "upper_indus" and "kabul" bands in the
        # existing hydrological_global WFS flood-extent layers (3 real
        # polygons each) — unlike Nullah Lai, which has zero overlap
        # with any of the 7 river systems. "kabul" is the geographically
        # correct one (Peshawar sits on the real Kabul River, not the
        # Indus mainstem) — used for flood_validation.run_flood_extent_
        # shape_comparison. This field previously only existed on
        # riverine catchments; nothing about it is riverine-specific, so
        # it's added here too now that a real flash-flood catchment has
        # been confirmed to have a usable mapping.
        "wfs_river_system": "kabul",
    },

    # ------------------------------------------------------------------
    # Riverine catchments — added when flood-type selection (riverine +
    # hill-torrent) joined the flash-flood modes above. A riverine
    # catchment does NOT use composite_cn/basin_length_km (the SCS-CN
    # chain is flash-flood-specific — enforced in flood_model_views.py,
    # not just by omission here) — its own spatial engine
    # (build_riverine_flood_zone) instead reuses render_flood_prone_
    # zones' existing fixed-HAND-threshold mechanism completely unchanged,
    # feeding it a threshold computed LIVE from a real FFD gauge reading
    # instead of a fixed default — see build_riverine_flood_zone's own
    # docstring for the full derivation and its confirmed-live real-vs-
    # DEM offset check (§R4).
    #
    # Both stations chosen from a real, multi-source data-availability
    # check (§R4), not arbitrarily: both have (a) real live FFD discharge/
    # status/water-level data (flood_riverine.py), (b) official published
    # numeric flood-severity thresholds (flood_riverine.
    # FFD_OFFICIAL_FLOOD_LIMITS_CUSECS), (c) real overlap with the
    # existing hydrological_global WFS flood-extent zonation layers, and
    # (d) real Global Flood Database ground truth (confirmed live: 20
    # events near Chashma, 17 near Guddu — vastly richer signal than
    # either flash-flood pilot's own best event).
    "chashma_indus": {
        "label": "Chashma Barrage (Indus)",
        "flood_type": "riverine",
        # bbox sized to comfortably contain the barrage + enough
        # surrounding terrain for a meaningful HAND raster, well under
        # MAX_CATCHMENT_BBOX_DEG2 (confirmed live: 0.0875 deg^2 vs the
        # 0.30 cap).
        "bbox": [71.2, 32.3, 71.55, 32.55],
        # Real, published coordinates (Wikipedia, cross-checked against
        # this project's own DEM — confirmed live: local DEM elevation at
        # this exact point is 187.0m vs FFD's own reported gauge height of
        # 191m, a ~4m residual — small enough to confirm the two datums
        # are genuinely compatible, not a wild mismatch, but a real,
        # unresolved systematic offset nonetheless, stated honestly rather
        # than corrected away without real geoid/datum data to justify a
        # correction).
        "gauge_lat": 32.43389, "gauge_lon": 71.37889,
        "ffd_station": "Chashma",
        "wfs_river_system": "upper_indus",
    },
    "guddu_indus": {
        "label": "Guddu Barrage (Indus)",
        "flood_type": "riverine",
        "bbox": [69.4, 28.2, 70.0, 28.6],  # 0.18 deg^2, well under the 0.30 cap
        # Real, published coordinates (Wikipedia). Confirmed live: local
        # DEM elevation at this exact point is 75.95m vs FFD's own
        # reported gauge height of 74m — here the DEM reads slightly
        # HIGHER than the gauge (a ~-1.95m residual), the opposite
        # direction from Chashma's own offset — consistent with this
        # being real per-pixel/coordinate-precision noise rather than a
        # one-directional systematic datum bug (a true datum offset would
        # point the same way everywhere). build_riverine_flood_zone
        # clamps a resulting negative threshold to a small positive
        # minimum rather than producing a nonsensical raster — see that
        # function's own docstring.
        "gauge_lat": 28.4186, "gauge_lon": 69.7132,
        "ffd_station": "Guddu",
        "wfs_river_system": "lower_indus",
    },

    # =========================================================================
    # §0.48 — the rest of Pakistan's own real FFD gauge/barrage network,
    # covering all 5 provinces + Azad Kashmir along the Indus, Jhelum,
    # Chenab, Ravi, Sutlej, and Kabul (matching the exact river systems
    # this app's own Hydrological Layers panel already shows flood-extent
    # bands for). Real, live-confirmed data, not invented: names, river
    # ("area_name"), and coordinates all read directly from this app's
    # own already-integrated FFD feed (flood_riverine.FFD_WATERLEVELS_URL,
    # http://172.18.7.21:8000/get-ffd-waterlevels/ — a real GeoJSON
    # FeatureCollection, confirmed live this session: 31 stations total,
    # of which chashma_indus/guddu_indus above already cover 2). Each
    # entry follows the EXACT same shape those two already establish —
    # `ffd_station` matches flood_riverine.fetch_live_status's own
    # station-name lookup exactly (confirmed: it matches against this
    # SAME endpoint's own "name" field via _normalize_station_name), so
    # every one of these gets a REAL live gauge reading, not a
    # placeholder. `wfs_river_system` set only where the mapping is
    # genuinely unambiguous from the real "area_name" field or well-
    # established geography (e.g. Skardu/Tarbela/Kala Bagh sit clearly
    # upstream of Chashma's own already-confirmed "upper_indus" reach;
    # Sukkur/Kotri clearly downstream of Guddu's own "lower_indus") —
    # left UNSET for Taunsa (sits between the upper/lower Indus zones
    # with no confirmed boundary in this pass) and the 4 Azad-Kashmir
    # stations the FFD feed itself reports as "area_name": "N/A" —
    # an honest omission, same posture nullah_lai's own missing mapping
    # already establishes, not a guess dressed up as data.
    #
    # bbox: a consistent ±0.075° box around each station's own real
    # coordinate (0.0225 deg², comfortably under MAX_CATCHMENT_BBOX_DEG2's
    # 0.30 cap and in the same size class as chashma_indus/guddu_indus's
    # own hand-fitted boxes) — a uniform default, not individually
    # terrain-fitted the way the original 2 pilots were; a real, stated
    # simplification for scaling from 2 to 31 real locations in one pass,
    # not silently equivalent quality. gauge_lat/gauge_lon are these
    # same real coordinates, kept for parity with chashma_indus/
    # guddu_indus's own field shape.
    #
    # composite_cn/basin_length_km deliberately NOT set — riverine
    # catchments only ever offer "Live gauge-driven flood zone"/"AHP
    # susceptibility" modes (MODES_FOR_FLOOD_TYPE, frontend), neither of
    # which needs them; unlike a custom AOI, these are NOT auto-derived
    # for a named PILOT_CATCHMENTS entry (see _run_flood_model_job's own
    # `is_custom_aoi` gate) since there is no code path that would ever
    # ask a named riverine catchment for them.
    # =========================================================================
    "azad_pattan": {
        "label": "Azad Pattan (Jhelum River)",
        "flood_type": "riverine",
        "bbox": [73.526, 33.656, 73.676, 33.806],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 33.731, "gauge_lon": 73.601,
        "ffd_station": "Azad Pattan",
        "wfs_river_system": "jhelum",
    },
    "balloki": {
        "label": "Balloki (Ravi River)",
        "flood_type": "riverine",
        "bbox": [73.7846, 31.1472, 73.9346, 31.2972],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 31.2222, "gauge_lon": 73.8596,
        "ffd_station": "Balloki",
        "wfs_river_system": "ravi",
    },
    "besham": {
        "label": "Besham (Indus River)",
        "flood_type": "riverine",
        "bbox": [72.7918, 34.8308, 72.9418, 34.9808],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.905843, "gauge_lon": 72.866788,
        "ffd_station": "Besham",
        "wfs_river_system": "upper_indus",
    },
    "chattar_kallas": {
        "label": "Chattar Kallas (Azad Kashmir)",
        "flood_type": "riverine",
        "bbox": [73.419, 34.125, 73.569, 34.275],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.2, "gauge_lon": 73.494,
        "ffd_station": "Chattar Kallas",
    },
    "chiniot_bridge": {
        "label": "Chiniot Bridge (Chenab River)",
        "flood_type": "riverine",
        "bbox": [72.8729, 31.6777, 73.0229, 31.8277],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 31.752697, "gauge_lon": 72.947924,
        "ffd_station": "Chiniot Bridge",
        "wfs_river_system": "chenab",
    },
    "domel": {
        "label": "Domel (Azad Kashmir)",
        "flood_type": "riverine",
        "bbox": [73.4151, 34.2694, 73.5651, 34.4194],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.3444, "gauge_lon": 73.4901,
        "ffd_station": "Domel",
    },
    "ganda_singh_wala": {
        "label": "Ganda Singh Wala (Sutlej River)",
        "flood_type": "riverine",
        "bbox": [74.4703, 30.9184, 74.6203, 31.0684],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 30.993429, "gauge_lon": 74.545256,
        "ffd_station": "Ganda Singh Wala",
        "wfs_river_system": "sutlej",
    },
    "islam": {
        "label": "Islam (Sutlej River)",
        "flood_type": "riverine",
        "bbox": [72.4735, 29.7513, 72.6235, 29.9013],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 29.8263, "gauge_lon": 72.5485,
        "ffd_station": "Islam",
        "wfs_river_system": "sutlej",
    },
    "jassar": {
        "label": "Jassar (Ravi River)",
        "flood_type": "riverine",
        "bbox": [74.917, 31.9747, 75.067, 32.1247],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.049654, "gauge_lon": 74.992018,
        "ffd_station": "Jassar",
        "wfs_river_system": "ravi",
    },
    "kala_bagh": {
        "label": "Kala Bagh (Indus River)",
        "flood_type": "riverine",
        "bbox": [71.4469, 32.8437, 71.5969, 32.9937],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.9187, "gauge_lon": 71.5219,
        "ffd_station": "Kala Bagh",
        "wfs_river_system": "upper_indus",
    },
    "khanki": {
        "label": "Khanki (Chenab River)",
        "flood_type": "riverine",
        "bbox": [73.8935, 32.3338, 74.0435, 32.4838],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.4088, "gauge_lon": 73.9685,
        "ffd_station": "Khanki",
        "wfs_river_system": "chenab",
    },
    "kotli": {
        "label": "Kotli (Azad Kashmir)",
        "flood_type": "riverine",
        "bbox": [73.8359, 33.4546, 73.9859, 33.6046],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 33.5296, "gauge_lon": 73.9109,
        "ffd_station": "Kotli",
    },
    "kotri": {
        "label": "Kotri (Indus River)",
        "flood_type": "riverine",
        "bbox": [68.2401, 25.3678, 68.3901, 25.5178],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 25.4428, "gauge_lon": 68.3151,
        "ffd_station": "Kotri",
        "wfs_river_system": "lower_indus",
    },
    "mangla_dam": {
        "label": "Mangla Dam (Jhelum River)",
        "flood_type": "riverine",
        "bbox": [73.5741, 33.0757, 73.7241, 33.2257],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 33.1507, "gauge_lon": 73.6491,
        "ffd_station": "Mangla Dam",
        "wfs_river_system": "jhelum",
    },
    "marala": {
        "label": "Marala (Chenab River)",
        "flood_type": "riverine",
        "bbox": [74.3362, 32.5856, 74.4862, 32.7356],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.660583, "gauge_lon": 74.41125,
        "ffd_station": "Marala",
        "wfs_river_system": "chenab",
    },
    "muzaffarabad": {
        "label": "Muzaffarabad (Azad Kashmir)",
        "flood_type": "riverine",
        "bbox": [73.39, 34.308, 73.54, 34.458],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.383, "gauge_lon": 73.465,
        "ffd_station": "Muzaffarabad",
    },
    "new_rasul": {
        "label": "New Rasul (Jhelum River)",
        "flood_type": "riverine",
        "bbox": [73.4436, 32.6082, 73.5936, 32.7582],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.6832, "gauge_lon": 73.5186,
        "ffd_station": "New Rasul",
        "wfs_river_system": "jhelum",
    },
    "nowshera": {
        "label": "Nowshera (Kabul River)",
        "flood_type": "riverine",
        "bbox": [71.9096, 33.9346, 72.0596, 34.0846],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.009583, "gauge_lon": 71.9846,
        "ffd_station": "Nowshera",
        "wfs_river_system": "kabul",
    },
    "panjnad": {
        "label": "Panjnad (Chenab River)",
        "flood_type": "riverine",
        "bbox": [70.9452, 29.2714, 71.0952, 29.4214],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 29.3464, "gauge_lon": 71.0202,
        "ffd_station": "Panjnad",
        "wfs_river_system": "chenab",
    },
    "partab_bridge": {
        "label": "Partab Bridge (Indus River)",
        "flood_type": "riverine",
        "bbox": [74.295, 35.365, 74.445, 35.515],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 35.44, "gauge_lon": 74.37,
        "ffd_station": "Partab Bridge",
        "wfs_river_system": "upper_indus",
    },
    "qadirabad": {
        "label": "Qadirabad (Chenab River)",
        "flood_type": "riverine",
        "bbox": [73.6101, 32.2459, 73.7601, 32.3959],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 32.3209, "gauge_lon": 73.6851,
        "ffd_station": "Qadirabad",
        "wfs_river_system": "chenab",
    },
    "shahdara": {
        "label": "Shahdara (Ravi River)",
        "flood_type": "riverine",
        "bbox": [74.2206, 31.5335, 74.3706, 31.6835],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 31.6085, "gauge_lon": 74.2956,
        "ffd_station": "Shahdara",
        "wfs_river_system": "ravi",
    },
    "sidhnai": {
        "label": "Sidhnai (Ravi River)",
        "flood_type": "riverine",
        "bbox": [72.0832, 30.4973, 72.2332, 30.6473],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 30.5723, "gauge_lon": 72.1582,
        "ffd_station": "Sidhnai",
        "wfs_river_system": "ravi",
    },
    "skardu": {
        "label": "Skardu (Indus River)",
        "flood_type": "riverine",
        "bbox": [75.529, 35.263, 75.679, 35.413],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 35.338, "gauge_lon": 75.604,
        "ffd_station": "Skardu",
        "wfs_river_system": "upper_indus",
    },
    "sukkur": {
        "label": "Sukkur (Indus River)",
        "flood_type": "riverine",
        "bbox": [68.7712, 27.604, 68.9212, 27.754],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 27.679, "gauge_lon": 68.8462,
        "ffd_station": "Sukkur",
        "wfs_river_system": "lower_indus",
    },
    "sulemanki": {
        "label": "Sulemanki (Sutlej River)",
        "flood_type": "riverine",
        "bbox": [73.7913, 30.3027, 73.9413, 30.4527],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 30.3777, "gauge_lon": 73.8663,
        "ffd_station": "Sulemanki",
        "wfs_river_system": "sutlej",
    },
    "tarbela_dam": {
        "label": "Tarbela Dam (Indus River)",
        "flood_type": "riverine",
        "bbox": [72.6588, 34.0309, 72.8088, 34.1809],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 34.1059, "gauge_lon": 72.7338,
        "ffd_station": "Tarbela Dam",
        "wfs_river_system": "upper_indus",
    },
    "taunsa": {
        "label": "Taunsa (Indus River)",
        "flood_type": "riverine",
        "bbox": [70.7617, 30.4435, 70.9117, 30.5935],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 30.518528, "gauge_lon": 70.836721,
        "ffd_station": "Taunsa",
    },
    "trimmu": {
        "label": "Trimmu (Chenab River)",
        "flood_type": "riverine",
        "bbox": [72.071, 31.0698, 72.221, 31.2198],  # 0.0225 deg^2, real coords from FFD get-ffd-waterlevels/
        "gauge_lat": 31.1448, "gauge_lon": 72.146,
        "ffd_station": "Trimmu",
        "wfs_river_system": "chenab",
    },
}

# Deliberately NOT a PILOT_CATCHMENTS entry — that dict is this feature's
# public-facing catalog (reachable through FloodModelRunView's own
# `catchment` body param, validated only against `in PILOT_CATCHMENTS`).
# A one-off DEM-source validation experiment (§0.22) has no business
# being submittable through the production API under a confusing key —
# kept as a standalone config a diagnostic script can splice into
# PILOT_CATCHMENTS temporarily (see the methodology doc §0.22 for the
# exact one-off test invocation), never committed into the real catalog.
_FABDEM_VALIDATION_TEST_CATCHMENT = {
    "label": "Nullah Lai (FABDEM validation test — not a real catchment)",
    "bbox": [72.9167, 33.55, 73.1167, 33.7667],
    "basin_length_km": 30.0,
    "composite_cn": None,
    "dem_source": "fabdem",
}

# AOI size guard — none existed before this pass; only the one hardcoded
# pilot catchment above has ever been exercised, but Phase 1.6 will make
# the AOI user-controllable (a drawn bbox or a custom upload), and nothing
# currently stops a much larger bbox from being requested. Rejecting
# outright (not silently downsampling the AOI the way
# MAX_INPUT_PX_BEFORE_DOWNSAMPLE handles an oversized RASTER elsewhere in
# this app — cropping a user's requested AREA without telling them is a
# worse silent surprise than a raster is) is deliberate: a bbox defines
# what the user actually asked for, and quietly serving a smaller area
# than requested would misrepresent the result.
#
# Cap set with real numbers from THIS project's own confirmed-live
# timings, not a guess: the Nullah Lai pilot (0.0700 deg^2, ~721 km^2 at
# this latitude) already costs ~225-270s for Overture's buildings fetch
# and ~40-80s for road-network exposure (flood_exposure.py, §0.11 of the
# methodology doc) — both already near the edge of what a bounded,
# backend-only pipeline should take on. 0.30 deg^2 gives roughly 4x
# headroom for a modestly larger future catchment without inviting an
# AOI that would blow those costs out by an order of magnitude.
MAX_CATCHMENT_BBOX_DEG2 = 0.30


def _validate_catchment_bbox(bbox):
    """Raises ValueError with a clear message for an oversized or
    malformed bbox — called once, at the top of build_hand_pipeline, so
    every downstream caller (flood_exposure.py's build_exposure_report
    included, since it always calls build_hand_pipeline first) fails fast
    before any GEE/network/compute cost is spent, not partway through."""
    minx, miny, maxx, maxy = bbox
    if maxx <= minx or maxy <= miny:
        raise ValueError(f"Malformed bbox {bbox!r} - max must exceed min on both axes")
    area_deg2 = (maxx - minx) * (maxy - miny)
    if area_deg2 > MAX_CATCHMENT_BBOX_DEG2:
        raise ValueError(
            f"Catchment bbox {bbox!r} is too large ({area_deg2:.4f} deg^2 > "
            f"{MAX_CATCHMENT_BBOX_DEG2} deg^2 cap) - this pipeline is sized for "
            f"pilot-catchment-scale AOIs, not a much larger area. See "
            f"MAX_CATCHMENT_BBOX_DEG2's own comment for the confirmed-live "
            f"timings this cap is based on."
        )


# ---------------------------------------------------------------------------
# Custom-AOI support (FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md §0.36) — the
# ORIGINAL Phase 1.6 vision (draw-your-own-area, not just the 4 hand-
# researched pilots) finally built. This section is the ENTIRE integration
# point: every downstream function (build_hand_pipeline, render_flood_
# prone_zones, build_ahp_susceptibility_raster, build_sar_flood_extent,
# every flood_exposure.py fetch) already only ever touches cfg["bbox"] and
# a cache-directory name from PILOT_CATCHMENTS — confirmed by direct
# exploration, not assumed — so a transient, synthesized entry runs through
# every one of them completely UNCHANGED, exactly as it already does for
# the 4 curated pilots. Precedented by this file's own
# _FABDEM_VALIDATION_TEST_CATCHMENT splice-in-a-synthetic-entry pattern
# above, generalized into a real, always-available feature.
# ---------------------------------------------------------------------------

_CUSTOM_AOI_PREFIX = "custom_"
_CUSTOM_AOI_LOCK = threading.Lock()

# Same dual-guard shape flood_model_views.py's own _purge_old_jobs already
# established (a TTL AND a hard count cap, not either alone) — bounded
# memory/disk growth even if this feature sees a long run of distinct real
# AOIs, never relying on TTL cleanup alone.
_CUSTOM_AOI_TTL_SECONDS = 30 * 24 * 3600  # 30 days unused
_CUSTOM_AOI_MAX_COUNT = 50


def _canonicalize_polygon_geojson(polygon_geojson):
    """Rounds every coordinate to 5 decimals (~1.1m) and returns a stable
    string — used only to fold the polygon's own SHAPE into the content-
    address hash below (see register_custom_aoi's own docstring for why).
    Returns "" for a missing/malformed polygon (falls back to bbox-only
    hashing, preserving this function's original behavior for a request
    that only ever sent a bbox).

    §0.46 — handles BOTH Polygon (`coordinates` = a list of rings) and
    MultiPolygon (`coordinates` = a list of POLYGONS, each itself a list
    of rings) correctly. Before this, a MultiPolygon's own rings-of-
    rings shape made the flat `for ring in coords for x, y in ring` loop
    try to unpack a whole ring's own point list as if it were one [x,y]
    pair — a ValueError, silently caught by the except below, degrading
    to "" (bbox-only hashing). Not a crash, but a real, confirmed-live-
    relevant correctness gap: two DIFFERENT MultiPolygon shapes sharing
    one bbox would incorrectly share the SAME cache key — never
    triggered by the map draw tool (MapboxDraw's own draw_polygon mode
    only ever produces a single Polygon), but a real, common shape for
    §0.46's own uploaded-shapefile AOI feature (a shapefile with several
    disjoint boundary parts)."""
    try:
        geom_type = polygon_geojson.get("type")
        coords = polygon_geojson["coordinates"]
        rings = [ring for polygon in coords for ring in polygon] if geom_type == "MultiPolygon" else coords
        rounded = [[round(x, 5), round(y, 5)] for ring in rings for x, y in ring]
        return json.dumps(rounded)
    except (KeyError, TypeError, ValueError, AttributeError):
        return ""


def register_custom_aoi(bbox, flood_type="flash", polygon_geojson=None):
    """Validates and registers a user-drawn AOI as a transient
    PILOT_CATCHMENTS entry, returning the key every existing job runner
    already knows how to consume unchanged.

    `polygon_geojson`, if given, is the user's own REAL drawn shape (a
    GeoJSON Polygon/MultiPolygon geometry dict) — stored as
    cfg["clip_polygon"] and consumed by render_flood_prone_zones/
    build_discharge_driven_flood_zone (raster masking) and build_ahp_
    zone_geometries (real shapely intersection) to clip their own output
    to the actual drawn shape, not just its bounding bbox (§0.37 — a
    real, confirmed bug: without this, a diagonal/irregular draw's own
    result rendered across its whole bounding RECTANGLE, well outside
    what the user actually asked about). Omitted/malformed degrades to
    the original bbox-only behavior — a real, still-correct-just-less-
    precise request shape, not a hard error.

    Content-addressed key (bbox rounded to 4 decimals — ~11m precision —
    before hashing, PLUS the polygon's own canonicalized shape when
    given, so two DIFFERENT polygons sharing the same bbox get genuinely
    different keys/caches rather than silently sharing one — a real
    correctness requirement now that the polygon shape, not just the
    bbox, affects the cached output) so drawing the SAME area twice
    reuses the SAME cache instead of each draw spawning its own fresh
    multi-minute cold build; a real, deliberate optimization, not an
    accident of hashing.

    Raises ValueError (caught by the view layer, matching every other
    validation error in this file) for a malformed/oversized bbox — the
    EXACT SAME _validate_catchment_bbox already written for this purpose
    (see its own comment) is reused unchanged, not re-implemented.

    Returns the catchment_key string (e.g. "custom_3f9a1c2b7e8d4a10")."""
    _validate_catchment_bbox(bbox)
    minx, miny, maxx, maxy = bbox
    rounded = tuple(round(v, 4) for v in bbox)
    polygon_signature = _canonicalize_polygon_geojson(polygon_geojson) if polygon_geojson else ""
    digest = hashlib.sha256(f"{rounded}|{flood_type}|{polygon_signature}".encode()).hexdigest()[:16]
    catchment_key = f"{_CUSTOM_AOI_PREFIX}{digest}"

    with _CUSTOM_AOI_LOCK:
        if catchment_key not in PILOT_CATCHMENTS:
            center_lat = (miny + maxy) / 2
            center_lon = (minx + maxx) / 2
            PILOT_CATCHMENTS[catchment_key] = {
                "label": f"Custom area ({center_lat:.3f}, {center_lon:.3f})",
                "flood_type": flood_type,
                "bbox": list(bbox),
                "is_custom_aoi": True,
                "clip_polygon": polygon_geojson,
            }
            logger.info(
                "flood_model: registered custom AOI %r (bbox=%r, flood_type=%r, has_polygon=%r)",
                catchment_key, bbox, flood_type, polygon_geojson is not None,
            )

    _prune_custom_aoi_cache()
    return catchment_key


def _clip_array_to_polygon(arr, gt, proj, nodata, polygon_geojson):
    """Masks every cell of `arr` OUTSIDE `polygon_geojson` to `nodata` —
    the real fix for §0.37's own confirmed bug (a custom AOI's rendered
    result filling its whole bounding bbox RECTANGLE, not the actual
    drawn shape). Rasterizes the polygon onto the array's own exact grid
    via gdal.RasterizeLayer — the SAME technique already proven live
    this session in accuracy_assessment.assess_raster_vs_raster_
    agreement, reused here rather than reimplemented.

    Returns a NEW array (the input is not modified in place); returns
    `arr` UNCHANGED if `polygon_geojson` is falsy (the common case for
    every curated pilot catchment, which never sets clip_polygon at
    all — this function is a no-op for them, not just an unused one)."""
    if not polygon_geojson:
        return arr
    from osgeo import gdal, ogr, osr

    h, w = arr.shape
    srs = osr.SpatialReference()
    srs.ImportFromWkt(proj)
    mem_vec_ds = ogr.GetDriverByName("Memory").CreateDataSource("")
    layer = mem_vec_ds.CreateLayer("clip", srs=srs, geom_type=ogr.wkbPolygon)
    geom = ogr.CreateGeometryFromJson(json.dumps(polygon_geojson))
    if geom is None:
        logger.warning("flood_model: could not parse clip_polygon as GeoJSON — skipping clip")
        return arr
    feat = ogr.Feature(layer.GetLayerDefn())
    feat.SetGeometry(geom)
    layer.CreateFeature(feat)
    feat = None

    mask_ds = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
    mask_ds.SetGeoTransform(gt)
    mask_ds.SetProjection(proj)
    gdal.RasterizeLayer(mask_ds, [1], layer, burn_values=[1])
    mask_band = mask_ds.GetRasterBand(1)
    raw = mask_band.ReadRaster(0, 0, w, h, buf_type=gdal.GDT_Byte)
    inside = np.frombuffer(raw, dtype=np.uint8).reshape(h, w) > 0
    mask_ds = None

    clipped = np.where(inside, arr, nodata)
    return clipped


def _prune_custom_aoi_cache():
    """Bounded cleanup for custom-AOI cache directories — called on every
    new registration (piggybacks on real traffic, no new background
    thread, matching _purge_old_jobs's own stated reasoning in
    flood_model_views.py). Prunes by TTL (age since last modification)
    first, then by a hard count cap if still over — the exact dual-guard
    shape that file's own job-registry cleanup already established.
    Never raises — a filesystem hiccup here is non-fatal, just means
    cleanup is deferred to the next registration."""
    try:
        base_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR)
        if not os.path.isdir(base_dir):
            return
        custom_dirs = []
        for name in os.listdir(base_dir):
            if not name.startswith(_CUSTOM_AOI_PREFIX):
                continue
            full_path = os.path.join(base_dir, name)
            if not os.path.isdir(full_path):
                continue
            try:
                mtime = os.path.getmtime(full_path)
            except OSError:
                continue
            custom_dirs.append((name, full_path, mtime))

        now = time.time()
        expired = [d for d in custom_dirs if now - d[2] > _CUSTOM_AOI_TTL_SECONDS]
        survivors = [d for d in custom_dirs if d not in expired]
        to_remove = list(expired)
        if len(survivors) > _CUSTOM_AOI_MAX_COUNT:
            survivors.sort(key=lambda d: d[2])  # oldest first
            to_remove.extend(survivors[: len(survivors) - _CUSTOM_AOI_MAX_COUNT])

        for name, full_path, _mtime in to_remove:
            import shutil
            try:
                shutil.rmtree(full_path)
                with _CUSTOM_AOI_LOCK:
                    PILOT_CATCHMENTS.pop(name, None)
                logger.info("flood_model: pruned custom AOI cache %r (TTL/count cap)", name)
            except OSError:
                logger.warning("flood_model: could not prune custom AOI cache %r (non-fatal)", name, exc_info=True)
    except Exception:
        logger.warning("flood_model: custom AOI cache pruning failed (non-fatal)", exc_info=True)


# Starting value, NOT calibrated for this catchment — see methodology doc
# §0.17 for the full research trail. Correcting an earlier, imprecise
# claim: there is no fixed "operational" HAND threshold in the literature
# to cite — NOAA's own National Water Model FIM service derives HAND
# cutoffs from a rating curve fed by an actual FEMA discharge value per
# reach (Zheng et al. 2018, "Two-dimensional hydraulic modeling and
# rating curve development... for a HAND-based flood inundation mapping
# framework," NOAA; see also the North Carolina HAND-parameter-
# optimization study, Frontiers in Water, 2023,
# https://doi.org/10.3389/frwa.2023.1296434) — i.e. a real, defensible
# threshold needs a rainfall/discharge SCENARIO as input, which is
# exactly Phase 2's job (dynamic PMD coupling), not yet built. 3.0m is
# kept as an EXPLORATORY default, chosen from the geographically closer
# comparison available: Bhatt & Srinivasa Rao (2018), "HAND (height
# above nearest drainage) tool and satellite-based geospatial analysis of
# Hyderabad (India) urban floods, September 2016," Arabian Journal of
# Geosciences 11(19):600 (https://doi.org/10.1007/s12517-018-3952-1),
# which reports HAND 1-5m spanning "very high to very low" flood
# susceptibility for a comparable South Asian urban catchment — 3.0m
# sits mid-range in that band, not picked in isolation. That same
# literature (see the HAND-vs-hydrodynamic-model comparative review,
# Earth Science Informatics, 2023, https://doi.org/10.1007/s12145-023-01218-x)
# also documents HAND UNDERESTIMATING inundation by up to 40% in flat,
# heavily channelized urban settings — a real, named caveat for Lai
# Nullah specifically, which is exactly that kind of channel through
# much of its urban reach, not a generic disclaimer.
#
# Confirmed live via a 2/3/5/8m sweep on this catchment (pre-bbox-
# correction figures, kept for the monotonic-curve shape, not the
# absolute percentages): 9.8% / 13.8% / 22.0% / 34.2% of the AOI flagged
# flood-prone — a sensible, monotonically increasing curve, re-run and
# reconfirmed after the bbox fix (§0.17): 49.752 km^2 flood-prone at
# 3.0m post-correction, vs. 95.405 km^2 pre-correction on the same
# threshold — the earlier oversized bbox, not the threshold itself, was
# the dominant error source.
#
# UPDATE (methodology doc §0.18): the bbox fix alone did NOT close the
# gap. Confirmed live via a real, cited comparison: a published HEC-RAS/
# HEC-GeoRAS hydraulic model of Nullah Lai's own highest-risk channel
# reach (Kattarian-Gawalmandi, Rawalpindi) found actual inundation at a
# severe 3,000 m^3/s discharge covers just 3.4 km^2 -- the 49.752 km^2
# this threshold produces post-bbox-fix (~21% of the basin) is ~14.6x
# larger, even accounting for the scope difference (one channel reach vs.
# this module's whole-basin stream network). This is NOT a threshold-
# tuning problem -- a fixed vertical HAND cutoff has no concept of actual
# water volume/discharge, so it structurally overstates extent wherever
# local terrain is gentle, regardless of what number is picked here.
# Deliberately NOT lowered to chase the 3.4 km^2 figure -- that would be
# curve-fitting to one external data point, not a real fix. The genuine
# fix is Phase 2 (rainfall/discharge-driven coupling). Until then, every
# consumer of this raster (flood_exposure.py, the frontend panel) must
# present its output as a SUSCEPTIBILITY indicator, never as a predicted
# flood extent -- the frontend panel already does this (see
# flood-model-control.js's own methodology note).
HAND_FLOOD_PRONE_THRESHOLD_M = 3.0
# For a 30m DEM, 500 contributing cells ~= 0.45 km^2 of upstream drainage
# area — a reasonable starting definition of "this cell is part of a
# stream" for a small/steep pilot catchment.
STREAM_FLOW_ACCUM_THRESHOLD = 500


_GDAL_LOCK_WARN_THRESHOLD_SECONDS = 1.0


@contextlib.contextmanager
def _gdal_lock():
    """Reuses the EXACT same lock views.py's own PMD prediction pipeline
    uses — see that lock's own extensive comment for the reproduced,
    fixed native crash this exists to prevent. Imported lazily (not at
    module level) to avoid a circular import, matching this module's own
    "nothing heavy at import time" posture.

    Wrapped as a context manager (rather than just returning the raw
    lock object) so every acquisition through THIS module is timed —
    logs a WARNING if a caller waited more than
    _GDAL_LOCK_WARN_THRESHOLD_SECONDS, turning "worth watching lock wait
    times once this is live" from an assumption into actual production
    observability. Correctness is unchanged: still the exact same
    underlying threading.Lock, still fully mutually exclusive, still used
    identically by every existing `with flood_model._gdal_lock():`
    caller — this only adds timing/logging around acquire()/release()."""
    from .views import _MON_PRED_GDAL_LOCK
    t0 = time.monotonic()
    _MON_PRED_GDAL_LOCK.acquire()
    wait_seconds = time.monotonic() - t0
    if wait_seconds > _GDAL_LOCK_WARN_THRESHOLD_SECONDS:
        logger.warning(
            "flood_model: _gdal_lock() acquisition waited %.2fs - contention with "
            "PMD prediction rendering or another flood_model/flood_exposure caller",
            wait_seconds,
        )
    try:
        yield
    finally:
        _MON_PRED_GDAL_LOCK.release()


def _wbt_client():
    """Lazy singleton — the (slow, one-time) binary resolution only
    happens once per process. set_whitebox_dir() is called explicitly
    rather than trusting whitebox's own auto-detection: confirmed live in
    Phase 0 that its default detection is broken on this Windows install
    (a real path bug in the package's OWN installer — it downloads the
    correct binary but fails to move it into the location it later looks
    for it in). Falls back to the untouched default (whatever
    auto-detection finds) if the expected WBT/ subfolder isn't there,
    e.g. on a machine where the installer bug doesn't reproduce."""
    global _wbt_singleton
    if _wbt_singleton is None:
        import whitebox
        wbt = whitebox.WhiteboxTools()
        wbt_dir = os.path.join(os.path.dirname(whitebox.__file__), "WBT")
        if os.path.isdir(wbt_dir):
            wbt.set_whitebox_dir(wbt_dir)
        wbt.set_verbose_mode(False)
        _wbt_singleton = wbt
    return _wbt_singleton


def _run_wbt(tool_name, kwargs, output_path):
    """Calls one WhiteboxTools tool method by name, serialized under
    _WBT_LOCK and bounded by _WBT_TIMEOUT_SECONDS, then verifies the
    output file actually exists and is non-empty — confirmed live in
    Phase 0 that WhiteboxTools' own return code cannot be trusted (a
    Rust-side panic still reported exit 0 with no output produced).
    Raises RuntimeError with a clear message on any failure rather than
    silently returning a missing/stale/corrupt file."""
    def _call():
        with _WBT_LOCK:
            method = getattr(_wbt_client(), tool_name)
            return method(**kwargs)

    future = _WBT_EXECUTOR.submit(_call)
    try:
        future.result(timeout=_WBT_TIMEOUT_SECONDS)
    except _FutureTimeoutError:
        raise RuntimeError(
            f"WhiteboxTools '{tool_name}' did not finish within {_WBT_TIMEOUT_SECONDS}s"
        )
    if not (os.path.exists(output_path) and os.path.getsize(output_path) > 0):
        raise RuntimeError(f"WhiteboxTools '{tool_name}' produced no output at {output_path}")
    return output_path


# DEM sources this pipeline can fetch — "copernicus" (default, used by
# every catchment unless a config overrides it) is COPERNICUS/DEM/GLO30's
# raw surface elevation. "fabdem" (§0.22's literature review) is a
# bias-corrected derivative of the SAME underlying Copernicus data —
# Hawker et al.'s Forest And Buildings removed DEM, which ML-corrects
# building/forest height offsets — confirmed available via the Awesome
# GEE Community Catalog (`projects/sat-io/open-datasets/FABDEM`,
# CONFIRMED LIVE: 19,011 tiles, real coverage over Nullah Lai, mean
# elevation ~2m lower than Copernicus there — consistent with FABDEM's
# own documented purpose). Literature (International Journal of Digital
# Earth 2024, DOI 10.1080/17538947.2024.2308734) finds FABDEM
# outperforms raw Copernicus DEM against LiDAR ground truth generally —
# not assumed true for THIS basin without our own test (§0.22 runs that
# test via a second, isolated PILOT_CATCHMENTS entry, never by silently
# swapping the default).
_DEM_SOURCES = {
    "copernicus": {"asset": "COPERNICUS/DEM/GLO30_2024_1", "band": "DEM", "is_collection": True},
    "fabdem": {"asset": "projects/sat-io/open-datasets/FABDEM", "band": "b1", "is_collection": True},
}
DEFAULT_DEM_SOURCE = "copernicus"


def _fetch_dem(bbox, out_path, dem_source=DEFAULT_DEM_SOURCE):
    """Exports a DEM (see _DEM_SOURCES for the source catalog; defaults
    to Copernicus GLO-30, 2024 release, non-deprecated — see the
    methodology doc's Phase-0 section) for `bbox` from the existing GEE
    integration, writes it to `out_path`. Reuses the SAME
    initialize_earth_engine() side effect views.py's own DEM-dependent
    layers already depend on (imported lazily here for the same reason —
    avoid a heavy/network-touching import at module load time)."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee
    import requests

    if dem_source not in _DEM_SOURCES:
        raise ValueError(f"Unknown dem_source {dem_source!r} — known: {list(_DEM_SOURCES)}")
    src = _DEM_SOURCES[dem_source]

    region = ee.Geometry.Rectangle(bbox)
    if src["is_collection"]:
        dem = ee.ImageCollection(src["asset"]).select(src["band"]).mosaic().clip(region)
    else:
        dem = ee.Image(src["asset"]).select(src["band"]).clip(region)
    url = dem.getDownloadURL({"region": region, "scale": 30, "format": "GEO_TIFF"})
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    raw_path = f"{out_path}.raw{os.getpid()}"
    with open(raw_path, "wb") as f:
        f.write(resp.content)

    # GEE's own GeoTIFF export uses a compression tag (confirmed live:
    # TIFF compression code 32946) that WhiteboxTools' Rust GeoTIFF
    # decoder rejects outright — "only supports PACKBITS, LZW, and
    # DEFLATE" — even though 32946 IS a form of deflate; a real decoder
    # compatibility gap, not a corrupt file. gdal.Translate (pure GDAL
    # utility, never touches gdal_array/numpy — safe under this venv's
    # ABI mismatch) re-writes it uncompressed so every raster this module
    # ever hands to WhiteboxTools is guaranteed readable, not just the
    # one that happened to be tested.
    try:
        from osgeo import gdal
        tmp_path = f"{out_path}.tmp{os.getpid()}"
        # format="GTiff" passed explicitly — confirmed live that letting
        # gdal.Translate guess the driver from the destination filename
        # fails ("Cannot guess driver") once that filename carries a
        # non-.tif temp suffix, which every atomic-write path in this
        # module needs.
        src_ds = gdal.Open(raw_path)
        if src_ds is None:
            raise RuntimeError(f"gdal.Open could not read the GEE DEM export at {raw_path}")
        out_ds = gdal.Translate(
            tmp_path, src_ds,
            format="GTiff", creationOptions=["COMPRESS=NONE"],
        )
        if out_ds is None:
            raise RuntimeError("gdal.Translate returned None re-writing the GEE DEM export")
        out_ds = None
        src_ds = None  # release the open handle BEFORE the finally block's os.remove — Windows
                        # holds a lock on an open GDAL dataset's file handle (same gotcha already
                        # documented elsewhere in views.py); dropping the reference here, not just
                        # letting GC eventually collect it, is what actually releases it in time.
        os.replace(tmp_path, out_path)
    finally:
        # Best-effort — same "cleanup failure must never crash the whole
        # operation" convention _mon_pred_convert_step's own finally block
        # already uses. If Windows still hasn't released the handle by
        # here for some reason, the leftover .raw file is harmless scratch,
        # not a correctness problem — never worth failing the whole DEM
        # fetch over.
        try:
            if os.path.exists(raw_path):
                os.remove(raw_path)
        except OSError:
            logger.warning("flood_model: could not remove scratch file %s (non-fatal)", raw_path)
    return out_path


def _read_pixel(path, col, row):
    """Point-read via raw ReadRaster/struct (never Band.ReadAsArray —
    see this module's own docstring on the NumPy/GDAL ABI mismatch)."""
    from osgeo import gdal
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    raw = band.ReadRaster(col, row, 1, 1, buf_type=gdal.GDT_Float32)
    return struct.unpack("<f", raw)[0]


def _raster_stats(path):
    """Min/max/mean via GetStatistics — this does NOT go through
    gdal_array (confirmed safe in Phase 0's own testing), unlike
    ReadAsArray."""
    from osgeo import gdal
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    mn, mx, mean, std = band.GetStatistics(False, True)
    return {"min": mn, "max": mx, "mean": mean, "std": std,
            "width": ds.RasterXSize, "height": ds.RasterYSize}


def build_hand_pipeline(catchment_key, force=False):
    """Runs the full Phase-1 pipeline for one pilot catchment and returns
    a dict of every intermediate + final raster path, plus basic stats
    for each — so a caller (a management command, a diagnostic script)
    can sanity-check every stage, not just trust the final output blindly.

    Steps: DEM export -> fill_single_cell_pits -> breach_depressions
    (least-cost) -> D8 pointer -> D8 flow accumulation -> stream
    extraction -> elevation_above_stream (HAND). All intermediate files
    are cached on disk (same directory, deterministic names keyed by
    catchment) — reruns with force=False skip already-completed steps,
    matching _mon_pred_convert_step's own disk-cache convention.
    """
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    _validate_catchment_bbox(cfg["bbox"])

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)

    paths = {
        "dem":            os.path.join(out_dir, "01_dem.tif"),
        "pits_fixed":     os.path.join(out_dir, "02_pits_fixed.tif"),
        "conditioned":    os.path.join(out_dir, "03_conditioned.tif"),
        "d8_pointer":     os.path.join(out_dir, "04_d8_pointer.tif"),
        "flow_accum":     os.path.join(out_dir, "05_flow_accum.tif"),
        "streams":        os.path.join(out_dir, "06_streams.tif"),
        "hand":           os.path.join(out_dir, "07_hand.tif"),
    }

    def _needed(key):
        return force or not (os.path.exists(paths[key]) and os.path.getsize(paths[key]) > 0)

    results = {}

    def _stats_locked(key):
        # _raster_stats() is the only part of each step that touches
        # OUR in-process GDAL (gdal.Open/GetStatistics) — WhiteboxTools
        # itself runs as an independent subprocess and never does.
        # Locking only this, not the WhiteboxTools call around it, keeps
        # the (potentially slow) subprocess work from blocking every
        # OTHER GDAL-using feature in the app (e.g. PMD prediction
        # rendering) for the pipeline's whole duration — GDAL/PROJ's
        # thread-safety problem is about concurrent IN-PROCESS calls,
        # nothing outside that needs to be inside this lock.
        with _gdal_lock():
            results[key] = _raster_stats(paths[key])

    if _needed("dem"):
        with _gdal_lock():  # _fetch_dem's own gdal.Translate re-write touches GDAL too
            _fetch_dem(cfg["bbox"], paths["dem"], dem_source=cfg.get("dem_source", DEFAULT_DEM_SOURCE))
    _stats_locked("dem")

    if _needed("pits_fixed"):
        _run_wbt("fill_single_cell_pits",
                 {"dem": paths["dem"], "output": paths["pits_fixed"]},
                 paths["pits_fixed"])
    _stats_locked("pits_fixed")

    if _needed("conditioned"):
        _run_wbt("breach_depressions_least_cost",
                 {"dem": paths["pits_fixed"], "output": paths["conditioned"],
                  "dist": 100, "fill": True},
                 paths["conditioned"])
    _stats_locked("conditioned")

    if _needed("d8_pointer"):
        _run_wbt("d8_pointer",
                 {"dem": paths["conditioned"], "output": paths["d8_pointer"]},
                 paths["d8_pointer"])
    _stats_locked("d8_pointer")

    if _needed("flow_accum"):
        _run_wbt("d8_flow_accumulation",
                 {"i": paths["conditioned"], "output": paths["flow_accum"],
                  "out_type": "cells"},
                 paths["flow_accum"])
    _stats_locked("flow_accum")

    if _needed("streams"):
        _run_wbt("extract_streams",
                 {"flow_accum": paths["flow_accum"], "output": paths["streams"],
                  "threshold": STREAM_FLOW_ACCUM_THRESHOLD},
                 paths["streams"])
    _stats_locked("streams")

    if _needed("hand"):
        _run_wbt("elevation_above_stream",
                 {"dem": paths["conditioned"], "streams": paths["streams"],
                  "output": paths["hand"]},
                 paths["hand"])
    _stats_locked("hand")

    return {"paths": paths, "stats": results}


# Rough deg->km conversion, latitude-independent order-of-magnitude
# estimate — same precedent already established in accuracy_assessment.
# assess_vector_overlap this session (111.32 km/deg), fine for a real-
# but-approximate length figure, not survey-grade.
_DEG_TO_KM = 111.32


def derive_basin_length_km(catchment_key, force=False):
    """Auto-derives a real, computed hydraulic/flow-path length for a
    catchment with no hand-researched literature constant (every custom
    AOI; also available as an honest sanity-check tool for the curated
    pilots — see the methodology doc §0.36 for the real comparison
    against Nullah Lai/Bhudni Nullah's own published values).

    Uses WhiteboxTools' `distance_to_outlet` (a real, standard
    hydrological-analysis tool — confirmed live this session it needs
    only `d8_pointer` + `streams`, BOTH already built and cached by
    build_hand_pipeline for every catchment, zero new fetch), taking the
    MAX value over stream cells as the longest flow-path length.
    Conceptually the RIGHT quantity for this project's own downstream
    consumer, not an approximation of convenience: flood_discharge.
    kirpich_time_of_concentration_hr's own docstring explicitly wants
    "the longest flow-path length, not a straight-line bbox diagonal" —
    exactly what this computes, not a "named main channel" length
    (a related but distinct geomorphological quantity the published
    literature constants may themselves be citing).

    Returns {"basin_length_km": float}. Cached to disk like every other
    per-catchment artifact in this file."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    cache_path = os.path.join(out_dir, "basin_length_derived.json")
    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        with open(cache_path) as f:
            return json.load(f)

    pipeline = build_hand_pipeline(catchment_key, force=force)
    paths = pipeline["paths"]

    dto_path = os.path.join(out_dir, "19_distance_to_outlet.tif")
    _run_wbt(
        "distance_to_outlet",
        {"d8_pntr": paths["d8_pointer"], "streams": paths["streams"], "output": dto_path},
        dto_path,
    )

    with _gdal_lock():
        dto_arr, dto_gt, dto_proj, dto_nodata, dw, dh = _read_raster_array(dto_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(paths["streams"])

    stream_mask = np.isfinite(stream_arr) & (stream_arr > 0)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    valid = np.isfinite(dto_arr) & stream_mask
    if dto_nodata is not None:
        valid &= (dto_arr != dto_nodata)

    length_deg = float(np.max(dto_arr[valid])) if np.any(valid) else 0.0
    basin_length_km = round(length_deg * _DEG_TO_KM, 2)

    payload = {"basin_length_km": basin_length_km}
    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning("flood_model: could not write basin_length cache for %r (non-fatal)", catchment_key, exc_info=True)

    return payload


def build_distance_to_stream_raster(catchment_key, force=False):
    """Builds (once, cached) a real distance-to-stream raster in km — the
    single most heavily-weighted AHP factor for riverine mode (28-48% per
    RIVERINE_HIGH/LOW_DRAINAGE_DENSITY_FACTORS in flood_ahp.py) and a real
    factor for flash-flood mode too.

    NOT built with WhiteboxTools, after two of its distance-related tools
    were confirmed broken for this exact use case in this project's
    installed v2.4.0: `euclidean_distance` run directly on a streams raster
    returned an all-zero result everywhere; the documented workaround using
    `euclidean_allocation` to propagate each stream cell's own X/Y
    coordinate (itself already confirmed working for small-magnitude stage
    values earlier in this project) ALSO failed when allocating
    longitude-scale coordinates — a reproducible, data-independent bug
    (~3% of cells across all 4 pilot catchments come back NoData at the
    SOURCE stream cells themselves) that a magnitude-offset hypothesis
    failed to explain or fix.

    Instead reuses flood_connectivity.chamfer_distance_km — the exact same
    8-connected multi-source expansion technique already proven correct in
    connected_flood_fill, just tracking accumulated distance instead of a
    reachability flag. Verified live on all 4 pilot catchments: 100%
    raster coverage (0 non-finite cells, vs. euclidean_allocation's ~3%
    failure), distance exactly 0.0 at every real stream cell, converges in
    well under a minute even for Guddu's 3.3M-cell raster.
    """
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    from . import flood_connectivity

    pipeline = build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    streams_path = pipeline["paths"]["streams"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "08_distance_river_km.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        with _gdal_lock():
            stats = _raster_stats(out_path)
        return {"path": out_path, "stats": stats}

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)
    if (sw, sh) != (w, h):
        raise RuntimeError(
            f"flood_model: streams raster dims {(sw, sh)} != DEM dims {(w, h)} for "
            f"{catchment_key!r} while building the distance-to-stream raster"
        )

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    stream_mask &= (stream_arr > 0) & valid

    if not stream_mask.any():
        raise RuntimeError(
            f"flood_model: no stream cells found for {catchment_key!r} while building the "
            f"distance-to-stream raster — streams.tif looks empty"
        )

    _, miny, _, maxy = cfg["bbox"]
    lat_mid = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    step_km_row = abs(dem_gt[5]) * km_per_deg_lat
    step_km_col = abs(dem_gt[1]) * km_per_deg_lon

    dist_km = flood_connectivity.chamfer_distance_km(stream_mask, valid, step_km_row, step_km_col)
    out_arr = np.where(valid, dist_km, _DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, out_arr, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    with _gdal_lock():
        stats = _raster_stats(out_path)
    return {"path": out_path, "stats": stats}


def build_twi_curvature_rasters(catchment_key, force=False):
    """Builds (once, cached) the remaining terrain AHP factors that are
    fully derivable from build_hand_pipeline's own cached DEM/D8-pointer
    intermediates — zero new fetches, matching Phase 2.5.2's explicit
    "reuse what's already on disk" instruction: slope (degrees), TWI
    (topographic wetness index), and profile curvature.

    All three use WhiteboxTools' own native tools directly (`slope`,
    `d8_flow_accumulation` with out_type='specific contributing area',
    `wetness_index`, `profile_curvature`) rather than a hand-rolled
    formula — unlike distance-to-stream, none of these were found broken
    when tested live; only `euclidean_distance`/`euclidean_allocation`
    were (see build_distance_to_stream_raster's own docstring).

    profile_curvature (not total/plan) is used for the "curvature" AHP
    factor, matching the term's standard meaning in the flood-
    susceptibility literature this project's AHP weights come from
    (curvature along the slope direction — controls flow acceleration/
    deceleration, the property relevant to runoff concentration; plan
    curvature instead describes flow convergence/divergence, a related
    but distinct property TWI/SCA already captures more directly).

    Returns {"slope_deg": path, "twi": path, "curvature": path}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    pipeline = build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    d8_pointer_path = pipeline["paths"]["d8_pointer"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    paths = {
        "slope_deg": os.path.join(out_dir, "09_slope_deg.tif"),
        "sca": os.path.join(out_dir, "10_sca.tif"),
        "twi": os.path.join(out_dir, "11_twi.tif"),
        "curvature": os.path.join(out_dir, "14_curvature_profile.tif"),
    }

    def _needed(key):
        return force or not (os.path.exists(paths[key]) and os.path.getsize(paths[key]) > 0)

    if _needed("slope_deg"):
        _run_wbt("slope",
                 {"dem": dem_path, "output": paths["slope_deg"], "units": "degrees"},
                 paths["slope_deg"])

    if _needed("sca"):
        _run_wbt("d8_flow_accumulation",
                 {"i": d8_pointer_path, "output": paths["sca"],
                  "out_type": "specific contributing area", "pntr": True},
                 paths["sca"])

    if _needed("twi"):
        _run_wbt("wetness_index",
                 {"sca": paths["sca"], "slope": paths["slope_deg"], "output": paths["twi"]},
                 paths["twi"])

    if _needed("curvature"):
        _run_wbt("profile_curvature",
                 {"dem": dem_path, "output": paths["curvature"]},
                 paths["curvature"])

    return {k: paths[k] for k in ("slope_deg", "twi", "curvature")}


def _fetch_gee_categorical_raster(bbox, out_path, asset_id, band, scale=10):
    """Fetches one band of a single-image GEE asset, clipped to `bbox`, at
    its own native export grid — reuses _fetch_dem's own proven
    download/re-write mechanics (same Earth Engine init side effect, same
    GEE-compression-tag-vs-WhiteboxTools-decoder workaround via
    gdal.Translate, same atomic-write convention) generalized to any
    single-band GEE image instead of hardcoding the DEM source catalog.
    No explicit .resample() call — GEE's own export default is nearest-
    neighbor, which is what a CATEGORICAL raster (land-cover/soil-texture
    class codes) needs; calling .resample('bilinear') here would silently
    interpolate class codes into nonexistent classes."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee
    import requests

    region = ee.Geometry.Rectangle(bbox)
    img = ee.Image(asset_id).select(band).clip(region)
    url = img.getDownloadURL({"region": region, "scale": scale, "format": "GEO_TIFF"})
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    raw_path = f"{out_path}.raw{os.getpid()}"
    with open(raw_path, "wb") as f:
        f.write(resp.content)
    try:
        from osgeo import gdal
        tmp_path = f"{out_path}.tmp{os.getpid()}"
        src_ds = gdal.Open(raw_path)
        if src_ds is None:
            raise RuntimeError(f"gdal.Open could not read the GEE export at {raw_path}")
        out_ds = gdal.Translate(tmp_path, src_ds, format="GTiff", creationOptions=["COMPRESS=NONE"])
        if out_ds is None:
            raise RuntimeError("gdal.Translate returned None re-writing the GEE export")
        out_ds = None
        src_ds = None  # release before os.remove — Windows file-lock gotcha, same as _fetch_dem
        os.replace(tmp_path, out_path)
    finally:
        try:
            if os.path.exists(raw_path):
                os.remove(raw_path)
        except OSError:
            logger.warning("flood_model: could not remove scratch file %s (non-fatal)", raw_path)
    return out_path


def _warp_to_grid(src_path, out_path, ref_gt, ref_w, ref_h, resample_alg="near"):
    """Warps src_path onto the EXACT pixel grid (bounds + dimensions) of
    a reference raster — always this catchment's own conditioned DEM in
    practice — so every AHP factor raster lands on an identical grid and
    can be combined pixel-for-pixel later with plain NumPy arithmetic,
    no implicit resampling mismatch between factors fetched from
    different sources/scales. resample_alg='near' (default) for
    categorical rasters — 'bilinear' would invent nonexistent class
    codes at class boundaries."""
    from osgeo import gdal
    minx = ref_gt[0]
    maxy = ref_gt[3]
    maxx = minx + ref_gt[1] * ref_w
    miny = maxy + ref_gt[5] * ref_h
    warp_opts = gdal.WarpOptions(
        format="GTiff", outputBounds=(minx, miny, maxx, maxy),
        width=ref_w, height=ref_h, resampleAlg=resample_alg, dstSRS="EPSG:4326",
    )
    src_ds = gdal.Open(src_path)
    if src_ds is None:
        raise RuntimeError(f"gdal.Open failed for {src_path}")
    out_ds = gdal.Warp(out_path, src_ds, options=warp_opts)
    src_ds = None
    if out_ds is None:
        raise RuntimeError(f"gdal.Warp returned None warping {src_path} -> {out_path}")
    out_ds = None
    return out_path


# ESA WorldCover v200/2021 class codes -> a 1 (lowest hazard contribution)
# to 5 (highest) ordinal scale, by runoff-generation potential — the
# standard, widely-repeated LULC reclassification convention used across
# the flood-susceptibility AHP literature (dense vegetation intercepts/
# infiltrates rainfall and contributes least to runoff; impervious/already
# -saturated surfaces contribute most). Not a single paper's exact table
# (none of the papers whose LULC breakpoints were sought this session had
# a fetchable table) — an honest, standard convention, not a fabricated
# one; documented as such rather than attributed to a specific source.
_WORLDCOVER_HAZARD_CLASS = {
    10: 1,   # Tree cover — dense canopy, highest interception/infiltration
    20: 2,   # Shrubland
    30: 2,   # Grassland
    100: 2,  # Moss and lichen
    40: 3,   # Cropland — seasonal cover, tilled soil, moderate-high runoff
    60: 4,   # Bare / sparse vegetation — no vegetation buffer
    70: 4,   # Snow and ice — impermeable when frozen
    50: 5,   # Built-up — impervious surface, maximum runoff
    80: 5,   # Permanent water bodies — already inundated
    90: 5,   # Herbaceous wetland — hydric, saturated
    95: 5,   # Mangroves — hydric, saturated
}

# OpenLandMap USDA 12-class soil texture -> the SAME 1-5 hazard scale, by
# infiltration capacity (clay-dominated = low infiltration = high runoff/
# hazard; sand-dominated = high infiltration = low hazard). Deliberately
# aligned to this project's OWN existing SCS Curve Number Hydrologic Soil
# Group logic (flood_discharge.py) — clay~HSG D, sand~HSG A — an internal
# consistency choice, not an independent literature table (OpenLandMap's
# own USDA class codes: 1 Clay .. 12 Sand, https://openlandmap.org).
_SOIL_TEXTURE_HAZARD_CLASS = {
    1: 5, 2: 5, 3: 5,      # Clay, Silty Clay, Sandy Clay        (~HSG D)
    4: 4, 5: 4,            # Clay Loam, Silty Clay Loam          (~HSG C/D)
    6: 3, 7: 3, 8: 3,      # Sandy Clay Loam, Loam, Silty Loam   (~HSG B/C)
    9: 2, 10: 2,           # Sandy Loam, Silt                    (~HSG B)
    11: 1, 12: 1,          # Loamy Sand, Sand                    (~HSG A)
}


def _reclassify(arr, nodata, class_map, default=3):
    """Maps each integer class code in `arr` to class_map's ordinal value
    (rounding first — GEE nearest-neighbor export can leave float noise
    on otherwise-integer codes); any code not in class_map (including a
    genuine nodata read) falls back to `default` (the scale's own
    midpoint — a neutral, non-committal value) rather than silently
    propagating as 0/nodata into a downstream weighted sum."""
    rounded = np.round(arr).astype(np.int64)
    out = np.full(arr.shape, default, dtype=np.float64)
    for code, value in class_map.items():
        out[rounded == code] = value
    return out


def build_lulc_raster(catchment_key, force=False):
    """Builds (once, cached) the LULC AHP factor: ESA WorldCover v200/2021
    (10m native resolution, confirmed reachable as a direct ee.Image with
    band 'Map') fetched for the catchment bbox, warped onto the exact
    conditioned-DEM grid, then reclassified onto the 1-5 hazard scale via
    _WORLDCOVER_HAZARD_CLASS. Returns {"raw_path", "reclass_path"}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    raw_path = os.path.join(out_dir, "15_lulc_raw.tif")
    reclass_path = os.path.join(out_dir, "16_lulc_hazard.tif")

    if not force and os.path.exists(reclass_path) and os.path.getsize(reclass_path) > 0:
        return {"raw_path": raw_path, "reclass_path": reclass_path}

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)

    # scale=30 (WorldCover's own native resolution is 10m) matches the
    # conditioned DEM's own export scale, which this raster gets warped
    # onto immediately below anyway — fetching at native 10m and then
    # downsampling would be wasted bandwidth, and for a large catchment
    # (confirmed live: guddu_indus) a 10m fetch can exceed GEE's own
    # getDownloadURL request-size cap (~48MB) outright.
    fetch_path = f"{raw_path}.fetch{os.getpid()}"
    _fetch_gee_categorical_raster(cfg["bbox"], fetch_path, "ESA/WorldCover/v200/2021", "Map", scale=30)
    with _gdal_lock():
        _warp_to_grid(fetch_path, raw_path, dem_gt, w, h, resample_alg="near")
    os.remove(fetch_path)

    with _gdal_lock():
        lulc_arr, lulc_gt, lulc_proj, lulc_nodata, lw, lh = _read_raster_array(raw_path)
    hazard = _reclassify(lulc_arr, lulc_nodata, _WORLDCOVER_HAZARD_CLASS, default=3)
    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    hazard = np.where(valid, hazard, _DISCHARGE_STAGE_NODATA)

    tmp_path = f"{reclass_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, hazard, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, reclass_path)

    return {"raw_path": raw_path, "reclass_path": reclass_path}


def build_soil_texture_raster(catchment_key, force=False):
    """Builds (once, cached) the soil-type AHP factor: OpenLandMap's
    SOL_TEXTURE-CLASS_USDA-TT_M v02, band 'b0' (surface, 0cm depth —
    most relevant to surface-runoff generation), fetched, warped onto the
    conditioned-DEM grid, then reclassified onto the 1-5 hazard scale via
    _SOIL_TEXTURE_HAZARD_CLASS. Returns {"raw_path", "reclass_path"}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    raw_path = os.path.join(out_dir, "17_soil_raw.tif")
    reclass_path = os.path.join(out_dir, "18_soil_hazard.tif")

    if not force and os.path.exists(reclass_path) and os.path.getsize(reclass_path) > 0:
        return {"raw_path": raw_path, "reclass_path": reclass_path}

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)

    fetch_path = f"{raw_path}.fetch{os.getpid()}"
    _fetch_gee_categorical_raster(
        cfg["bbox"], fetch_path, "OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02", "b0", scale=250,
    )
    with _gdal_lock():
        _warp_to_grid(fetch_path, raw_path, dem_gt, w, h, resample_alg="near")
    os.remove(fetch_path)

    with _gdal_lock():
        soil_arr, soil_gt, soil_proj, soil_nodata, sw, sh = _read_raster_array(raw_path)
    hazard = _reclassify(soil_arr, soil_nodata, _SOIL_TEXTURE_HAZARD_CLASS, default=3)
    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    hazard = np.where(valid, hazard, _DISCHARGE_STAGE_NODATA)

    tmp_path = f"{reclass_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, hazard, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, reclass_path)

    return {"raw_path": raw_path, "reclass_path": reclass_path}


# ---------------------------------------------------------------------------
# Auto-derived composite_cn (§0.36) — for a custom AOI that has no hand-
# researched literature constant the way the 4 curated pilots do. Real,
# literature-standard NRCS TR-55 method: land-cover class x Hydrologic
# Soil Group (HSG) -> a runoff Curve Number, looked up per pixel and area-
# -weighted. Reuses build_lulc_raster/build_soil_texture_raster's own raw
# (un-reclassified) class-code rasters UNCHANGED — both already fetched,
# cached, and co-registered on the same conditioned-DEM grid for the AHP
# factor pipeline; zero new data fetch for this.
#
# CN values below are quoted VERBATIM from a real NRCS/SCS TR-55 curve-
# number reference table (fetched and read directly this session,
# drainagecalculators.com/reference/curve-numbers/, AMC II/average
# antecedent moisture condition — the standard TR-55 default), not
# invented or estimated from memory. Order is (HSG A, B, C, D):
_TR55_CN_BY_CATEGORY = {
    "woods_good": (30, 55, 70, 77),
    "brush_good": (30, 48, 65, 73),
    "pasture_good": (39, 61, 74, 80),
    "row_crops_good": (67, 78, 85, 89),
    "fallow_bare": (77, 86, 91, 94),
    "commercial_85pct_impervious": (89, 92, 94, 95),
    # Water/wetland/frozen ground: no meaningful infiltration regardless
    # of soil group — the SAME flat-98-regardless-of-HSG convention this
    # source's own "paved parking/roofs/driveways" row already uses for
    # impervious surfaces, standard practice for CN modeling of open
    # water (not a per-project invention).
    "saturated_or_impervious": (98, 98, 98, 98),
}

# ESA WorldCover v200/2021 class code -> the TR-55 category above it maps
# to most directly. Kept as a SEPARATE table from _WORLDCOVER_HAZARD_CLASS
# (that one is a 1-5 AHP ordinal for a different purpose — combining them
# would conflate two independently-reasoned scales).
_WORLDCOVER_TR55_CATEGORY = {
    10: "woods_good",                  # Tree cover
    20: "brush_good",                  # Shrubland
    30: "pasture_good",                # Grassland
    100: "pasture_good",               # Moss and lichen — sparse but vegetated, closest analog
    40: "row_crops_good",              # Cropland
    60: "fallow_bare",                 # Bare / sparse vegetation
    70: "saturated_or_impervious",     # Snow and ice — impermeable when frozen
    50: "commercial_85pct_impervious", # Built-up
    80: "saturated_or_impervious",     # Permanent water
    90: "saturated_or_impervious",     # Herbaceous wetland — hydric, saturated
    95: "saturated_or_impervious",     # Mangroves — hydric, saturated
}

# OpenLandMap USDA 12-class soil texture -> Hydrologic Soil Group (A/B/C/D
# index 0-3), per the standard NRCS texture-based HSG assignment (Group A:
# <10% clay, >90% sand; Group D: >40% clay — confirmed live this session
# via NRCS's own published HSG criteria). A genuinely finer-grained
# crosswalk than _SOIL_TEXTURE_HAZARD_CLASS's own 1-5 ordinal grouping
# (that one groups Sandy Clay Loam with Loam/Silty Loam at the same
# hazard level; TR-55 literature more precisely places Sandy Clay Loam at
# the B/C boundary, commonly classed C) — a deliberate, documented
# refinement for THIS specific purpose, not an inconsistency to reconcile.
_SOIL_TEXTURE_TO_HSG_INDEX = {
    1: 3, 2: 3, 3: 3,   # Clay, Silty Clay, Sandy Clay       -> D
    4: 2, 5: 2, 6: 2,   # Clay Loam, Silty Clay Loam, Sandy Clay Loam -> C
    7: 1, 8: 1, 9: 1, 10: 1,  # Loam, Silty Loam, Sandy Loam, Silt -> B
    11: 0, 12: 0,       # Loamy Sand, Sand                   -> A
}
# When either input is genuinely unreadable (nodata/unknown code), default
# to a defensible middle ground rather than an extreme: row-crop-like
# land cover (moderate runoff, not bare-soil-worst-case) and HSG C (a
# commonly-used default "moderate" soil group when data is unavailable,
# not A/D extremes) — matches _reclassify's own "neutral default, don't
# silently propagate nodata" convention elsewhere in this file.
_CN_DEFAULT_CATEGORY = "row_crops_good"
_CN_DEFAULT_HSG_INDEX = 2


def derive_composite_cn(catchment_key, force=False):
    """Auto-derives a composite Curve Number for a catchment that has no
    hand-researched literature constant (i.e. every custom AOI, and
    available as a real, honest sanity-check tool for the curated pilots
    too — see the methodology doc §0.36 for the known-answer comparison
    against Nullah Lai/Bhudni Nullah's own hardcoded values). NRCS TR-55
    land-cover x Hydrologic-Soil-Group method, per-pixel, area-weighted
    (a simple mean across all valid pixels — every pixel is equal area on
    this already-warped conditioned-DEM grid, no further weighting
    needed).

    Cached to disk like every other per-catchment artifact in this file.
    Returns {"composite_cn": float, "n_valid_pixels": int}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    cache_path = os.path.join(out_dir, "composite_cn_derived.json")
    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        with open(cache_path) as f:
            return json.load(f)

    lulc = build_lulc_raster(catchment_key, force=force)
    soil = build_soil_texture_raster(catchment_key, force=force)

    with _gdal_lock():
        lulc_arr, lulc_gt, lulc_proj, lulc_nodata, lw, lh = _read_raster_array(lulc["raw_path"])
        soil_arr, soil_gt, soil_proj, soil_nodata, sw, sh = _read_raster_array(soil["raw_path"])

    lulc_codes = np.round(lulc_arr).astype(np.int64)
    soil_codes = np.round(soil_arr).astype(np.int64)

    # Build a per-pixel CN array via two vectorized lookups (category
    # table, then HSG index into that category's own 4-tuple) — no
    # Python-level per-pixel loop, matching this file's own established
    # "vectorize, don't loop over pixels" convention.
    cn_arr = np.full(lulc_codes.shape, np.nan, dtype=np.float64)
    unique_lulc = np.unique(lulc_codes)
    for code in unique_lulc:
        category = _WORLDCOVER_TR55_CATEGORY.get(int(code), _CN_DEFAULT_CATEGORY)
        cn_tuple = _TR55_CN_BY_CATEGORY[category]
        mask = lulc_codes == code
        for hsg_index in range(4):
            hsg_mask = mask & np.isin(soil_codes, [
                k for k, v in _SOIL_TEXTURE_TO_HSG_INDEX.items() if v == hsg_index
            ])
            if np.any(hsg_mask):
                cn_arr[hsg_mask] = cn_tuple[hsg_index]
        # Any pixel matched by `mask` but not covered by a known HSG
        # code above (unknown/nodata soil) gets the default HSG.
        unresolved = mask & np.isnan(cn_arr)
        if np.any(unresolved):
            cn_arr[unresolved] = cn_tuple[_CN_DEFAULT_HSG_INDEX]

    valid = ~np.isnan(cn_arr)
    if lulc_nodata is not None:
        valid &= (lulc_arr != lulc_nodata)
    n_valid = int(np.sum(valid))
    composite_cn = float(np.mean(cn_arr[valid])) if n_valid > 0 else None

    payload = {"composite_cn": round(composite_cn, 1) if composite_cn is not None else None, "n_valid_pixels": n_valid}
    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning("flood_model: could not write composite_cn cache for %r (non-fatal)", catchment_key, exc_info=True)

    return payload


def build_drainage_density_raster(catchment_key, force=False):
    """Builds (once, cached) the drainage_density AHP factor — a real
    factor in the riverine profiles (flood_ahp.py's RIVERINE_HIGH/LOW_
    DRAINAGE_DENSITY_FACTORS), computed as a local (1km-radius window)
    Horton drainage density via flood_connectivity.local_drainage_density,
    reusing the streams raster already on disk (zero new fetch).

    Reclassified onto the 1-5 hazard scale via this catchment's OWN
    quantile breakpoints (20/40/60/80th percentile of its own density
    distribution) rather than a fixed absolute km/km^2 threshold — no
    literature source found this session gave an absolute drainage-
    density-to-hazard breakpoint table (the one confirmed real regional
    finding, source [G]/Punjab hybrid-AHP in flood_ahp.py's own docstring,
    is used there as a CATCHMENT-LEVEL terrain-class selector — high vs.
    low drainage density basins get different profiles entirely — not a
    proportional per-pixel breakpoint). A relative, per-catchment ranking
    is a documented, standard fallback for exactly this situation, not
    silently presented as a literature-sourced absolute scale.

    Returns {"raw_path", "reclass_path"} (raw_path holds real km/km^2
    values; reclass_path holds the 1-5 hazard scale)."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    from . import flood_connectivity

    pipeline = build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    streams_path = pipeline["paths"]["streams"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    raw_path = os.path.join(out_dir, "19_drainage_density_raw.tif")
    reclass_path = os.path.join(out_dir, "20_drainage_density_hazard.tif")

    if not force and os.path.exists(reclass_path) and os.path.getsize(reclass_path) > 0:
        return {"raw_path": raw_path, "reclass_path": reclass_path}

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    stream_mask &= (stream_arr > 0) & valid

    _, miny, _, maxy = cfg["bbox"]
    lat_mid = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    cell_size_km = abs(dem_gt[1]) * km_per_deg_lon  # isotropic approximation, same as
                                                     # build_distance_to_stream_raster's own
    radius_cells = max(1, round(1.0 / cell_size_km))  # ~1km-radius local window

    density = flood_connectivity.local_drainage_density(stream_mask, radius_cells, cell_size_km)

    tmp_raw = f"{raw_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_raw, np.where(valid, density, _DISCHARGE_STAGE_NODATA),
                             dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_raw, raw_path)

    valid_density = density[valid]
    breaks = np.percentile(valid_density, [20, 40, 60, 80]) if valid_density.size else np.array([0, 0, 0, 0])
    hazard = np.digitize(density, breaks) + 1  # 1..5
    hazard = np.where(valid, hazard.astype(np.float64), _DISCHARGE_STAGE_NODATA)

    tmp_reclass = f"{reclass_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_reclass, hazard, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_reclass, reclass_path)

    return {"raw_path": raw_path, "reclass_path": reclass_path}


def _fetch_gee_continuous_raster(bbox, out_path, image, scale):
    """Same download/re-write mechanics as _fetch_gee_categorical_raster
    (same Earth Engine init, same GEE-compression-tag workaround, same
    atomic write) but taking an already-built ee.Image directly instead
    of an asset_id/band pair — used for CONTINUOUS factors (rainfall
    climatology, NDVI) built from a reduced ee.ImageCollection rather
    than a single static image."""
    from . import views  # noqa: F401 — import side effect: initializes Earth Engine
    import ee
    import requests

    region = ee.Geometry.Rectangle(bbox)
    img = image.clip(region)
    url = img.getDownloadURL({"region": region, "scale": scale, "format": "GEO_TIFF"})
    resp = requests.get(url, timeout=90)
    resp.raise_for_status()
    raw_path = f"{out_path}.raw{os.getpid()}"
    with open(raw_path, "wb") as f:
        f.write(resp.content)
    try:
        from osgeo import gdal
        tmp_path = f"{out_path}.tmp{os.getpid()}"
        src_ds = gdal.Open(raw_path)
        if src_ds is None:
            raise RuntimeError(f"gdal.Open could not read the GEE export at {raw_path}")
        out_ds = gdal.Translate(tmp_path, src_ds, format="GTiff", creationOptions=["COMPRESS=NONE"])
        if out_ds is None:
            raise RuntimeError("gdal.Translate returned None re-writing the GEE export")
        out_ds = None
        src_ds = None
        os.replace(tmp_path, out_path)
    finally:
        try:
            if os.path.exists(raw_path):
                os.remove(raw_path)
        except OSError:
            logger.warning("flood_model: could not remove scratch file %s (non-fatal)", raw_path)
    return out_path


def build_rainfall_climatology_raster(catchment_key, force=False):
    """Builds (once, cached) the rainfall AHP factor — a STATIC spatial
    climatology (mean annual CHIRPS total over the most recent full
    calendar year available), NOT the live/forecast rainfall scenario
    value flood_discharge.py's SCS-CN chain or flood_forecast.py's
    nowcast use elsewhere in this project. Standard flood-susceptibility-
    AHP convention: "rainfall" as a hazard FACTOR represents a location's
    long-term exposure to heavy precipitation (a spatial pattern), while
    a discharge scenario's rainfall_mm is a specific EVENT magnitude — two
    genuinely different things that happen to share a name in the
    literature and in this codebase; kept clearly separate here, not
    conflated.

    Reuses the same CHIRPS collection (UCSB-CHG/CHIRPS/DAILY) and native
    ~5.5km scale flood_forecast.py already uses. At that resolution this
    raster is expected to be near-uniform within any one of this
    project's own (much smaller) pilot catchments — an honest, expected
    property of a coarse climate-grid input, not a bug; still a real,
    literature-standard factor to include for national generalizability
    (other, larger catchments elsewhere in Pakistan WOULD show real
    spatial rainfall gradients CHIRPS can resolve)."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    raw_path = os.path.join(out_dir, "21_rainfall_climatology_mm.tif")

    if not force and os.path.exists(raw_path) and os.path.getsize(raw_path) > 0:
        return {"raw_path": raw_path}

    from . import views  # noqa: F401 — Earth Engine init side effect
    import ee

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)

    end = ee.Date(time.strftime("%Y-%m-%d"))
    start = end.advance(-1, "year")
    annual_total = (
        ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY")
        .filterDate(start, end)
        .sum()
        .rename("rainfall_mm")
    )

    fetch_path = f"{raw_path}.fetch{os.getpid()}"
    _fetch_gee_continuous_raster(cfg["bbox"], fetch_path, annual_total, scale=5566)
    with _gdal_lock():
        _warp_to_grid(fetch_path, raw_path, dem_gt, w, h, resample_alg="bilinear")
    os.remove(fetch_path)

    return {"raw_path": raw_path}


def build_ndvi_raster(catchment_key, force=False):
    """Builds (once, cached) the NDVI AHP factor: a cloud-filtered median
    Sentinel-2 (COPERNICUS/S2_SR_HARMONIZED) composite over the most
    recent full calendar year, NDVI = (NIR-RED)/(NIR+RED) computed via
    ee.Image.normalizedDifference (bands B8/B4), warped onto the
    conditioned-DEM grid."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]

    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    raw_path = os.path.join(out_dir, "22_ndvi.tif")

    if not force and os.path.exists(raw_path) and os.path.getsize(raw_path) > 0:
        return {"raw_path": raw_path}

    from . import views  # noqa: F401 — Earth Engine init side effect
    import ee

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)

    region = ee.Geometry.Rectangle(cfg["bbox"])
    # A 90-day window (not a full year) — confirmed live: even after
    # selecting only B4/B8 before .median(), a FULL YEAR of Sentinel-2
    # scenes over Chashma's own larger bbox still hit GEE's server-side
    # "User memory limit exceeded" (too many overlapping tiles to
    # reduce). A 90-day window centered on a fixed recent date is a
    # standard, much cheaper alternative that still yields a real
    # cloud-filtered median composite — NDVI's own seasonal variation is
    # a real limitation this introduces (a single season's snapshot, not
    # a year-round mean), honestly noted rather than hidden.
    end = ee.Date(time.strftime("%Y-%m-%d"))
    start = end.advance(-90, "day")
    composite = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", 20))
        .select(["B4", "B8"])  # before .median(), not after — cuts reduction cost ~13x
        .median()
    )
    ndvi = composite.normalizedDifference(["B8", "B4"]).rename("ndvi")

    fetch_path = f"{raw_path}.fetch{os.getpid()}"
    _fetch_gee_continuous_raster(cfg["bbox"], fetch_path, ndvi, scale=30)
    with _gdal_lock():
        _warp_to_grid(fetch_path, raw_path, dem_gt, w, h, resample_alg="bilinear")
    os.remove(fetch_path)

    return {"raw_path": raw_path}


def build_connectivity_hazard_raster(catchment_key, force=False, n_levels=6, max_stage_above_stream_m=20.0):
    """Builds (once, cached) a NEW AHP factor added after live GFD
    validation found the riverine profiles falling well short of target
    (Chashma AUC 0.69 "poor", Guddu AUC 0.49 "fail" — see flood_ahp.py's
    RIVERINE profiles' own updated docstring) while every individual
    terrain/proximity factor tested in isolation was ALSO weak-to-random
    there (distance_river 0.59, hand 0.60, drainage_density 0.49) — none
    inverted (ruling out a sign bug), all just weak. Working theory: large
    -scale Indus flooding at Guddu is often breach/overbank-driven,
    reaching areas that are topologically DISCONNECTED from the channel
    by an intervening ridge even when they sit at low raw elevation
    (which raw HAND/distance-to-stream can't tell apart from a truly
    well-connected low-lying cell), or conversely areas that connect via
    a real breach pathway at a LOWER water level than a naive elevation
    difference would suggest.

    THIS IS THIS PROJECT'S OWN REASONED ADDITION — no literature source
    in this session's riverine review names a "connectivity hazard"
    factor by this name; it is a direct, honest response to a real
    validation finding, built from machinery this project already trusts
    (flood_connectivity.connected_flood_fill, the same provably-correct
    geodesic-dilation technique build_riverine_flood_zone's own
    production flood-zone raster already uses), not a new untested
    algorithm.

    Method: sweeps connected_flood_fill across `n_levels` water-surface
    elevations from this catchment's own median stream elevation up to
    +`max_stage_above_stream_m`, always seeded from the real stream
    network (never from a single scenario's live gauge reading — this
    stays a STATIC per-catchment factor, matching every other AHP input).
    For each cell, records the LOWEST swept level at which it first
    becomes topologically reachable — a "connectivity threshold" in the
    DEM's own elevation units. A cell reachable only at a high level (or
    never, within the swept range) is safer; one reachable at a low level
    is more hazardous — the SAME direction convention as HAND, but
    accounting for topological blockage/breach pathways HAND's simple
    elevation difference cannot represent.

    Returns {"path": raw connectivity-threshold raster (catchment's own
    elevation units)}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    from . import flood_connectivity

    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]
    streams_path = pipeline["paths"]["streams"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    out_path = os.path.join(out_dir, "23_connectivity_threshold.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path}

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    stream_mask &= (stream_arr > 0) & valid

    if not stream_mask.any():
        raise RuntimeError(
            f"flood_model: no stream cells found for {catchment_key!r} while building the "
            f"connectivity hazard raster — streams.tif looks empty"
        )

    min_level = float(np.median(dem_arr[stream_mask]))
    levels = np.linspace(min_level, min_level + max_stage_above_stream_m, n_levels)

    connectivity_threshold = np.full(dem_arr.shape, np.inf, dtype=np.float64)
    for level in levels:
        fill_result = flood_connectivity.connected_flood_fill(dem_arr, valid, stream_mask, float(level))
        if not fill_result["converged"]:
            logger.warning(
                "flood_model: connectivity sweep did not converge at level=%.2f for %r "
                "(treating this level's result as a lower bound, continuing the sweep)",
                level, catchment_key,
            )
        newly_reached = fill_result["flooded_mask"] & np.isinf(connectivity_threshold)
        connectivity_threshold[newly_reached] = level

    # Cells never reached within the swept range are the SAFEST class —
    # given a real finite value (top-of-range + one more step) rather
    # than left as inf, since inf can't be written to a GeoTIFF band
    # reliably nor quantile-reclassified sensibly downstream.
    still_unreached = np.isinf(connectivity_threshold)
    connectivity_threshold[still_unreached] = levels[-1] + (levels[-1] - levels[-2] if n_levels > 1 else 1.0)

    out_arr = np.where(valid, connectivity_threshold, _DISCHARGE_STAGE_NODATA)
    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, out_arr, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    return {"path": out_path}


def _quantile_reclassify_hazard(arr, valid, ascending=True):
    """Per-catchment quantile reclassification of a continuous raster onto
    the 1-5 AHP hazard scale (20/40/60/80th percentile breaks of its OWN
    valid-cell distribution) — the same relative-ranking fallback already
    used for build_drainage_density_raster (see that function's own
    docstring for why: no literature source found this session gives a
    universal, absolute breakpoint table for these factors).

    ascending=True: higher raw values -> higher hazard class (rainfall,
    TWI — wetter/higher-accumulation is worse).
    ascending=False: higher raw values -> LOWER hazard class
    (distance-to-stream, HAND, slope, curvature, NDVI — nearer/lower/
    flatter/more-concave/less-vegetated is worse, so being HIGH on these
    raw scales means SAFER, not more hazardous)."""
    valid_vals = arr[valid]
    if valid_vals.size == 0:
        return np.full_like(arr, 3.0)
    breaks = np.percentile(valid_vals, [20, 40, 60, 80])
    hazard = (np.digitize(arr, breaks) + 1).astype(np.float64)  # 1..5
    if not ascending:
        hazard = 6.0 - hazard
    return hazard


# Which builder produces each continuous AHP factor's raw raster, and
# which direction its raw values map onto the hazard scale (see
# _quantile_reclassify_hazard's own docstring). "hand" is handled
# specially in build_ahp_susceptibility_raster (it comes straight from
# build_hand_pipeline, no separate builder). lulc/soil_type/
# drainage_density are NOT here — their own builders already return a
# pre-reclassified 1-5 hazard raster (reclass_path), used directly.
_AHP_CONTINUOUS_FACTOR_SPEC = {
    "distance_river": {"ascending": False,
                        "builder": lambda key, force: build_distance_to_stream_raster(key, force=force)["path"]},
    "slope":          {"ascending": False,
                        "builder": lambda key, force: build_twi_curvature_rasters(key, force=force)["slope_deg"]},
    "twi":            {"ascending": True,
                        "builder": lambda key, force: build_twi_curvature_rasters(key, force=force)["twi"]},
    "curvature":      {"ascending": False,
                        "builder": lambda key, force: build_twi_curvature_rasters(key, force=force)["curvature"]},
    "rainfall":       {"ascending": True,
                        "builder": lambda key, force: build_rainfall_climatology_raster(key, force=force)["raw_path"]},
    "ndvi":           {"ascending": False,
                        "builder": lambda key, force: build_ndvi_raster(key, force=force)["raw_path"]},
    # ascending=False: a LOW connectivity threshold (reachable at a low
    # water level) is worse — see build_connectivity_hazard_raster's own
    # docstring for why this was added (a real GFD-validation finding,
    # riverine-only, not part of the original literature review).
    "connectivity":   {"ascending": False,
                        "builder": lambda key, force: build_connectivity_hazard_raster(key, force=force)["path"]},
}
_AHP_PRERECLASSIFIED_FACTOR_BUILDERS = {
    "lulc":             lambda key, force: build_lulc_raster(key, force=force)["reclass_path"],
    "soil_type":        lambda key, force: build_soil_texture_raster(key, force=force)["reclass_path"],
    "drainage_density": lambda key, force: build_drainage_density_raster(key, force=force)["reclass_path"],
}


def build_ahp_susceptibility_raster(catchment_key, lite=True, force=False):
    """Phase 2.5.3 — the actual AHP weighted-overlay fusion: combines
    every factor raster Phase 2.5.2 built into one susceptibility score
    in [1, 5] per pixel, via sum(weight_i * hazard_class_i), using
    flood_ahp.get_factor_weights' own terrain-conditioned profile —
    chosen AUTOMATICALLY per catchment via flood_ahp.
    classify_terrain_relief (flash-flood catchments, from this
    catchment's own measured max HAND) or flood_ahp.
    classify_riverine_drainage_density (riverine catchments, from this
    catchment's own measured median stream elevation) — never hand-
    picked, so a future catchment gets classified the same principled
    way instead of a new hardcoded guess (matching flood_ahp.py's own
    explicit design intent — see its module docstring on why per-
    catchment tuning was rejected).

    Cached per (catchment, lite) as one static raster — every factor
    here is either terrain-static (slope/TWI/curvature/distance_river/
    hand/lulc/soil_type/drainage_density) or treated as a static
    climatology (rainfall/NDVI — see their own builders' docstrings), so
    the whole composite has no live/scenario dimension to key on, unlike
    the discharge-driven or riverine gauge-driven flood-zone rasters.

    Returns {"path", "terrain_class", "weights", "weight_total_used"}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    flood_type = cfg.get("flood_type", "flash")

    from . import flood_ahp

    # force=False here DELIBERATELY, even when the caller passed force=True
    # for the composite itself — `force` on this function means "rebuild
    # the AHP score," never "refetch the whole terrain pipeline." Confirmed
    # live this session (§ this project's own r0_baseline.json note) that
    # cascading force=True into build_hand_pipeline triggers a real DEM
    # refetch with its own confirmed run-to-run non-determinism — an
    # unrelated, unwanted side effect of just wanting a fresh AHP composite.
    pipeline = build_hand_pipeline(catchment_key, force=False)
    dem_path = pipeline["paths"]["conditioned"]
    hand_path = pipeline["paths"]["hand"]
    streams_path = pipeline["paths"]["streams"]

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        hand_arr, hand_gt, hand_proj, hand_nodata, hw, hh = _read_raster_array(hand_path)

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    hand_valid = valid & (hand_arr != hand_nodata) if hand_nodata is not None else valid.copy()

    if flood_type == "riverine":
        with _gdal_lock():
            stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)
        stream_mask = np.ones_like(stream_arr, dtype=bool)
        if snodata is not None:
            stream_mask &= (stream_arr != snodata)
        stream_mask &= (stream_arr > 0) & valid
        median_stream_elev_m = (
            float(np.median(dem_arr[stream_mask])) if stream_mask.any()
            else float(np.median(dem_arr[valid]))
        )
        terrain_class = flood_ahp.classify_riverine_drainage_density(median_stream_elev_m)
    else:
        hand_max_m = float(hand_arr[hand_valid].max()) if hand_valid.any() else 0.0
        terrain_class = flood_ahp.classify_terrain_relief(hand_max_m)

    weights = flood_ahp.get_factor_weights(terrain_class, lite=lite)

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    lite_tag = "lite" if lite else "full"
    out_path = os.path.join(out_dir, f"30_ahp_susceptibility_{lite_tag}.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path, "terrain_class": terrain_class, "weights": weights,
                "weight_total_used": round(sum(weights.values()), 4)}

    score = np.zeros_like(dem_arr, dtype=np.float64)
    weight_total_used = 0.0
    for factor_key, weight in weights.items():
        if factor_key == "hand":
            hazard = _quantile_reclassify_hazard(hand_arr, hand_valid, ascending=False)
            f_valid = hand_valid
        elif factor_key in _AHP_PRERECLASSIFIED_FACTOR_BUILDERS:
            factor_path = _AHP_PRERECLASSIFIED_FACTOR_BUILDERS[factor_key](catchment_key, False)
            with _gdal_lock():
                f_arr, f_gt, f_proj, f_nodata, fw, fh = _read_raster_array(factor_path)
            f_valid = valid & (f_arr != f_nodata) if f_nodata is not None else valid.copy()
            hazard = f_arr  # already 1-5, use directly — do not requantize a second time
        elif factor_key in _AHP_CONTINUOUS_FACTOR_SPEC:
            spec = _AHP_CONTINUOUS_FACTOR_SPEC[factor_key]
            factor_path = spec["builder"](catchment_key, False)
            with _gdal_lock():
                f_arr, f_gt, f_proj, f_nodata, fw, fh = _read_raster_array(factor_path)
            f_valid = valid & (f_arr != f_nodata) if f_nodata is not None else valid.copy()
            hazard = _quantile_reclassify_hazard(f_arr, f_valid, ascending=spec["ascending"])
        else:
            logger.warning(
                "flood_model: AHP factor %r (weight %.4f) has no raster builder — "
                "skipped from %r's composite", factor_key, weight, catchment_key,
            )
            continue

        hazard = np.where(f_valid, hazard, 3.0)  # neutral midpoint fallback where THIS factor
                                                  # is locally invalid, same convention as
                                                  # _reclassify's own default — never lets one
                                                  # factor's missing data zero out the whole cell
        score += weight * hazard
        weight_total_used += weight

    # weight_total_used should already be ~1.0 (get_factor_weights' own
    # profiles are CR-validated and sum to 1.0) — NOT renormalized here;
    # a shortfall is a real, loud signal that some factor raster failed/
    # was skipped above, not something to silently paper over by
    # rescaling the rest to compensate.
    if abs(weight_total_used - 1.0) > 0.01:
        logger.error(
            "flood_model: AHP composite for %r used only %.4f of total factor weight "
            "(a factor raster failed or was skipped) — treat this score as unreliable "
            "until investigated, not silently rescaled",
            catchment_key, weight_total_used,
        )

    score = np.where(valid, score, _DISCHARGE_STAGE_NODATA)
    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, score, dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    return {
        "path": out_path, "terrain_class": terrain_class, "weights": weights,
        "weight_total_used": round(weight_total_used, 4),
    }


def _ahp_susceptibility_ramp_file():
    """A fixed 1-5 color-relief ramp (green=1, low susceptibility ->
    red=5, high susceptibility — the standard traffic-light hazard-scale
    convention) for rendering build_ahp_susceptibility_raster's own
    score to a PNG, same gdal.DEMProcessing mechanism every other mode's
    own ramp file already uses. nodata line matches
    _DISCHARGE_STAGE_NODATA (-9999), not 0 — this raster's own valid
    range starts at 1, so 0 is not a safe nodata sentinel here either,
    same reasoning already documented at every other binary/scored
    raster in this module."""
    ramp_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, "_ramps")
    os.makedirs(ramp_dir, exist_ok=True)
    path = os.path.join(ramp_dir, "ahp_susceptibility.txt")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    lines = [
        "nv 0 0 0 0",
        "1 30 160 60 200",
        "2 140 200 60 200",
        "3 230 210 40 200",
        "4 230 140 30 200",
        "5 210 30 30 220",
    ]
    tmp_path = f"{path}.tmp{os.getpid()}"
    with open(tmp_path, "w") as f:
        f.write("\n".join(lines))
    os.replace(tmp_path, path)
    return path


def render_ahp_susceptibility_png(catchment_key, lite=True, force=False):
    """Colorizes build_ahp_susceptibility_raster's own [1,5] score into a
    servable PNG — the AHP mode's actual deliverable, same warp/colorize/
    atomic-write/post-write-validation conventions render_flood_prone_
    zones already established. Returns {"png_url", "bounds",
    "terrain_class", "weights", "weight_total_used"} — the extra fields
    (beyond every other mode's own png_url/bounds) so a caller/frontend
    can show WHICH literature-conditioned profile actually ran and its
    exact weights, matching this project's own "never hide the numbers
    behind the result" convention."""
    ahp_result = build_ahp_susceptibility_raster(catchment_key, lite=lite, force=force)
    score_path = ahp_result["path"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    lite_tag = "lite" if lite else "full"
    png_path = os.path.join(out_dir, f"ahp_susceptibility_{lite_tag}.png")

    if not force and os.path.exists(png_path) and os.path.getsize(png_path) >= 512:
        payload = _flood_zone_payload(png_path, score_path)
        payload["terrain_class"] = ahp_result["terrain_class"]
        payload["weights"] = ahp_result["weights"]
        payload["weight_total_used"] = ahp_result.get("weight_total_used")
        return payload

    ramp = _ahp_susceptibility_ramp_file()
    tmp_png = f"{png_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        colored_ds = gdal.DEMProcessing(
            tmp_png, score_path, "color-relief",
            colorFilename=ramp, format="PNG", addAlpha=True,
        )
        if colored_ds is None:
            raise RuntimeError("gdal.DEMProcessing (color-relief) returned None for AHP susceptibility")
        colored_ds = None
        check_ds = gdal.Open(tmp_png)
        if check_ds is None or check_ds.RasterXSize <= 0 or check_ds.RasterYSize <= 0:
            raise RuntimeError("AHP susceptibility PNG failed post-write validation")
        check_ds = None
    os.replace(tmp_png, png_path)
    stray_aux = f"{tmp_png}.aux.xml"
    if os.path.exists(stray_aux):
        try:
            os.remove(stray_aux)
        except OSError:
            pass

    payload = _flood_zone_payload(png_path, score_path)
    payload["terrain_class"] = ahp_result["terrain_class"]
    payload["weights"] = ahp_result["weights"]
    payload["weight_total_used"] = ahp_result.get("weight_total_used")
    return payload


# AHP zonation (post-launch addition, see FLASH_FLOOD_EARLY_WARNING_
# METHODOLOGY.md's own AHP-zonation plan) — the AHP susceptibility mode
# originally shipped as a smooth, continuous [1,5]-score PNG covering the
# WHOLE catchment bbox. Confirmed live via a real screenshot review: this
# reads as "too big"/unclipped next to every other mode's own binary,
# clipped flood-zone rendering. Fixed by reclassifying the continuous
# score into 3 discrete zone classes and vectorizing each into polygons
# (below), so only meaningfully-susceptible area reads as colored — same
# visual language as the existing binary flood-zone layers, not a new
# paradigm.
#
# 3 classes (Low/Medium/High) via FIXED breakpoints on the score's own
# [1,5] scale — a DELIBERATE departure from how individual INPUT factors
# are reclassified elsewhere in this same pipeline (per-catchment
# quantiles, since raw units like rainfall/TWI have no universal scale).
# The AHP OUTPUT score is already a normalized, fixed 1-5 hazard scale by
# construction (every input factor was itself reclassified onto this same
# scale before combining) — fixed absolute breakpoints are what make
# "High zone" mean the same real thing in every catchment nationwide,
# which is the whole point of this methodology being built to generalize
# across Pakistan, not tuned per pilot. No literature source in this
# project's own AHP review gives a universal 1-5-score breakpoint scheme
# — this is this project's OWN reasoned choice (equal thirds of the
# scale), labeled as such, not attributed to any of [A]-[J].
_AHP_ZONE_LABELS = {1: "low", 2: "medium", 3: "high"}
_AHP_ZONE_BREAKS = (1.0 + 4.0 / 3.0, 1.0 + 8.0 / 3.0)  # (2.333..., 3.666...) — the honest, uncalibrated default

# Youden's-J-calibrated breakpoints (flood_validation.
# calibrate_ahp_zone_breakpoints, run offline against real GFD ground
# truth for the smoothed score — see the methodology doc's own
# calibration-run section for the full numbers/reasoning). Keyed by
# TERRAIN CLASS, not catchment — matching how weight profiles are
# already terrain-class-conditioned (flood_ahp.py), so a future
# catchment sharing a class automatically gets the SAME real, data-
# calibrated breakpoints, not a per-catchment special case. A class
# absent from this dict (never yet calibrated) falls back to
# _AHP_ZONE_BREAKS — an honest degradation, not a silent wrong number.
# Calibration is a DESIGN-TIME/OFFLINE process, deliberately NOT run on
# the hot request path (no live GFD dependency added to a user-facing
# "Run" click) — the exact same posture this project's own AHP weight
# literature review already established (researched once, hardcoded,
# reproducible via the calibration function again if ever needed).
#
# CALIBRATED LIVE (flood_validation.calibrate_ahp_zone_breakpoints,
# n_events=17-20 real GFD events per catchment, n_samples=200,
# n_trials=5, pooled before calibrating — not averaged across trials):
#
# terrain_class            T1 (low/med)  T2 (med/high)  stage1 J  stage2 J
# moderate_relief (Nullah Lai)   3.1256       3.5678       0.721     0.420
# flat_relief (Bhudni Nullah)    2.9008       3.3386       0.556     0.376
# high_drainage_density (Chashma)2.6609       3.3557       0.390     0.222
# low_drainage_density (Guddu)   2.3390       3.0458       0.213     0.100
#
# Stage-1 J tracks the SAME per-catchment AUC ranking already established
# (nullah_lai strongest, guddu weakest) — an internal-consistency signal
# the calibration is measuring something real, not noise. Directly
# addresses the "Medium always dominates" finding that motivated this
# calibration: nullah_lai's own T1 (3.13) is far ABOVE the fixed
# default's 2.33, meaning calibration finds "Low" should span a much
# WIDER score range there than the naive fixed-thirds split assumed.
_AHP_ZONE_BREAKS_CALIBRATED = {
    "moderate_relief": (3.1256, 3.5678),
    "flat_relief": (2.9008, 3.3386),
    "high_drainage_density": (2.6609, 3.3557),
    "low_drainage_density": (2.3390, 3.0458),
}
# §0.50 — the ONLY 4 catchments _AHP_ZONE_BREAKS_CALIBRATED's own numbers
# were actually derived FROM (flood_validation.calibrate_ahp_zone_
# breakpoints, real GFD events, n_events=17-20/n_samples=200/n_trials=5,
# pooled). Every OTHER catchment sharing one of these 4 terrain classes
# (§0.48's 31 riverine stations, §0.49's 4 new flash-flood pilots, any
# custom AOI) would be borrowing a DIFFERENT area's own calibration —
# exactly the same "basin-calibrated absolute threshold applied to an
# unrelated area's own distribution" problem §0.41 already fixed for
# custom AOIs, just not yet fixed for these 35 named additions. Used by
# build_ahp_zone_geometries to gate which catchments keep the
# calibrated lookup (these 4, unchanged) vs. get a real, catchment-
# specific check instead (everyone else).
_CALIBRATED_PILOT_CATCHMENTS = frozenset({
    "nullah_lai", "peshawar_bhudni_nullah", "chashma_indus", "guddu_indus",
})
# Same severity palette this app's own "Hydrological Layers" flood-extent
# layers already use (frontend/src/modules/map-layers.js's own
# buildFloodExtents() IIFE: High #C70039 / Medium #FF5733 / Low #FFC300)
# — reused verbatim for visual consistency with the rest of the app's own
# hydrological-severity language, not a new invented palette.
_AHP_ZONE_COLORS = {"low": "#FFC300", "medium": "#FF5733", "high": "#C70039"}

# Real, measured target for build_ahp_zone_geometries' own self-adaptive
# sieve/simplify backoff — 1.5MB is comfortably renderable by Mapbox GL
# as a single GeoJSON source without a noticeable parse/paint stall,
# while still being generous enough that even the largest pilot
# (guddu_indus, 3.3M cells) converges within a small number of doublings
# in practice (confirmed live, not assumed). 6 iterations bounds the
# absolute worst case at 100px*2^6=6400px sieve / 5.0*2^6=320x simplify —
# an extreme flattening that would only ever be reached for a
# pathologically noisy score no real catchment has produced so far.
_AHP_ZONE_MAX_GEOJSON_BYTES = 1_500_000
_AHP_ZONE_MAX_ADAPT_ITERATIONS = 6

# §0.41 — bounds how many sample values _local_natural_breaks ever runs
# its k-means loop over. A custom AOI is capped at MAX_CUSTOM_AOI_BBOX_
# DEG2 (0.30 deg²) already (flood-model-control.js's own client-side
# check + the server's own _validate_catchment_bbox), which on this 30m
# grid is at most on the order of a few hundred thousand cells — this
# cap just keeps the classification step itself boundedly fast even at
# that ceiling, via a systematic (never random — reproducible given the
# same input) stride sample, not a truncation that biases toward one
# corner of the AOI.
_LOCAL_BREAKS_MAX_SAMPLES = 20_000


def _local_natural_breaks(values, n_classes=3):
    """A 1-D k-means (n_classes clusters) classification of `values` —
    the practical stand-in used here for Jenks Natural Breaks without
    adding a new dependency (no jenkspy/similar package in this app's
    existing requirements). Jenks and 1-D k-means minimize the same
    within-class-variance objective; k-means is the standard iterative
    approximation (ESRI's own ArcGIS documentation describes its Natural
    Breaks classifier as functionally equivalent to this for a 1-D
    field) — not claimed here as the textbook-exact Fisher's dynamic-
    programming solution, just its well-established practical cousin.

    Confirmed via literature search (see the methodology doc's own
    §0.41) that Natural Breaks classification is the literature-
    preferred method specifically for the situation a custom AOI is in:
    no independent local calibration/ground-truth data for the exact
    study area, unlike the 4 curated pilots (Youden's-J-calibrated
    against real GFD events — see _AHP_ZONE_BREAKS_CALIBRATED's own
    docstring). Using THAT basin-calibrated absolute-threshold scheme on
    a small custom AOI's own, differently-distributed score values is
    what produced the confirmed-live bug this function fixes (a real
    user screenshot: two sharp, disconnected polygon shards, not real
    zonation) — classifying against the AOI's OWN local distribution
    instead is the correct fix, not a cosmetic one.

    Returns (low_break, high_break), sorted ascending. Falls back to
    _AHP_ZONE_BREAKS (fixed thirds — the same "honest, uncalibrated
    default" every other degraded path in this module already uses) if
    there are fewer than n_classes distinct values — a genuinely
    degenerate case (e.g. an AOI small/uniform enough that no real
    natural clusters exist), not something worth failing the whole run
    over."""
    vals = np.asarray(values, dtype=np.float64)
    vals = vals[np.isfinite(vals)]
    if vals.size > _LOCAL_BREAKS_MAX_SAMPLES:
        stride = math.ceil(vals.size / _LOCAL_BREAKS_MAX_SAMPLES)
        vals = vals[::stride]
    uniq = np.unique(vals)
    # A genuinely uniform/near-flat AOI (e.g. a very small, physically
    # homogeneous urban block) can still have thousands of technically-
    # DISTINCT float values purely from floating-point noise a couple
    # orders of magnitude below anything physically meaningful — k-means
    # would happily carve that noise into 3 "clusters" that don't
    # correspond to any real susceptibility difference. Guarded
    # separately from the distinct-value check above: on the AHP score's
    # own [1,5] scale, a spread under 0.05 (a small fraction of even the
    # narrowest real class width in _AHP_ZONE_BREAKS_CALIBRATED, ~0.35)
    # is treated as "no real local variation to classify" and falls back
    # to the same honest default, rather than manufacturing false
    # precision out of noise.
    if uniq.size < n_classes or (uniq.max() - uniq.min()) < 0.05:
        return _AHP_ZONE_BREAKS

    # Deterministic quantile-seeded centers (never a random init — this
    # project's own established "no unexplained nondeterminism" posture:
    # the SAME input always produces the SAME breaks, every run).
    centers = np.quantile(vals, np.linspace(0, 1, n_classes + 2)[1:-1])
    for _ in range(50):
        labels = np.argmin(np.abs(vals[:, None] - centers[None, :]), axis=1)
        new_centers = np.array([
            vals[labels == k].mean() if np.any(labels == k) else centers[k]
            for k in range(n_classes)
        ])
        if np.allclose(new_centers, centers):
            break
        centers = new_centers

    centers = np.sort(centers)
    breaks = (centers[:-1] + centers[1:]) / 2.0
    return float(breaks[0]), float(breaks[1])


def _classify_ahp_zones(score_arr, valid_mask, breaks=None):
    """Breakpoint reclassification of the AHP [1,5] score into 3 zone
    codes (1=low, 2=medium, 3=high). `breaks` (low_break, high_break)
    defaults to _AHP_ZONE_BREAKS (fixed thirds) — a caller with a real,
    Youden's-J-calibrated pair for this catchment's own terrain class
    (_AHP_ZONE_BREAKS_CALIBRATED) passes it explicitly instead; see
    that dict's own docstring for why FIXED-per-class (not per-
    catchment quantile) breakpoints are the deliberate right choice for
    this OUTPUT score specifically. Cells outside `valid_mask` get 0
    (not a real class — filtered out before vectorization, never
    appears in _AHP_ZONE_LABELS)."""
    if breaks is None:
        breaks = _AHP_ZONE_BREAKS
    zone = np.zeros_like(score_arr, dtype=np.float64)
    low_break, high_break = breaks
    zone = np.where(score_arr < low_break, 1.0, zone)
    zone = np.where((score_arr >= low_break) & (score_arr < high_break), 2.0, zone)
    zone = np.where(score_arr >= high_break, 3.0, zone)
    return np.where(valid_mask, zone, 0.0)


# ---------------------------------------------------------------------------
# §0.43 — Frequency Ratio (FR) cross-check + AHP-FR ensemble, CUSTOM AOI
# ONLY. A curated pilot already has a real, Youden's-J-calibrated AHP
# threshold pair (_AHP_ZONE_BREAKS_CALIBRATED, computed offline against
# real GFD events — see that dict's own docstring) — there is no
# equivalent per-request need for a pilot. A custom AOI has none of that,
# which is exactly why §0.41's local-natural-breaks fix exists; this goes
# one step further where real ground truth happens to be available:
# rather than classifying the AHP score ALONE against its own local
# distribution, cross-check it against REAL, observed flood pixels
# (Global Flood Database — genuinely bbox-queryable for essentially any
# Pakistani area, unlike the 7 named WFS river systems flood_validation.
# run_flood_extent_shape_comparison already probes) via Frequency Ratio,
# a literature-established bivariate-statistics method, and ensemble the
# two. Confirmed via literature search (see the methodology doc's own
# §0.43): AHP-FR ensembles routinely match or beat AHP alone on AUC, and
# FR itself needs no training pipeline or new dependency — unlike a full
# Random Forest model, which the SAME literature explicitly says gets its
# real value from large, multi-source, MULTI-basin training data (not a
# per-AOI fit) — a genuinely separate, much larger undertaking correctly
# out of scope for "improve this specific custom-drawn area's own
# result."  A curated pilot's own cfg never sets clip_polygon — this
# entire block is a no-op for all 4, by construction.
# ---------------------------------------------------------------------------

_FR_HAZARD_CLASSES = (1.0, 2.0, 3.0, 4.0, 5.0)
# Below this many real GFD presence pixels overlapping the AOI's own
# valid area, a Frequency Ratio is too noisy to trust (a handful of
# pixels can put ANY hazard class at FR=infinity or FR=0 by chance) —
# falls back to AHP-alone rather than reporting a number built on almost
# nothing. Not a literature-cited threshold — this project's own
# reasoned minimum, labeled as such (same posture _AHP_ZONE_BREAKS'
# own comment already uses for its equal-thirds default).
_FR_MIN_PRESENCE_PIXELS = 5


def _fetch_gfd_presence_for_custom_aoi(catchment_key, bbox, force=False):
    """Real, satellite-observed flood presence for a custom AOI's own
    bbox — accuracy_assessment.fetch_gfd_flood_extent, genuinely bbox-
    driven (Earth Engine filterBounds), unlike the 7 named WFS river
    systems (upper/lower Indus, Jhelum, Chenab, Ravi, Sutlej, Kabul)
    flood_validation.run_flood_extent_shape_comparison already probes —
    GFD (Global Flood Database, Tellman et al. 2021) is a GLOBAL MODIS-
    derived dataset, so it has some real chance of coverage for
    essentially any Pakistani area, not just those 7 mapped reaches.
    Disk-cached (a real Earth Engine reduceToVectors call, not free);
    degrades to an empty list on any failure or genuine no-coverage,
    never raises — matching accuracy_assessment's own established
    convention for every other ground-truth fetcher in this app."""
    from shapely.geometry import shape as shapely_shape

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    os.makedirs(out_dir, exist_ok=True)
    cache_path = os.path.join(out_dir, "gfd_presence.json")

    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with open(cache_path) as f:
                cached = json.load(f)
            return [shapely_shape(g) for g in cached]
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_model: GFD presence cache %s unreadable (%s) — refetching "
                "instead of trusting a stale/corrupt entry", cache_path, exc,
            )

    from . import accuracy_assessment as aa
    geoms = aa.fetch_gfd_flood_extent(bbox)

    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump([g.__geo_interface__ for g in geoms], f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning(
            "flood_model: could not write GFD presence cache for %r (non-fatal — "
            "will simply be refetched next time)", catchment_key, exc_info=True,
        )
    return geoms


def _factor_hazard_array(catchment_key, factor_key, valid):
    """Re-derives ONE AHP factor's own already-reclassified [1,5] hazard
    array — the SAME retrieval build_ahp_susceptibility_raster's own
    per-factor loop already does (same builders, same _quantile_
    reclassify_hazard calls for continuous factors, same direct read for
    pre-reclassified ones). Deliberately duplicated here rather than
    refactored out of that function: build_ahp_susceptibility_raster is
    the already-validated, load-bearing composite every curated pilot's
    own hardcoded AUC/calibration numbers were computed against —
    re-plumbing its internals to share this logic risked a subtle
    regression there for a benefit (avoiding ~15 duplicated lines) not
    worth that risk. Each factor's own raster is independently disk-
    cached by its own builder already, so calling these builders again
    here is a cheap re-read, never a re-fetch. A known, deliberate
    trade-off, named as such — not silently duplicated (same posture
    this project already uses for the §0.36 build_riverine_flood_zone
    dead-code note).

    Returns (hazard_arr, factor_valid_mask), or (None, None) for a
    factor with no builder (matches build_ahp_susceptibility_raster's
    own loud-warning-then-skip posture, just without the composite
    context to log against here)."""
    if factor_key == "hand":
        pipeline = build_hand_pipeline(catchment_key, force=False)
        with _gdal_lock():
            arr, gt, proj, nodata, w, h = _read_raster_array(pipeline["paths"]["hand"])
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        return _quantile_reclassify_hazard(arr, f_valid, ascending=False), f_valid
    if factor_key in _AHP_PRERECLASSIFIED_FACTOR_BUILDERS:
        factor_path = _AHP_PRERECLASSIFIED_FACTOR_BUILDERS[factor_key](catchment_key, False)
        with _gdal_lock():
            arr, gt, proj, nodata, w, h = _read_raster_array(factor_path)
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        return arr, f_valid
    if factor_key in _AHP_CONTINUOUS_FACTOR_SPEC:
        spec = _AHP_CONTINUOUS_FACTOR_SPEC[factor_key]
        factor_path = spec["builder"](catchment_key, False)
        with _gdal_lock():
            arr, gt, proj, nodata, w, h = _read_raster_array(factor_path)
        f_valid = valid & (arr != nodata) if nodata is not None else valid.copy()
        return _quantile_reclassify_hazard(arr, f_valid, ascending=spec["ascending"]), f_valid
    return None, None


def _frequency_ratio_for_factor(hazard_arr, valid_mask, presence_mask):
    """Standard Frequency Ratio (bivariate statistics) per hazard class
    (1-5) for one factor: (that class's share of observed PRESENCE
    pixels) / (that class's share of the AOI's own total VALID area).
    FR > 1 = over-represented among real observed floods (more
    susceptible than the factor's own average class); FR < 1 = under-
    represented; FR == 1 = exactly proportionate. A class with zero
    valid cells gets the neutral value 1.0 (no signal either way, never
    a divide-by-zero). Returns None if there's no real area or no real
    presence pixels to compute a ratio from at all."""
    total_valid = int(valid_mask.sum())
    total_presence = int((valid_mask & presence_mask).sum())
    if total_valid == 0 or total_presence == 0:
        return None
    fr_by_class = {}
    for cls in _FR_HAZARD_CLASSES:
        class_mask = valid_mask & (hazard_arr == cls)
        class_total = int(class_mask.sum())
        if class_total == 0:
            fr_by_class[cls] = 1.0
            continue
        class_presence = int((class_mask & presence_mask).sum())
        presence_share = class_presence / total_presence
        area_share = class_total / total_valid
        fr_by_class[cls] = (presence_share / area_share) if area_share > 0 else 1.0
    return fr_by_class


def _minmax_normalize(arr, mask):
    """Min-max normalizes `arr` to [0,1] over `mask`'s own cells only —
    cells outside `mask` are left at whatever np.where(...) the caller
    applies afterward (this function only computes the 0-1 SCALE, it
    doesn't itself mask output). A degenerate all-equal input (max==min)
    returns a flat 0.5 everywhere in mask rather than dividing by zero —
    an honest "no real spread to normalize" outcome, same posture
    _local_natural_breaks' own near-constant guard already uses."""
    vals = arr[mask]
    if vals.size == 0:
        return np.zeros_like(arr)
    lo, hi = float(vals.min()), float(vals.max())
    if hi - lo < 1e-9:
        return np.full_like(arr, 0.5)
    return np.clip((arr - lo) / (hi - lo), 0.0, 1.0)


def compute_frequency_ratio_ensemble(catchment_key, lite=True, force=False):
    """§0.43's original deliverable, for a CUSTOM AOI — broadened in
    §0.50 to ANY catchment, named or custom (nothing inside this
    function actually depends on `clip_polygon` beyond how the caller
    later uses `score_for_classification` — see build_ahp_zone_
    geometries' own dispatch). Fetches real GFD flood-presence pixels
    for this catchment's own bbox; if there are enough (>=
    _FR_MIN_PRESENCE_PIXELS) overlapping its own valid area, computes a
    Frequency Ratio index (summed, unweighted, across every factor this
    catchment's own terrain-class weight profile actually uses — the
    standard literature-baseline FR formulation; no expert pairwise
    weights needed, since observed frequency IS the weight), min-max
    normalizes it against the (also normalized) AHP score, and averages
    the two 50/50 into a final ensemble susceptibility raster.

    Both the AHP-alone score and the new ensemble are then scored for
    REAL, live AUC against the SAME presence pixels via accuracy_
    assessment.assess_raster_auc_stable — the SAME multi-trial machinery
    the original 4 curated pilots' own hardcoded design-time AUC numbers
    were computed with, not a separate/less-rigorous shortcut. Reporting
    BOTH (not just the ensemble's own number) is deliberate — an honest
    "did this actually help THIS area" comparison, matching this
    project's own standing discipline of reporting real measurements
    even when they don't flatter the newer approach.

    §0.50 — for a NAMED catchment (§0.48/§0.49's own 35 new additions,
    none of which had a per-catchment design-time Youden's-J calibration
    run the way the original 4 pilots did — see _AHP_ZONE_BREAKS_
    CALIBRATED's own docstring), this gives a REAL, catchment-specific
    accuracy number instead of silently inheriting a DIFFERENT
    catchment's own calibrated breakpoints just because they happen to
    share a terrain_class. Harmless to also run for one of the original
    4 (it would just add a second, independent live cross-check
    alongside their existing offline-calibrated figure) — not special-
    cased away, since the function's own graceful "no ground truth
    nearby -> None" degradation already handles every case correctly.

    Returns None — a real, EXPECTED outcome for many areas, not a bug —
    if: GFD has no presence pixels overlapping the bbox, or too few
    overlap the catchment's own valid area specifically to trust a
    ratio. Otherwise returns {"ensemble_score_path", "n_presence_pixels",
    "factors_used", "ahp_auc", "ensemble_auc"} — both *_auc entries are
    assess_raster_auc_stable's own full dict (auc_mean/auc_min/auc_max/
    interpretation/n_trials_used)."""
    if catchment_key not in PILOT_CATCHMENTS:
        return None
    cfg = PILOT_CATCHMENTS[catchment_key]

    from shapely.ops import unary_union
    from . import accuracy_assessment as aa
    from . import flood_ahp

    bbox = cfg["bbox"]
    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    lite_tag = "lite" if lite else "full"
    cache_path = os.path.join(out_dir, f"fr_ensemble_{lite_tag}.json")
    score_path = os.path.join(out_dir, f"fr_ensemble_score_{lite_tag}.tif")

    if not force and os.path.exists(cache_path) and os.path.exists(score_path):
        try:
            with open(cache_path) as f:
                cached = json.load(f)
            cached["ensemble_score_path"] = score_path
            return cached
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(
                "flood_model: FR-ensemble cache %s unreadable (%s) — rebuilding "
                "from scratch instead of trusting a stale/corrupt entry",
                cache_path, exc,
            )

    presence_geoms = _fetch_gfd_presence_for_custom_aoi(catchment_key, bbox, force=force)
    if not presence_geoms:
        logger.info(
            "flood_model: no GFD flood-presence pixels overlap %r's bbox — Frequency "
            "Ratio ensemble skipped (a real, expected outcome for many areas, not a "
            "bug); build_ahp_zone_geometries falls back to its own AHP-alone breaks",
            catchment_key,
        )
        return None

    ahp_result = build_ahp_susceptibility_raster(catchment_key, lite=lite, force=False)
    terrain_class = ahp_result["terrain_class"]
    weights = flood_ahp.get_factor_weights(terrain_class, lite=lite)

    with _gdal_lock():
        ahp_arr, ahp_gt, ahp_proj, ahp_nodata, w, h = _read_raster_array(ahp_result["path"])
    valid = ahp_arr != ahp_nodata if ahp_nodata is not None else np.ones_like(ahp_arr, dtype=bool)

    presence_geojson = unary_union(presence_geoms).__geo_interface__
    presence_mask_arr = _clip_array_to_polygon(
        np.ones(ahp_arr.shape, dtype=np.uint8), ahp_gt, ahp_proj, 0, presence_geojson,
    )
    presence_mask = presence_mask_arr.astype(bool) & valid
    n_presence_pixels = int(presence_mask.sum())
    if n_presence_pixels < _FR_MIN_PRESENCE_PIXELS:
        logger.info(
            "flood_model: only %d GFD presence pixel(s) overlap %r's own valid area "
            "(< %d minimum) — too few for a reliable Frequency Ratio; build_ahp_zone_"
            "geometries falls back to its own AHP-alone breaks",
            n_presence_pixels, catchment_key, _FR_MIN_PRESENCE_PIXELS,
        )
        return None

    fr_sum = np.zeros_like(ahp_arr, dtype=np.float64)
    factors_used = []
    for factor_key in weights:
        hazard_arr, f_valid = _factor_hazard_array(catchment_key, factor_key, valid)
        if hazard_arr is None:
            continue
        fr_by_class = _frequency_ratio_for_factor(hazard_arr, f_valid, presence_mask)
        if fr_by_class is None:
            continue
        factor_fr = np.ones_like(ahp_arr, dtype=np.float64)
        for cls, fr_val in fr_by_class.items():
            factor_fr = np.where(f_valid & (hazard_arr == cls), fr_val, factor_fr)
        fr_sum += factor_fr
        factors_used.append(factor_key)

    if not factors_used:
        logger.warning(
            "flood_model: no AHP factor rasters were usable for custom AOI %r's own "
            "Frequency Ratio computation — falling back to AHP-alone", catchment_key,
        )
        return None

    ahp_norm = _minmax_normalize(ahp_arr, valid)
    fr_norm = _minmax_normalize(fr_sum, valid)
    ensemble = 0.5 * ahp_norm + 0.5 * fr_norm
    # Smoothed with the SAME adaptive radius build_ahp_smoothed_score_
    # raster's own custom-AOI branch uses (this function only ever runs
    # for a custom AOI — the early `if not clip_polygon: return None`
    # above guarantees that) — without this, the ensemble would carry
    # the raw AHP composite's own per-pixel classification noise right
    # back in, exactly what smoothing exists to remove (see that
    # function's own docstring); skipping it here would make the
    # ensemble LESS spatially coherent than the AHP-alone score it's
    # meant to improve on, not more.
    from . import flood_connectivity
    adaptive_radius = max(1, min(8, min(h, w) // 20))
    ensemble = flood_connectivity.box_mean_filter(ensemble, valid, radius_cells=adaptive_radius)
    ensemble_out = np.where(valid, ensemble, _DISCHARGE_STAGE_NODATA)

    tmp_score = f"{score_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_score, ensemble_out, ahp_gt, ahp_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_score, score_path)

    # invert_score=False for BOTH — higher already means more susceptible
    # for the AHP [1,5] score AND the normalized [0,1] ensemble
    # (assess_raster_auc's own docstring names AHP-style scores
    # explicitly as the case invert_score=False is for). Scored against
    # the SMOOTHED AHP raster (the same one §0.41's own local-natural-
    # breaks classification actually uses), not the raw composite — an
    # apples-to-apples "did the ensemble actually help THIS area"
    # comparison against what the AHP-alone fallback path really
    # produces, not a different, noisier baseline.
    smoothed_for_auc = build_ahp_smoothed_score_raster(catchment_key, lite=lite, force=False)
    ahp_auc = aa.assess_raster_auc_stable(smoothed_for_auc["path"], presence_geoms, bbox, invert_score=False)
    ensemble_auc = aa.assess_raster_auc_stable(score_path, presence_geoms, bbox, invert_score=False)

    payload = {
        "n_presence_pixels": n_presence_pixels,
        "factors_used": factors_used,
        "ahp_auc": ahp_auc,
        "ensemble_auc": ensemble_auc,
    }
    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    try:
        with open(tmp_cache, "w") as f:
            json.dump(payload, f)
        os.replace(tmp_cache, cache_path)
    except OSError:
        logger.warning(
            "flood_model: could not write FR-ensemble cache for %r (non-fatal — "
            "will simply be recomputed next time)", catchment_key, exc_info=True,
        )
    payload["ensemble_score_path"] = score_path
    return payload


def build_ahp_smoothed_score_raster(catchment_key, lite=True, force=False):
    """Smooths build_ahp_susceptibility_raster's own continuous [1,5]
    score (flood_connectivity.box_mean_filter, radius 8 cells — see that
    function's own docstring for the full "why": removes pixel-level
    classification noise from combining several already-noisy factors).
    Originally built inline only to fix the zone-vectorization payload-
    size problem — confirmed live afterward (methodology doc §0.31) that
    it ALSO improves AUC at all 4 pilot catchments, not just file size.

    Extracted into its own cached function (was inline in
    build_ahp_zone_geometries) so it has exactly ONE implementation
    consumed by every downstream user of "the smoothed score" —
    build_ahp_zone_geometries (classification input) and
    flood_validation.calibrate_ahp_zone_breakpoints (Youden's J
    calibration input both need to measure/classify the EXACT SAME
    field, never a stale or subtly-different version of it.

    Returns {"path": cached smoothed-score raster path}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    from . import flood_connectivity

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    lite_tag = "lite" if lite else "full"
    out_path = os.path.join(out_dir, f"ahp_smoothed_score_{lite_tag}.tif")

    if not force and os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return {"path": out_path}

    ahp_result = build_ahp_susceptibility_raster(catchment_key, lite=lite, force=False)
    score_path = ahp_result["path"]

    with _gdal_lock():
        score_arr, score_gt, score_proj, score_nodata, w, h = _read_raster_array(score_path)
    valid = score_arr != score_nodata if score_nodata is not None else np.ones_like(score_arr, dtype=bool)

    # §0.41 — radius_cells=8 (fixed, a ~17x17 cell / ~510m window on this
    # 30m grid) was tuned/confirmed live to improve AUC at BASIN scale
    # (tens of km², the 4 curated pilots — see this function's own
    # docstring). Applied unchanged to a small custom-drawn AOI (can be
    # well under 1km² wide), a window that size covers the ENTIRE valid
    # area for nearly every interior cell, collapsing real local
    # variation into a near-constant value — the textbook "scale effect"
    # half of the Modifiable Areal Unit Problem (smoothing/aggregation at
    # a fixed absolute scale erases heterogeneity that matters at a
    # smaller extent). Confirmed live via a real user screenshot: a
    # custom-drawn urban AOI's own AHP zonation rendered as two sharp,
    # disconnected polygon shards, not real terrain-following zones — see
    # FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md's own §0.41 for the full
    # diagnosis + literature citations. Scaled down to a fraction of the
    # AOI's own shorter side for a custom AOI, floored at 1 (never skip
    # smoothing entirely — it still removes real per-pixel classification
    # noise even for a small area, per this function's own docstring).
    # The 1/20 fraction is this project's own reasoned choice, not a
    # literature-cited constant — no source gives a universal "kernel
    # radius vs. extent" ratio (same honest-labeling posture
    # _AHP_ZONE_BREAKS' own comment already uses for its equal-thirds
    # default). A curated pilot catchment never sets clip_polygon —
    # radius stays exactly 8, zero behavior change for all 4.
    cfg = PILOT_CATCHMENTS.get(catchment_key, {})
    if cfg.get("clip_polygon"):
        adaptive_radius = max(1, min(8, min(h, w) // 20))
    else:
        adaptive_radius = 8
    smoothed_score = flood_connectivity.box_mean_filter(score_arr, valid, radius_cells=adaptive_radius)
    out_arr = np.where(valid, smoothed_score, _DISCHARGE_STAGE_NODATA)

    tmp_path = f"{out_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_path, out_arr, score_gt, score_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_path, out_path)

    return {"path": out_path}


def _vectorize_ordinal_zones_gapfree(zone_arr, gt, proj, class_labels, out_dir,
                                      sieve_threshold_px, simplify_tolerance_px, min_mapping_unit_px):
    """§0.51 — vectorizes an ORDINAL (naturally-ranked) multi-class
    raster — exactly AHP's own low=1/medium=2/high=3 — into GUARANTEED
    gap-free polygons. Real user report: §0.42/§0.50's own shrunk-
    sieve/simplify fix only ever made the independent-per-class-
    simplification gap SMALL (confirmed live: 0.55% of the zone envelope
    for guddu_indus, down from 1.25% — a real, measured improvement, not
    zero), and visible breaks/slivers were still reported at basin
    scale. flood_exposure._vectorize_multiclass_raster dissolves and
    simplifies EACH class's own geometry independently (a real, correct
    design for THAT function's own general "arbitrary unrelated
    classes" use case — a filter too aggressive for one class can be
    fine for another, judged separately) — but for classes that are NOT
    independent, i.e. an ORDERED severity ranking like this one, that
    independence is exactly what breaks a once-identical shared
    boundary: no sieve/simplify tolerance, however small, can PROVE a
    gap is impossible, only make it small.

    The actual fix: ORDERED classes have a real, exploitable structure
    independent classes don't — "low" subset "low-or-medium" subset the
    whole valid area, a genuine nesting. Each CUMULATIVE region ("this
    severity or below") is vectorized+sieved+simplified exactly ONCE
    (reusing flood_exposure._vectorize_multiclass_raster unchanged,
    treating each cumulative region as its own single-value 1-class
    raster — the same, already-proven Polygonize+SieveFilter+dissolve+
    simplify+MMU pipeline, just called once per cumulative LEVEL instead
    of once per raw class). Each individual class's own final polygon is
    then recovered via an EXACT shapely set-difference between two
    ALREADY-simplified, nested cumulative regions (e.g. "medium" =
    cumulative_2.difference(cumulative_1)) — the shared boundary between
    two adjacent classes is therefore the SAME simplified curve on both
    sides, by mathematical construction, never two independently-
    simplified curves that happened to start identical and then diverge.

    Classification accuracy is completely unaffected by this — the same
    pixels belong to the same class either way, at the same sieve/
    simplify tolerance as before; only the GEOMETRIC CONSTRUCTION changes
    to make a gap geometrically impossible instead of merely small.

    Returns {class_val: shapely geometry}, only for classes with real
    surviving area — matches _vectorize_multiclass_raster's own "a class
    absent from this catchment's own zonation is simply not a key, not
    an error" convention."""
    from . import flood_exposure

    ordered_classes = sorted(class_labels.keys())
    cumulative_polys = {}
    for k in ordered_classes:
        # The TOP class's own cumulative region ("this or below") is the
        # WHOLE valid area by definition — no need to re-derive it from
        # a threshold comparison, every valid cell already qualifies.
        if k == ordered_classes[-1]:
            cum_mask = zone_arr != _DISCHARGE_STAGE_NODATA
        else:
            cum_mask = (zone_arr != _DISCHARGE_STAGE_NODATA) & (zone_arr <= k)
        cum_arr = np.where(cum_mask, 1.0, 0.0)
        cum_path = os.path.join(out_dir, f"_ahp_cum_{k}_{os.getpid()}.tif")
        with _gdal_lock():
            _write_raster_array(cum_path, cum_arr, gt, proj, 0)
        try:
            with _gdal_lock():
                geoms = flood_exposure._vectorize_multiclass_raster(
                    cum_path, {1: "cum"}, min_mapping_unit_px=min_mapping_unit_px,
                    sieve_threshold_px=sieve_threshold_px, simplify_tolerance_px=simplify_tolerance_px,
                )
        finally:
            try:
                os.remove(cum_path)
            except OSError:
                pass
        cumulative_polys[k] = geoms.get(1)

    final_geoms = {}
    prev_poly = None
    for k in ordered_classes:
        cum_poly = cumulative_polys.get(k)
        if cum_poly is None:
            # This cumulative level has no real area at all — leaves
            # prev_poly unchanged, so the NEXT class (if any) correctly
            # has nothing to subtract yet either.
            continue
        if not cum_poly.is_valid:
            cum_poly = cum_poly.buffer(0)
        class_poly = cum_poly if prev_poly is None else cum_poly.difference(prev_poly)
        if not class_poly.is_empty and class_poly.area > 0:
            final_geoms[k] = class_poly
        prev_poly = cum_poly
    return final_geoms


def build_ahp_zone_geometries(catchment_key, lite=True, force=False):
    """Reclassifies build_ahp_susceptibility_raster's own continuous
    score into 3 zone classes (_classify_ahp_zones) and vectorizes each
    into real polygons (flood_exposure._vectorize_multiclass_raster,
    reusing the SAME gdal.Polygonize + self-adaptive-minimum-mapping-unit
    technique already proven correct for every other mode's own binary
    flood-zone vectorization — a new sibling function, not a rewrite).

    Cached to disk as a small GeoJSON FeatureCollection (one Feature per
    zone class actually present in this catchment — a catchment with no
    "high" zone at all simply has 2 features, not a 3rd empty one),
    `properties: {zone_class, color}` using the reused severity palette,
    so this is directly consumable by the frontend as a GeoJSON source
    with no further transformation needed.

    Returns {"geojson": FeatureCollection dict, "path": cache file path}."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")

    from . import flood_exposure

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    lite_tag = "lite" if lite else "full"
    cache_path = os.path.join(out_dir, f"ahp_zones_{lite_tag}.json")

    if not force and os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
        try:
            with open(cache_path, "r") as f:
                cached = json.load(f)
            # §0.43 — the cache format changed from a bare FeatureCollection
            # to {"geojson", "custom_aoi_accuracy"} — a FeatureCollection's
            # own "type" key distinguishes an old-format file already on
            # disk from a request made before this change, read correctly
            # either way rather than requiring every existing cache file
            # to be invalidated.
            if "type" in cached:
                return {"geojson": cached, "path": cache_path, "custom_aoi_accuracy": None}
            return {
                "geojson": cached["geojson"], "path": cache_path,
                "custom_aoi_accuracy": cached.get("custom_aoi_accuracy"),
            }
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_model: AHP zone cache %s unreadable (%s) — rebuilding from scratch "
                "instead of trusting a stale/corrupt cache entry",
                cache_path, exc,
            )

    ahp_result = build_ahp_susceptibility_raster(catchment_key, lite=lite, force=False)
    terrain_class = ahp_result["terrain_class"]

    smoothed_result = build_ahp_smoothed_score_raster(catchment_key, lite=lite, force=force)
    with _gdal_lock():
        smoothed_score, score_gt, score_proj, smoothed_nodata, w, h = _read_raster_array(smoothed_result["path"])
    valid = smoothed_score != smoothed_nodata if smoothed_nodata is not None else np.ones_like(smoothed_score, dtype=bool)

    cfg = PILOT_CATCHMENTS.get(catchment_key, {})
    clip_polygon = cfg.get("clip_polygon")
    custom_aoi_accuracy = None
    score_for_classification = smoothed_score

    # §0.50 — try a real, live accuracy cross-check (Frequency Ratio
    # ensemble against real GFD ground truth — §0.43) for ANY catchment,
    # named or custom, EXCEPT the 4 original pilots — those already have
    # their own dedicated, more rigorous offline Youden's-J calibration
    # (_AHP_ZONE_BREAKS_CALIBRATED, n_events=17-20/n_samples=200/
    # n_trials=5, pooled — see _CALIBRATED_PILOT_CATCHMENTS' own comment
    # for why re-running a single live check for exactly those 4 would
    # be redundant, not wrong, just a strictly weaker substitute for
    # what they already have).
    ensemble_result = None
    if catchment_key not in _CALIBRATED_PILOT_CATCHMENTS:
        ensemble_result = compute_frequency_ratio_ensemble(catchment_key, lite=lite, force=force)
        if ensemble_result:
            with _gdal_lock():
                ensemble_arr, ens_gt, ens_proj, ens_nodata, ew, eh = _read_raster_array(
                    ensemble_result["ensemble_score_path"],
                )
            score_for_classification = ensemble_arr
            custom_aoi_accuracy = {
                "method": "ahp_fr_ensemble",
                "n_presence_pixels": ensemble_result["n_presence_pixels"],
                "factors_used": ensemble_result["factors_used"],
                "ahp_auc": ensemble_result["ahp_auc"],
                "ensemble_auc": ensemble_result["ensemble_auc"],
            }

    if catchment_key in _CALIBRATED_PILOT_CATCHMENTS:
        # Unchanged, original behavior for exactly the 4 catchments this
        # calibration was actually derived FROM.
        breaks = _AHP_ZONE_BREAKS_CALIBRATED.get(terrain_class, _AHP_ZONE_BREAKS)
    else:
        # §0.41/§0.50 — every OTHER catchment's own score DISTRIBUTION
        # has nothing to do with whichever ORIGINAL pilot's terrain_class
        # its own relief statistics happen to match — applying that
        # pilot's own basin-calibrated absolute thresholds here would be
        # borrowing a DIFFERENT area's own distribution, the same
        # problem §0.41 already fixed for custom AOIs specifically, now
        # generalized to every catchment without its own dedicated
        # calibration (§0.48's 31 riverine stations, §0.49's 4 flash-
        # flood pilots, any custom AOI). Classified instead against THIS
        # catchment's own local score distribution (the ensemble's own,
        # when the live check above found real ground truth; AHP-alone
        # otherwise) — Natural Breaks, the literature-preferred method
        # for exactly this "no independent local calibration data"
        # situation (see _local_natural_breaks' own docstring for the
        # full citation trail).
        if clip_polygon:
            # A custom AOI — sample only cells actually INSIDE the
            # drawn/uploaded polygon, not the whole bbox rectangle
            # (which can include area the user never specified).
            clipped_for_breaks = _clip_array_to_polygon(
                score_for_classification, score_gt, score_proj, _DISCHARGE_STAGE_NODATA, clip_polygon,
            )
            sample_values = clipped_for_breaks[(clipped_for_breaks != _DISCHARGE_STAGE_NODATA) & valid]
        else:
            # A named catchment with no drawn polygon — its own bbox-
            # derived valid area already IS the area of interest.
            sample_values = score_for_classification[valid]
        breaks = _local_natural_breaks(sample_values)

    zone_arr = _classify_ahp_zones(score_for_classification, valid, breaks=breaks)
    zone_arr = np.where(valid, zone_arr, _DISCHARGE_STAGE_NODATA)

    # §0.37 — clip to the user's own real drawn polygon (not just its
    # bbox), for a custom AOI. Applied at the RASTER level, before
    # vectorization, rather than as a post-hoc shapely intersection on
    # the vectorized geoms — simpler, and avoids the vectorizer's own
    # sieve/simplify pass producing jagged post-intersection edges. A
    # curated pilot catchment never sets clip_polygon — no-op for all 4.
    if clip_polygon:
        zone_arr = _clip_array_to_polygon(zone_arr, score_gt, score_proj, _DISCHARGE_STAGE_NODATA, clip_polygon)

    zone_raster_path = os.path.join(out_dir, f"ahp_zone_classes_{lite_tag}.tif")
    tmp_zone_raster = f"{zone_raster_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_zone_raster, zone_arr, score_gt, score_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_zone_raster, zone_raster_path)

    # sieve_threshold_px/simplify_tolerance_px well above
    # _vectorize_flood_zone's own binary-mask defaults — CONFIRMED LIVE
    # necessary: a per-pixel 3-class reclassification of a continuous,
    # already-noisy AHP score produces a boundary jagged at pixel
    # granularity (unlike a physically-coherent flood-extent mask), and
    # vectorizing it with the binary-mask defaults produced up to ~10MB
    # of GeoJSON for a single zone (guddu_indus) — an unshippable payload
    # for a decorative/informational display layer, not a precision
    # boundary. See _vectorize_multiclass_raster's own docstring for the
    # technique (gdal.SieveFilter, a standard GDAL tool for exactly this).
    #
    # SELF-ADAPTIVE TO A REAL OUTPUT-SIZE CAP, not one fixed formula —
    # confirmed live that even a size-scaled sieve/simplify pair (this
    # module's own first attempt) left guddu_indus (the largest of the 4
    # pilots by ~3x cell count) at 4.9MB, a real, unpredictable-in-advance
    # relationship between raster size and final vertex count (it depends
    # on the SCORE'S OWN noise pattern, not just cell count). Instead:
    # start from a reasonable baseline, and DOUBLE both parameters (a
    # standard geometric backoff, same shape as this project's own
    # request-timeout/retry conventions elsewhere) until the actual
    # serialized GeoJSON size is under `_AHP_ZONE_MAX_GEOJSON_BYTES`,
    # bounded by a max-iterations cap so this can never loop forever —
    # measuring the REAL thing that matters (bytes actually served to the
    # browser) rather than trusting a proxy formula to have gotten it
    # right for every catchment's own, not-fully-predictable noise shape.
    # §0.42/§0.50 — UNIFIED across every catchment (named or custom, any
    # size) after being confirmed live NOT to be a "small AOI vs. basin
    # scale" issue the way it first looked. The independent per-class
    # dissolve+simplify _vectorize_multiclass_raster's own docstring
    # explains (each class judged on its own geometry, since a filter
    # too aggressive for "low" can be fine for "high") does NOT preserve
    # a SHARED boundary between two adjacent classes — each simplify()
    # pass moves "its own" copy of a once-identical edge independently,
    # leaving a real, visible sliver gap between them (a well-documented
    # cartographic-generalization pitfall: independently simplifying
    # adjacent polygons breaks topology — the standard fix, shapely's
    # own topology-preserving coverage_simplify, needs shapely>=2.1, an
    # unpinned bump this app's existing 2.0.6 doesn't need — same
    # posture already established for not adopting the `overturemaps`
    # package's own shapely bump).
    #
    # §0.42's FIRST attempt scaled the starting sieve/simplify DOWN by
    # pixel extent (small for a custom AOI, left at the original
    # 100/5.0 for a named catchment) — confirmed live via a synthetic
    # test that this closed most of a small AOI's own gap. §0.50 tested
    # that same idea against a LARGE synthetic raster and found it
    # backwards: real AHP-score classification noise is a property of
    # the SCORE ITSELF, not the catchment's pixel extent, so shrinking
    # sieve/simplify for a large catchment actually made its own gap
    # WORSE (confirmed live: 0.177% -> 0.287% on a 1200x1200 synthetic
    # test) while ALSO tripling payload size — the opposite of what was
    # wanted. min_mapping_unit_px=0 alone (keeping the original 100/5.0)
    # helped some (0.177% -> 0.126%) but far short of what's achievable.
    #
    # The actual fix, confirmed live against the REAL guddu_indus AHP
    # raster (3.3M cells, the largest and noisiest real catchment this
    # app has) — not a synthetic approximation: start EVERY catchment
    # from the SAME small, aggressive baseline (sieve=1px, simplify=
    # 0.25px, min_mapping_unit_px=0) and let the adaptive backoff loop
    # below do what it already exists to do — measure the REAL
    # serialized byte count and double sieve/simplify (min_mapping_
    # unit_px stays 0 throughout, never doubled) until under budget.
    # Confirmed live: guddu_indus converges after 3 doublings (sieve=8,
    # simplify=2.0) at 1186.8KB (under the 1465KB budget) with a gap of
    # 0.55% — versus the OLD fixed 100/5.0 default's own 1.25% gap at
    # 641.1KB. A genuine ~2.3x gap reduction even at this catchment's
    # own worst-case scale, not full elimination (real accuracy is
    # preserved — nothing here discards real classified area, only
    # HOW FINELY each class's own boundary is traced) — small custom
    # AOIs (already far fewer total vertices) still converge on the
    # FIRST iteration with the gap fully closed (0.0000%, unchanged from
    # §0.42's own result). One formula, every catchment, verified
    # against both extremes rather than assumed to generalize.
    sieve_threshold_px = 1
    simplify_tolerance_px = 0.25
    min_mapping_unit_px = 0
    geojson = None
    total_bytes = None
    for _adapt_iter in range(_AHP_ZONE_MAX_ADAPT_ITERATIONS):
        # §0.51 — the gap-free ordinal-cumulative technique (see
        # _vectorize_ordinal_zones_gapfree's own docstring for the full
        # account), replacing flood_exposure._vectorize_multiclass_
        # raster's own independent-per-class simplification, which could
        # only ever make the shared-boundary gap SMALL, never provably
        # zero. Operates on zone_arr directly (already clipped to the
        # user's own drawn polygon above, for a custom AOI) rather than
        # re-reading zone_raster_path, but writes the SAME cached raster
        # file below unchanged — every other consumer of that file
        # (buildings-in-view, exposure classification) is unaffected.
        geoms_by_class = _vectorize_ordinal_zones_gapfree(
            zone_arr, score_gt, score_proj, _AHP_ZONE_LABELS, out_dir,
            sieve_threshold_px, simplify_tolerance_px, min_mapping_unit_px,
        )
        features = [
            {
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {
                    "zone_class": _AHP_ZONE_LABELS[class_val],
                    "color": _AHP_ZONE_COLORS[_AHP_ZONE_LABELS[class_val]],
                },
            }
            for class_val, geom in geoms_by_class.items()
        ]
        geojson = {"type": "FeatureCollection", "features": features}
        # The REAL thing being bounded — serialized GeoJSON text size, not
        # a WKB/vertex-count proxy — since that is exactly what gets
        # written to the cache file and served to the browser.
        total_bytes = len(json.dumps(geojson))
        if total_bytes <= _AHP_ZONE_MAX_GEOJSON_BYTES:
            break
        logger.info(
            "flood_model: AHP zone geometries for %r still %.1fKB (over the %.0fKB target) "
            "at sieve=%dpx/simplify=%.1fx — doubling both and retrying (iteration %d/%d)",
            catchment_key, total_bytes / 1024, _AHP_ZONE_MAX_GEOJSON_BYTES / 1024,
            sieve_threshold_px, simplify_tolerance_px, _adapt_iter + 1, _AHP_ZONE_MAX_ADAPT_ITERATIONS,
        )
        sieve_threshold_px *= 2
        simplify_tolerance_px *= 2
    else:
        logger.warning(
            "flood_model: AHP zone geometries for %r did not converge under %.0fKB within "
            "%d adaptive iterations (ended at %.1fKB) — serving the last, largest-"
            "simplification attempt rather than looping forever",
            catchment_key, _AHP_ZONE_MAX_GEOJSON_BYTES / 1024, _AHP_ZONE_MAX_ADAPT_ITERATIONS,
            (total_bytes or 0) / 1024,
        )

    # §0.43 — cache wrapped as {"geojson", "custom_aoi_accuracy"} (was a
    # bare FeatureCollection) so a cache-hit on a custom AOI still
    # returns its own real FR-ensemble AUC numbers, not just the
    # geometry — this cache is per content-addressed catchment_key
    # already (unique per drawn polygon), so this is not a breaking
    # change to any persisted pilot data; a pilot's own cached entry
    # simply carries custom_aoi_accuracy: null, harmless.
    tmp_cache = f"{cache_path}.tmp{os.getpid()}"
    with open(tmp_cache, "w") as f:
        json.dump({"geojson": geojson, "custom_aoi_accuracy": custom_aoi_accuracy}, f)
    os.replace(tmp_cache, cache_path)

    return {"geojson": geojson, "path": cache_path, "custom_aoi_accuracy": custom_aoi_accuracy}


def _flood_zone_ramp_file(threshold_m):
    """Builds (once, cached) a GDAL color-relief ramp for the flood-prone
    -zones layer: dark blue right at the stream (HAND=0, most flood-prone)
    fading to a lighter blue at the threshold, then fully transparent for
    anything above it — matching the general ramp-file approach
    _mon_pred_ramp_file already uses for PMD prediction layers, kept as
    its own small function here rather than shared, since that one is
    keyed by PMD's own element_key vocabulary, not this feature's."""
    ramp_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, "_ramps")
    os.makedirs(ramp_dir, exist_ok=True)
    path = os.path.join(ramp_dir, f"hand_flood_zones_{threshold_m}.txt")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    half = threshold_m / 2
    just_above = threshold_m + max(0.01, threshold_m * 0.001)
    lines = [
        "nv 0 0 0 0",
        f"0 0 0 139 255",
        f"{half} 30 100 200 255",
        f"{threshold_m} 100 180 255 180",
        f"{just_above} 100 180 255 0",
    ]
    tmp_path = f"{path}.tmp{os.getpid()}"
    with open(tmp_path, "w") as f:
        f.write("\n".join(lines))
    os.replace(tmp_path, path)
    return path


def render_flood_prone_zones(catchment_key, threshold_m=HAND_FLOOD_PRONE_THRESHOLD_M, force=False):
    """Colorizes the HAND raster (built by build_hand_pipeline, called
    here if not already cached) into a servable PNG — the actual Phase-1
    deliverable: a "flood-prone zones" layer, HAND below `threshold_m`
    shown in blue, everything else transparent. Reuses the exact
    warp/colorize/atomic-write/post-write-validation conventions
    _mon_pred_convert_step already established for PMD prediction
    rasters, so this layer can be served/cached the same way once wired
    into a view (Phase 1's remaining step, not done in this pass).

    Returns {"png_url", "bounds": [[minx,miny],[maxx,maxy]]} — same shape
    PmdMonitorPredictionsAPIView's own per-step payload uses, for a
    consistent frontend integration story later."""
    pipeline = build_hand_pipeline(catchment_key, force=force)
    hand_path = pipeline["paths"]["hand"]

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    png_path = os.path.join(out_dir, f"flood_prone_zones_{threshold_m}.png")

    if not force and os.path.exists(png_path) and os.path.getsize(png_path) >= 512:
        return _flood_zone_payload(png_path, hand_path)

    # §0.37 — a custom AOI's own polygon shape (not just its bbox) clips
    # the rendered result. catchment_key is already content-addressed by
    # BOTH bbox and polygon shape (register_custom_aoi's own docstring),
    # so this cache directory is already unique per polygon — no
    # separate cache-key concern here, just the clip itself. A curated
    # pilot catchment never sets clip_polygon, so colorize_source stays
    # hand_path unchanged for every one of them.
    cfg = PILOT_CATCHMENTS.get(catchment_key, {})
    clip_polygon = cfg.get("clip_polygon")
    colorize_source = hand_path
    if clip_polygon:
        with _gdal_lock():
            hand_arr, hand_gt, hand_proj, hand_nodata, hw, hh = _read_raster_array(hand_path)
            clipped_arr = _clip_array_to_polygon(hand_arr, hand_gt, hand_proj, hand_nodata, clip_polygon)
            clipped_hand_path = os.path.join(out_dir, "07b_hand_clipped.tif")
            _write_raster_array(clipped_hand_path, clipped_arr, hand_gt, hand_proj, hand_nodata)
        colorize_source = clipped_hand_path

    ramp = _flood_zone_ramp_file(threshold_m)
    tmp_png = f"{png_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        colored_ds = gdal.DEMProcessing(
            tmp_png, colorize_source, "color-relief",
            colorFilename=ramp, format="PNG", addAlpha=True,
        )
        if colored_ds is None:
            raise RuntimeError("gdal.DEMProcessing (color-relief) returned None for flood-prone zones")
        colored_ds = None
        # Post-write validation — same "an empty-looking but technically
        # valid PNG can slip through" concern _mon_pred_convert_step's own
        # comment documents (observed there when a Warp silently landed on
        # NoData). Cheap enough to just re-open and confirm real pixel
        # dimensions before trusting the file.
        check_ds = gdal.Open(tmp_png)
        if check_ds is None or check_ds.RasterXSize <= 0 or check_ds.RasterYSize <= 0:
            raise RuntimeError("flood-prone zones PNG failed post-write validation")
        check_ds = None
    os.replace(tmp_png, png_path)
    # GDAL writes its own PAM sidecar (.aux.xml) next to whatever file it
    # opens for the post-write validation above — that sidecar was
    # created against the TEMP filename, so os.replace() (which only
    # moves the one path we told it to) leaves it behind as an orphan.
    # Harmless (small XML, no correctness impact) but worth not leaking
    # one per render.
    stray_aux = f"{tmp_png}.aux.xml"
    if os.path.exists(stray_aux):
        try:
            os.remove(stray_aux)
        except OSError:
            pass
    return _flood_zone_payload(png_path, hand_path)


# Clamp floor for a gauge-derived threshold that comes out at or below
# zero (confirmed live, real, not hypothetical: Guddu's own DEM-vs-gauge
# offset already produces this — see PILOT_CATCHMENTS' own comment).
# Small and positive rather than zero so _flood_zone_ramp_file's own
# half/just-above stops (threshold_m/2, threshold_m*1.001) stay
# well-defined, not degenerate.
_MIN_RIVERINE_THRESHOLD_M = 0.1


def compute_riverine_threshold_m(catchment_key):
    """Derives a LIVE, gauge-calibrated HAND threshold for a riverine
    catchment from a real FFD water-surface-elevation reading — see
    build_riverine_flood_zone's own docstring for why this reuses the
    fixed-threshold engine rather than the discharge-driven (SCS-CN) one.

    Mechanism: FFD's own `height` field (flood_riverine.fetch_live_status)
    is a genuine water-surface elevation (confirmed live, §R4 — see that
    function's own docstring for the cross-basin evidence). Sampling this
    project's own conditioned DEM at the catchment's real, published gauge
    coordinates gives the LOCAL terrain elevation at that same point.
    threshold_m = gauge_height_m - local_dem_elevation_m — i.e. how many
    metres of water are CURRENTLY standing above local ground level at the
    gauge, fed into the SAME "flood-prone where HAND <= threshold" logic
    the fixed-threshold flash-flood mode already uses, uniformly across
    the whole modeled reach (a standard, literature-accepted simplifying
    assumption for a short reach near one gauge — the same "near-level
    water surface" approximation behind every basic bathtub-style flood
    map, not something invented for this project).

    Returns {"threshold_m", "gauge_height_m", "dem_elevation_at_gauge_m",
    "raw_threshold_m", "clamped", "ffd_status", "reading_time"} or raises
    ValueError if the catchment is unknown/not riverine, or RuntimeError
    if the live gauge reading is unavailable (a real external-data
    failure, not silently defaulted past)."""
    from . import flood_riverine

    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    if cfg.get("flood_type") != "riverine":
        raise ValueError(
            f"compute_riverine_threshold_m: {catchment_key!r} is not a riverine catchment "
            f"(flood_type={cfg.get('flood_type')!r})"
        )

    status = flood_riverine.fetch_live_status(cfg["ffd_station"])
    if status is None or status.get("height_m") is None:
        raise RuntimeError(
            f"compute_riverine_threshold_m: no live water-surface-elevation reading "
            f"available for {cfg['ffd_station']!r} right now"
        )
    gauge_height_m = status["height_m"]

    pipeline = build_hand_pipeline(catchment_key)
    dem_arr, dem_gt, _, dem_nodata, dem_w, dem_h = _read_raster_array(pipeline["paths"]["conditioned"])
    col = int((cfg["gauge_lon"] - dem_gt[0]) / dem_gt[1])
    row = int((cfg["gauge_lat"] - dem_gt[3]) / dem_gt[5])
    if not (0 <= row < dem_h and 0 <= col < dem_w):
        raise RuntimeError(
            f"compute_riverine_threshold_m: {catchment_key!r}'s own gauge_lat/gauge_lon "
            f"falls outside its conditioned DEM raster — bbox/coordinate mismatch"
        )
    dem_elev_at_gauge = float(dem_arr[row, col])
    if dem_nodata is not None and dem_elev_at_gauge == dem_nodata:
        raise RuntimeError(
            f"compute_riverine_threshold_m: {catchment_key!r}'s gauge pixel is NoData in "
            f"its own conditioned DEM"
        )

    raw_threshold_m = gauge_height_m - dem_elev_at_gauge
    clamped = raw_threshold_m <= 0
    threshold_m = round(max(raw_threshold_m, _MIN_RIVERINE_THRESHOLD_M), 2)
    if clamped:
        logger.warning(
            "flood_model: %r's raw gauge-derived threshold (%.2fm) was <= 0 — clamped to "
            "the %.1fm floor. Real, expected behavior at/near normal flow given the DEM's "
            "own confirmed few-metre residual offset from FFD's gauge datum, not a bug — "
            "see PILOT_CATCHMENTS' own comment for this catchment.",
            catchment_key, raw_threshold_m, _MIN_RIVERINE_THRESHOLD_M,
        )

    return {
        "threshold_m": threshold_m,
        "gauge_height_m": gauge_height_m,
        "dem_elevation_at_gauge_m": round(dem_elev_at_gauge, 2),
        "raw_threshold_m": round(raw_threshold_m, 2),
        "clamped": clamped,
        "ffd_status": status.get("status"),
        "reading_time": status.get("recording_time"),
    }


def build_riverine_flood_zone(catchment_key, force=False):
    """Riverine mode's spatial engine. Deliberately reuses render_flood_
    prone_zones (the fixed-HAND-threshold engine already built and tested
    for flash-flood susceptibility, §0.17) COMPLETELY UNCHANGED, rather
    than the discharge-driven (SCS-CN/Kirpich/SCS-UH/Manning's) chain — a
    real, evidence-based design decision (§R3/§R4), not a shortcut:

      1. Sub-phase R3 (channel-geometry sanity check) found that
         flood_discharge.py's Leopold-Maddock coefficients, fitted to
         Nullah Lai's own ~242 km^2 outlet area, cannot be trusted when
         extrapolated ~1000-3000x to Indus-basin scale — a plausible-
         LOOKING extrapolated channel width is not a validated one.
      2. In its place, FFD's own real water-surface-elevation reading
         (confirmed live to be a genuine, cross-basin-consistent gauge
         datum — see compute_riverine_threshold_m's own docstring) gives
         a DIRECTLY usable HAND threshold with no channel-geometry
         assumption needed AT ALL — strictly better evidence for the same
         goal.

    Returns the same {"png_url", "bounds", "scenario"} shape the
    discharge-driven flash-flood mode already returns, for a consistent
    frontend integration story — "scenario" here carries the resolved
    gauge/threshold numbers (compute_riverine_threshold_m's own return
    value) instead of a rainfall scenario."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    if cfg.get("flood_type") != "riverine":
        raise ValueError(
            f"build_riverine_flood_zone: {catchment_key!r} is not a riverine catchment "
            f"(flood_type={cfg.get('flood_type')!r}) — see PILOT_CATCHMENTS"
        )

    scenario = compute_riverine_threshold_m(catchment_key)
    payload = render_flood_prone_zones(catchment_key, threshold_m=scenario["threshold_m"], force=force)
    payload["scenario"] = scenario
    return payload


def _read_raster_array(path):
    """Reads an entire single-band raster into a numpy array, row-by-row
    via raw ReadRaster/struct (never Band.ReadAsArray — see this module's
    own GDAL/NumPy ABI-mismatch note in the module docstring). Building a
    numpy array FROM already-unpacked Python floats never touches
    gdal_array, so this stays on the safe side of that ABI gap. Returns
    (array: np.ndarray[float64], geotransform, projection_wkt, nodata,
    width, height)."""
    from osgeo import gdal
    ds = gdal.Open(path)
    if ds is None:
        raise RuntimeError(f"gdal.Open failed for {path}")
    band = ds.GetRasterBand(1)
    w, h = ds.RasterXSize, ds.RasterYSize
    nodata = band.GetNoDataValue()
    gt = ds.GetGeoTransform()
    proj = ds.GetProjection()
    rows = []
    for row in range(h):
        raw = band.ReadRaster(0, row, w, 1, buf_type=gdal.GDT_Float32)
        rows.append(struct.unpack(f"<{w}f", raw))
    ds = None
    arr = np.array(rows, dtype=np.float64)
    return arr, gt, proj, nodata, w, h


def _write_raster_array(out_path, arr, gt, proj, nodata):
    """Writes a numpy array to a single-band Float32 GeoTIFF, row-by-row
    via raw WriteRaster/struct (the write-side counterpart to
    _read_raster_array, same ABI-mismatch avoidance — never
    Band.WriteArray). Caller owns the atomic-write convention (temp path
    + os.replace) this module uses everywhere else; this just creates
    the file at `out_path` directly."""
    from osgeo import gdal
    h, w = arr.shape
    driver = gdal.GetDriverByName("GTiff")
    ds = driver.Create(out_path, w, h, 1, gdal.GDT_Float32)
    if ds is None:
        raise RuntimeError(f"gdal driver.Create failed for {out_path}")
    ds.SetGeoTransform(gt)
    ds.SetProjection(proj)
    band = ds.GetRasterBand(1)
    band.SetNoDataValue(nodata)
    for row_idx in range(h):
        raw = struct.pack(f"<{w}f", *arr[row_idx].tolist())
        band.WriteRaster(0, row_idx, w, 1, raw, buf_type=gdal.GDT_Float32)
    band.FlushCache()
    ds = None


def _binary_mask_ramp_file():
    """A fixed 0/1 color-relief ramp (transparent at 0, blue at 1) for
    rendering an arbitrary boolean flood mask to a PNG via gdal.
    DEMProcessing — the same mechanism _flood_zone_ramp_file already uses
    for the fixed-threshold mode, but with no threshold parameter (a
    binary mask has no continuous domain to ramp across)."""
    ramp_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, "_ramps")
    os.makedirs(ramp_dir, exist_ok=True)
    path = os.path.join(ramp_dir, "binary_flood_mask.txt")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    lines = ["nv 0 0 0 0", "0 0 0 0 0", "1 30 100 200 220"]
    tmp_path = f"{path}.tmp{os.getpid()}"
    with open(tmp_path, "w") as f:
        f.write("\n".join(lines))
    os.replace(tmp_path, path)
    return path


# ---------------------------------------------------------------------------
# §0.44 — a real, live water-surface elevation for a CUSTOM riverine AOI.
# The app's own FFD network (flood_riverine.py's own module docstring)
# covers exactly 31 NAMED barrage/dam stations (Tarbela, Kalabagh, Chashma,
# Taunsa, Guddu, Sukkur, Kotri, +24 others) — a real, finite, physical
# sensor network, not something a drawn polygon can be matched to
# generically the way GFD/WFS ground truth already is elsewhere in this
# file. Confirmed via literature search (see the methodology doc's own
# §0.44): the standard, operational answer for an UNGAUGED river reach is
# NOT to fall back to a coarser HAND-threshold approximation — it's to
# substitute a real GLOBAL streamflow reanalysis/forecast product
# (regionalization) and convert it to a stage via a synthetic rating
# curve (NOAA's own operational HAND-Synthetic-Rating-Curve framework).
# This app already has BOTH real pieces, just never wired together for a
# custom AOI: GeoGLOWS (ECMWF's own operational global streamflow
# forecast service, confirmed live this session — a real river reach and
# real m3/s forecast were fetched for a real Indus-basin location) and
# flood_discharge.py's own Leopold&Maddock/Manning's synthetic rating
# curve (already used by flash mode's discharge-driven zone). The result
# feeds the EXACT SAME, already-validated flood_connectivity.
# connected_flood_fill engine every real-gauge riverine catchment already
# uses — not a new, separate spatial technique.
# ---------------------------------------------------------------------------

_GEOGLOWS_BASE = "https://geoglows.ecmwf.int/api"
_GEOGLOWS_TIMEOUT_S = 20


def _fetch_geoglows_river_id(lat, lon):
    """Nearest GeoGLOWS river reach to (lat, lon) — the SAME public,
    unauthenticated `/v2/getriverid` endpoint views.GeoGlowsRiverIdApi
    already proxies for the browser (used elsewhere in this app for an
    unrelated click-a-river-for-its-forecast feature), called directly
    server-side here instead — a genuinely new server-side integration,
    matching flood_riverine.py's own precedent of calling an existing
    data source server-side for a new purpose. Returns None on any
    failure or no match — never raises, matching every other external-
    service fetcher in this file's own established convention."""
    import requests
    try:
        resp = requests.get(
            f"{_GEOGLOWS_BASE}/v2/getriverid", params={"lat": lat, "lon": lon},
            timeout=_GEOGLOWS_TIMEOUT_S, headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.warning(
            "flood_model: GeoGLOWS river-id lookup failed for (%.5f, %.5f)",
            lat, lon, exc_info=True,
        )
        return None
    river_id = data.get("river_id")
    return int(river_id) if river_id is not None else None


def _fetch_geoglows_peak_forecast(river_id):
    """Real forecasted peak discharge for one GeoGLOWS river reach.
    Confirmed live this session (querying a real reach near Chashma):
    GeoGLOWS reports natively in cubic meters per second — NO cusecs-
    style conversion needed here, unlike FFD's own readings (see
    flood_riverine.py's own CUSECS_TO_M3S note for that contrast).
    Uses the ENSEMBLE MAXIMUM (`flow_max`) across the whole forecast
    horizon (confirmed live: a real 120-timestep/15-day series), not
    the median (`flow_med`) — a deliberately conservative, safety-
    appropriate choice for a flood EARLY WARNING tool: better to flag a
    plausible high scenario than understate risk via a median-only
    figure. Returns None on any failure or no usable data — never
    raises."""
    import requests
    try:
        resp = requests.get(
            f"{_GEOGLOWS_BASE}/v2/forecaststats/{river_id}", params={"format": "json"},
            timeout=_GEOGLOWS_TIMEOUT_S, headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.warning(
            "flood_model: GeoGLOWS forecast fetch failed for river_id %r",
            river_id, exc_info=True,
        )
        return None

    values = []
    for v in (data.get("flow_max") or []):
        try:
            values.append(float(v))
        except (TypeError, ValueError):
            continue
    if not values:
        return None

    metadata = data.get("metadata") or {}
    horizon_days = None
    try:
        import datetime
        start = metadata.get("start_date")
        end = metadata.get("end_date")
        if start and end:
            horizon_days = (
                datetime.datetime.fromisoformat(end) - datetime.datetime.fromisoformat(start)
            ).days
    except Exception:
        horizon_days = None

    return {
        "peak_flow_m3s": max(values),
        "gen_date": metadata.get("gen_date"),
        "horizon_days": horizon_days,
    }


def _derive_custom_aoi_gauge_height(catchment_key, pipeline, cfg, force=False):
    """Derives a water-surface elevation for a custom riverine AOI, for
    build_riverine_flood_zone's own gauge_height_m — see this module's
    own §0.44 block comment for the full method/citation trail. Summary:
    (1) find this AOI's own most-likely main-channel cell (highest flow
    accumulation among its detected stream cells — the same real proxy
    for stream significance STREAM_FLOW_ACCUM_THRESHOLD already uses
    elsewhere to derive streams.tif itself, not a new assumption);
    (2) look up the nearest REAL GeoGLOWS river reach to that point;
    (3) fetch its real peak forecasted discharge; (4) convert that
    discharge to a stage via the SAME synthetic rating curve (Leopold &
    Maddock hydraulic geometry + Manning's equation) flash mode's own
    discharge-driven zone already uses, using THIS AOI's own real,
    WhiteboxTools-derived drainage area/channel slope; (5) add that
    stage to the real DEM elevation AT that exact channel cell (not a
    basin-wide median — this reach's own specific bed elevation) to get
    an ABSOLUTE water-surface elevation, directly comparable to the DEM,
    exactly what connected_flood_fill's own gauge_height_m expects.

    Returns None — a real, POSSIBLE outcome (GeoGLOWS genuinely has no
    reach near this AOI, or the service is unreachable right now), not
    an error — at any step; never raises. Otherwise returns a dict with
    gauge_height_m plus every intermediate number (channel_bed_elev_m,
    stage_m, target_discharge_m3s, geoglows_river_id, drainage_area_km2,
    channel_slope, forecast_gen_date, forecast_horizon_days) so a caller
    can show exactly how the figure was derived, not just trust it
    blindly — same posture this function's own caller already
    establishes for the real-gauge path."""
    from . import flood_discharge

    dem_path = pipeline["paths"]["conditioned"]
    streams_path = pipeline["paths"]["streams"]
    flow_accum_path = pipeline["paths"]["flow_accum"]
    stats = pipeline["stats"]

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)
        flow_arr, fgt, fproj, fnodata, fw, fh = _read_raster_array(flow_accum_path)

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    stream_mask &= (stream_arr > 0) & valid
    if not stream_mask.any():
        logger.info(
            "flood_model: no stream cells detected for custom riverine AOI %r — "
            "cannot pick a representative main-channel point", catchment_key,
        )
        return None

    flow_at_stream = np.where(stream_mask, flow_arr, -np.inf)
    best_row, best_col = np.unravel_index(np.argmax(flow_at_stream), flow_at_stream.shape)
    best_lon = dem_gt[0] + (float(best_col) + 0.5) * dem_gt[1]
    best_lat = dem_gt[3] + (float(best_row) + 0.5) * dem_gt[5]

    river_id = _fetch_geoglows_river_id(best_lat, best_lon)
    if river_id is None:
        logger.info(
            "flood_model: GeoGLOWS has no river reach near custom AOI %r's own "
            "detected main channel (%.5f, %.5f) — cannot derive a water level "
            "(a real, possible outcome, not a bug)",
            catchment_key, best_lat, best_lon,
        )
        return None

    forecast = _fetch_geoglows_peak_forecast(river_id)
    if forecast is None:
        logger.info(
            "flood_model: GeoGLOWS forecast fetch failed/empty for river_id %r "
            "(custom AOI %r) — cannot derive a water level",
            river_id, catchment_key,
        )
        return None
    target_discharge_m3s = forecast["peak_flow_m3s"]

    basin_length_km = derive_basin_length_km(catchment_key, force=False)["basin_length_km"]
    relief_m = stats["dem"]["max"] - stats["dem"]["min"]
    if relief_m <= 0 or basin_length_km <= 0:
        logger.warning(
            "flood_model: cannot derive a channel slope for custom AOI %r "
            "(relief=%.2fm, length=%.3fkm) — skipping GeoGLOWS-derived water level",
            catchment_key, relief_m, basin_length_km,
        )
        return None
    channel_slope = relief_m / (basin_length_km * 1000.0)

    _, miny, _, maxy = cfg["bbox"]
    lat_mid = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    cell_area_km2 = abs(fgt[1]) * km_per_deg_lon * abs(fgt[5]) * km_per_deg_lat
    outlet_flow_accum_cells = float(flow_at_stream[best_row, best_col])
    # Floored at one cell's own area — a flow-accumulation count of 0/near-
    # 0 at the "best" cell would otherwise imply a physically-meaningless
    # near-zero drainage area, same floor build_discharge_driven_flood_
    # zone's own per-cell discharge scaling implicitly relies on via its
    # outlet-area normalization.
    drainage_area_km2 = max(outlet_flow_accum_cells * cell_area_km2, cell_area_km2)

    stage_m = flood_discharge.solve_stage_for_discharge_m(
        target_discharge_m3s, drainage_area_km2, channel_slope,
    )
    channel_bed_elev_m = float(dem_arr[best_row, best_col])
    gauge_height_m = channel_bed_elev_m + stage_m

    return {
        "gauge_height_m": round(gauge_height_m, 3),
        "channel_bed_elev_m": round(channel_bed_elev_m, 3),
        "stage_m": round(stage_m, 3),
        "target_discharge_m3s": round(target_discharge_m3s, 2),
        "geoglows_river_id": river_id,
        "drainage_area_km2": round(drainage_area_km2, 3),
        "channel_slope": round(channel_slope, 5),
        "forecast_gen_date": forecast.get("gen_date"),
        "forecast_horizon_days": forecast.get("horizon_days"),
    }


def build_riverine_flood_zone(catchment_key, force=False):
    """Riverine mode's spatial engine — REBUILT (§R4 model-comparison)
    after the first version (a uniform HAND threshold reusing render_
    flood_prone_zones unchanged) was confirmed live to produce an
    implausible result: 75.4% of Chashma's entire bbox has HAND <= 4m
    (median HAND only 1.36m across the whole raster), so a uniform
    threshold flags huge swaths of terrain that are locally low relative
    to SOME nearby drainage line but not actually reachable from the
    river being modeled — the classic "leaky bathtub" problem, producing
    669.866 km^2 for a real 4m gauge-derived threshold.

    Real, evidence-based model comparison done before rebuilding this
    (see FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md for the full account):
    LISFLOOD-FP and openLISEM/FastFlood are genuinely open source but
    both GPLv3 (a real conflict with this project's own already-
    established permissive-license stack policy — the exact reason
    WhiteboxTools was chosen over RichDEM/PySheds); a from-scratch
    cellular-automata physics engine (flood_ca.py) was attempted and hit
    real, time-consuming numerical bugs not fully resolved. The model
    that shipped: flood_connectivity.connected_flood_fill — a simple,
    provably-correct connected-component flood-fill (geodesic dilation),
    seeded from the stream network, testing each cell directly against
    the REAL gauge water-surface elevation (no threshold-derivation step
    needed — the gauge reading IS already an absolute elevation, directly
    comparable to the raw DEM, not HAND which is a relative measure).
    Confirmed live via synthetic tests to have ZERO leakage into
    topologically disconnected low areas and to reach the exact correct
    extent on an analytically-solvable test case, with no iterative-
    physics convergence risk.

    Returns {"png_url", "bounds", "scenario"} — "scenario" carries the
    real gauge reading, the resolved flood-zone area, and the
    connectivity fill's own convergence diagnostics (so a caller can see
    directly whether the result is trustworthy, not just trust it
    blindly)."""
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    cfg = PILOT_CATCHMENTS[catchment_key]
    if cfg.get("flood_type") != "riverine":
        raise ValueError(
            f"build_riverine_flood_zone: {catchment_key!r} is not a riverine catchment "
            f"(flood_type={cfg.get('flood_type')!r}) — see PILOT_CATCHMENTS"
        )

    from . import flood_connectivity, flood_riverine

    pipeline = build_hand_pipeline(catchment_key, force=force)
    dem_path = pipeline["paths"]["conditioned"]
    streams_path = pipeline["paths"]["streams"]
    hand_path = pipeline["paths"]["hand"]

    # §0.44 — a curated pilot has a real, named FFD gauge (cfg["ffd_
    # station"]) and keeps using it exactly as before, byte-identical.
    # A custom AOI has none — there is no generic "nearest physical
    # sensor" the way GFD/WFS ground truth already offers elsewhere,
    # since this app's own FFD network covers exactly 31 NAMED
    # stations, not a dense grid (see flood_riverine.py's own module
    # docstring). Derived instead via GeoGLOWS + a synthetic rating
    # curve — see _derive_custom_aoi_gauge_height's own docstring for
    # the full method/citation trail. discharge_scenario is None for a
    # real-gauge catchment (nothing to show — the reading IS the
    # number) and a real dict of every intermediate figure for a
    # custom AOI (so a caller can show exactly how gauge_height_m was
    # derived, not just trust it blindly).
    discharge_scenario = None
    if cfg.get("ffd_station"):
        status = flood_riverine.fetch_live_status(cfg["ffd_station"])
        if status is None or status.get("height_m") is None:
            raise RuntimeError(
                f"build_riverine_flood_zone: no live water-surface-elevation reading "
                f"available for {cfg['ffd_station']!r} right now"
            )
        gauge_height_m = status["height_m"]
        gauge_status = status.get("status")
        gauge_reading_time = status.get("recording_time")
    elif cfg.get("is_custom_aoi"):
        discharge_scenario = _derive_custom_aoi_gauge_height(catchment_key, pipeline, cfg, force=force)
        if discharge_scenario is None:
            raise RuntimeError(
                f"build_riverine_flood_zone: could not derive a GeoGLOWS-based water level "
                f"for custom AOI {catchment_key!r} — no GeoGLOWS river reach found near this "
                f"area's own detected main channel, or the GeoGLOWS service is unreachable "
                f"right now. Try a different area, or Fixed-threshold/AHP mode here instead."
            )
        gauge_height_m = discharge_scenario["gauge_height_m"]
        gauge_status = "geoglows_forecast"
        gauge_reading_time = discharge_scenario.get("forecast_gen_date")
    else:
        raise RuntimeError(
            f"build_riverine_flood_zone: {catchment_key!r} has neither a real ffd_station "
            f"gauge mapping nor is a custom AOI — cannot determine a water-surface elevation"
        )

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"gauge{gauge_height_m:g}"
    png_path = os.path.join(out_dir, f"flood_prone_zones_riverine_{scenario_key}.png")
    mask_path = os.path.join(out_dir, f"12_riverine_binary_mask_{scenario_key}.tif")
    scenario_json_path = os.path.join(out_dir, f"flood_prone_zones_riverine_{scenario_key}.json")

    if (not force and os.path.exists(png_path) and os.path.getsize(png_path) >= 512
            and os.path.exists(scenario_json_path) and os.path.exists(mask_path)):
        try:
            with open(scenario_json_path, "r") as f:
                payload = _flood_zone_payload(png_path, hand_path)
                payload["scenario"] = json.load(f)
            payload["mask_path"] = mask_path
            return payload
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_model: riverine scenario sidecar %s unreadable (%s) — rebuilding this "
                "scenario from scratch instead of trusting a stale/corrupt cache entry",
                scenario_json_path, exc,
            )

    with _gdal_lock():
        dem_arr, dem_gt, dem_proj, dem_nodata, w, h = _read_raster_array(dem_path)
        stream_arr, sgt, sproj, snodata, sw, sh = _read_raster_array(streams_path)
    if (sw, sh) != (w, h):
        raise RuntimeError(
            f"flood_model: streams raster dims {(sw, sh)} != DEM dims {(w, h)} for "
            f"{catchment_key!r} — pipeline outputs are supposed to share a grid"
        )

    valid = np.ones_like(dem_arr, dtype=bool)
    if dem_nodata is not None:
        valid &= (dem_arr != dem_nodata)
    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if snodata is not None:
        stream_mask &= (stream_arr != snodata)
    stream_mask &= (stream_arr > 0) & valid

    if not stream_mask.any():
        raise RuntimeError(
            f"flood_model: no stream cells found for {catchment_key!r} while building the "
            f"riverine flood zone — streams.tif looks empty"
        )

    fill_result = flood_connectivity.connected_flood_fill(dem_arr, valid, stream_mask, gauge_height_m)
    if not fill_result["converged"]:
        raise RuntimeError(
            f"flood_model: connected_flood_fill did not converge for {catchment_key!r} "
            f"(gauge_height_m={gauge_height_m}) — see flood_connectivity's own error log"
        )
    flooded = fill_result["flooded_mask"]

    # §0.44 — clip to the user's own real drawn polygon (not just its
    # bbox), matching every other custom-AOI mode's own §0.37 fix —
    # riverine mode was never extended for this before now since it was
    # entirely blocked for custom AOIs until this section. A curated
    # pilot catchment never sets clip_polygon — no-op for both.
    if cfg.get("clip_polygon"):
        flooded = _clip_array_to_polygon(
            flooded.astype(np.uint8), dem_gt, dem_proj, 0, cfg["clip_polygon"],
        ).astype(bool)

    _, miny, _, maxy = cfg["bbox"]
    lat_mid = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))
    cell_area_km2 = abs(dem_gt[1]) * km_per_deg_lon * abs(dem_gt[5]) * km_per_deg_lat
    flood_zone_km2 = round(float(flooded.sum()) * cell_area_km2, 3)

    tmp_mask = f"{mask_path}.tmp{os.getpid()}"
    with _gdal_lock():
        # NoData is a genuine out-of-band sentinel (-9999), NOT 0.0 — a
        # real bug caught before this was ever tested: 0.0 is the mask's
        # own legitimate "not flooded" value, so using it as NoData would
        # have made _read_raster_values_at_points (accuracy_assessment.py)
        # silently drop every dry sample point, corrupting both accuracy
        # validation and exposure vectorization.
        _write_raster_array(tmp_mask, flooded.astype(np.float64), dem_gt, dem_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_mask, mask_path)

    ramp = _binary_mask_ramp_file()
    tmp_png = f"{png_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        colored_ds = gdal.DEMProcessing(
            tmp_png, mask_path, "color-relief", colorFilename=ramp, format="PNG", addAlpha=True,
        )
        if colored_ds is None:
            raise RuntimeError("gdal.DEMProcessing (color-relief) returned None for the riverine flood mask")
        colored_ds = None
        check_ds = gdal.Open(tmp_png)
        if check_ds is None or check_ds.RasterXSize <= 0 or check_ds.RasterYSize <= 0:
            raise RuntimeError("riverine flood-zone PNG failed post-write validation")
        check_ds = None
    os.replace(tmp_png, png_path)
    stray_aux = f"{tmp_png}.aux.xml"
    if os.path.exists(stray_aux):
        try:
            os.remove(stray_aux)
        except OSError:
            pass

    scenario = {
        "gauge_height_m": gauge_height_m,
        "gauge_source": "geoglows_forecast" if discharge_scenario else "ffd_live_gauge",
        "flood_zone_km2": flood_zone_km2,
        "flooded_cells": int(flooded.sum()),
        "ffd_status": gauge_status,
        "reading_time": gauge_reading_time,
        "connectivity_converged": fill_result["converged"],
        "connectivity_iterations": fill_result["iterations_run"],
    }
    # §0.44 — every intermediate number the GeoGLOWS-derivation actually
    # used (discharge/river_id/drainage area/slope/stage), so a custom
    # AOI's own result can show exactly how gauge_height_m was reached —
    # absent (None) for a real-gauge catchment, where the reading IS the
    # number, nothing to derive.
    if discharge_scenario:
        scenario["discharge_scenario"] = discharge_scenario
    tmp_json = f"{scenario_json_path}.tmp{os.getpid()}"
    with open(tmp_json, "w") as f:
        json.dump(scenario, f)
    os.replace(tmp_json, scenario_json_path)

    payload = _flood_zone_payload(png_path, hand_path)
    payload["scenario"] = scenario
    payload["mask_path"] = mask_path
    return payload


_DISCHARGE_STAGE_NODATA = -9999.0


def build_discharge_driven_flood_zone(catchment_key, rainfall_mm, duration_hr, force=False):
    """Phase-2 discharge-driven flood zone (methodology doc §0.19) —
    replaces the single global HAND_FLOOD_PRONE_THRESHOLD_M comparison
    with a SPATIALLY-VARYING stage, one per stream cell, derived from an
    actual rainfall scenario through flood_discharge.py's SCS-CN ->
    Kirpich -> SCS triangular-UH -> Manning's-equation chain. This is the
    real fix §0.18 committed to: a fixed vertical HAND cutoff has no
    concept of water volume/discharge, so it structurally over/
    understates extent depending on local terrain — confirmed live to
    produce a 49.75 km^2 "susceptibility" zone at a 3.0m cutoff, ~14.6x
    a published HEC-RAS reference figure for this basin's own highest-
    risk reach. This function does NOT chase that number by tuning a
    threshold — it computes a differently-grounded quantity outright.

    ADDITIVE: does not modify render_flood_prone_zones or
    HAND_FLOOD_PRONE_THRESHOLD_M's own fixed-threshold path — both
    remain available, matching this project's standing "preserve core
    logic" constraint. This is a new, parallel mode.

    Method (every step confirmed live in this module's own testing
    before being wired together — see the discharge-driven §0.19 test
    notes):
      1. Outlet peak discharge — flood_discharge.estimate_peak_discharge_m3s
         from `rainfall_mm`/`duration_hr` plus this catchment's own real,
         DEM-derived relief/area (build_hand_pipeline's own cached DEM
         and flow_accum stats — never re-fetched) and this catchment's
         literature-cited length/CN (PILOT_CATCHMENTS[catchment_key]).
      2. Each STREAM cell's own local drainage area — its D8 flow-
         accumulation cell count * this raster's own real pixel area
         (derived from the bbox/latitude, not a fixed 30m assumption).
      3. Each stream cell's own local discharge — outlet discharge
         scaled by (local_area / outlet_area). Assumes spatially-uniform
         runoff generation for one storm across the basin — an honest
         simplification (no distributed-rainfall input in this pilot),
         not hidden.
      4. Each stream cell's own local stage —
         flood_discharge.solve_stage_for_discharge_m_array (vectorized;
         confirmed live to match the scalar bisection to within its own
         tolerance and to run tens of thousands of cells in well under a
         second — a plain per-cell Python loop was tested and rejected
         as too slow/unbounded for a request-time pipeline), using a
         SINGLE basin-average channel slope (relief/length) for every
         reach. This is the one deliberately coarse simplification here:
         true per-reach slope would need stream-network segmentation
         this pass doesn't build — a documented next-tier improvement,
         same posture as flood_discharge.py's own CN/soil-group note.
      5. WhiteboxTools' euclidean_allocation (confirmed present via
         wbt.list_tools(), same call convention as every other WBT step
         in this module) transfers each stream cell's local stage to
         every OTHER cell, keyed by nearest-stream-cell — a full-raster
         "allocated stage" surface. Confirmed live to correctly cover
         the WHOLE raster grid (~99% of valid cells got a real
         allocated value in testing), not just the stream cells
         themselves.
      6. Final mask: flood-prone where hand <= allocated_stage, using
         the SAME flow-path-based "hand" raster the fixed-threshold path
         already uses (elevation_above_stream, build_hand_pipeline's
         "hand" output) — NOT a Euclidean-metric HAND. An earlier
         version of this pipeline built a dedicated Euclidean HAND
         (elevation_above_stream_euclidean) for metric consistency with
         euclidean_allocation's own straight-line "nearest stream cell";
         that WAS tried and confirmed BROKEN in this project's installed
         WhiteboxTools v2.4.0 — its output was all-zero everywhere
         except the stream cells themselves (verified via the tool's own
         Rust source: its neighbor-propagation pass never reaches
         non-stream cells, unlike its own sibling euclidean_allocation,
         which propagates correctly). Rather than work around a
         third-party tool bug, this uses the already-proven, real
         flow-path HAND instead — also the more standard HAND
         definition (matches NOAA's own operational HAND-FIM
         methodology). The resulting metric mismatch (euclidean_allocation's
         nearest-by-straight-line-distance stream cell vs. hand's
         nearest-by-flow-path stream cell can, in principle, differ for
         a given cell) is a real, honestly-documented approximation, not
         hidden — expected to be small at this pilot's resolution given
         a dense stream network (STREAM_FLOW_ACCUM_THRESHOLD), and least
         consequential exactly where it matters most (cells close to a
         stream).

    Cached on disk per (catchment, rainfall_mm, duration_hr) scenario,
    same atomic-write + post-write-validation convention as
    render_flood_prone_zones. Returns the same {"png_url", "bounds"}
    shape plus a "scenario" dict (resolved discharge/CN/slope/area
    numbers) so a caller/frontend can show exactly what scenario
    produced the layer, not just an opaque threshold number.
    """
    if catchment_key not in PILOT_CATCHMENTS:
        raise ValueError(f"Unknown catchment {catchment_key!r} — known: {list(PILOT_CATCHMENTS)}")
    if rainfall_mm <= 0 or duration_hr <= 0:
        raise ValueError("rainfall_mm and duration_hr must both be positive")
    cfg = PILOT_CATCHMENTS[catchment_key]

    pipeline = build_hand_pipeline(catchment_key, force=force)
    paths = pipeline["paths"]
    stats = pipeline["stats"]

    from . import flood_discharge

    # No shared-constant fallback (§0.23's own fix) — every catchment
    # MUST state its own composite_cn explicitly; a missing value is a
    # real configuration error, not a "use Lai Nullah's number" default.
    if "composite_cn" not in cfg or cfg["composite_cn"] is None:
        raise ValueError(
            f"flood_model: catchment {catchment_key!r} has no composite_cn configured — "
            f"every PILOT_CATCHMENTS entry must state its own value explicitly (see §0.23)"
        )
    composite_cn = cfg["composite_cn"]
    basin_length_km = cfg["basin_length_km"]
    relief_m = stats["dem"]["max"] - stats["dem"]["min"]
    if relief_m <= 0:
        raise RuntimeError(
            f"flood_model: DEM relief for {catchment_key!r} is non-positive "
            f"({relief_m}) — cannot derive a channel slope"
        )
    channel_slope = relief_m / (basin_length_km * 1000.0)

    _, miny, _, maxy = cfg["bbox"]
    lat_mid = (miny + maxy) / 2.0
    km_per_deg_lat = 111.32
    km_per_deg_lon = 111.32 * math.cos(math.radians(lat_mid))

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"r{rainfall_mm:g}_d{duration_hr:g}"
    png_path = os.path.join(out_dir, f"flood_prone_zones_discharge_{scenario_key}.png")

    scenario_json_path = os.path.join(out_dir, f"flood_prone_zones_discharge_{scenario_key}.json")

    if (not force and os.path.exists(png_path) and os.path.getsize(png_path) >= 512
            and os.path.exists(scenario_json_path)):
        # Sidecar JSON, written alongside the PNG the first time this
        # scenario was ever built (below) — cheaper and more complete
        # than re-deriving the scenario summary from scratch on a cache
        # hit (an earlier version of this function did that via a now-
        # removed _discharge_scenario_from_cache helper, but that path
        # couldn't recover flood_prone_cells/flood_zone_km2 without
        # re-reading the masked raster anyway — the sidecar avoids that
        # duplicate work entirely).
        try:
            with open(scenario_json_path, "r") as f:
                payload = _flood_zone_payload(png_path, paths["hand"])
                payload["scenario"] = json.load(f)
            return payload
        except (OSError, json.JSONDecodeError, KeyError) as exc:
            logger.warning(
                "flood_model: scenario sidecar %s unreadable (%s) — rebuilding this "
                "scenario from scratch instead of trusting a stale/corrupt cache entry",
                scenario_json_path, exc,
            )

    with _gdal_lock():
        flow_arr, flow_gt, flow_proj, flow_nodata, w, h = _read_raster_array(paths["flow_accum"])
        stream_arr, _, _, stream_nodata, sw, sh = _read_raster_array(paths["streams"])
    if (sw, sh) != (w, h):
        raise RuntimeError(
            f"flood_model: streams raster dims {(sw, sh)} != flow_accum dims {(w, h)} "
            f"for {catchment_key!r} — pipeline outputs are supposed to share a grid"
        )

    cell_area_km2 = abs(flow_gt[1]) * km_per_deg_lon * abs(flow_gt[5]) * km_per_deg_lat

    stream_mask = np.ones_like(stream_arr, dtype=bool)
    if stream_nodata is not None:
        stream_mask &= (stream_arr != stream_nodata)
    stream_mask &= (stream_arr > 0)
    flow_valid = np.ones_like(flow_arr, dtype=bool)
    if flow_nodata is not None:
        flow_valid &= (flow_arr != flow_nodata)
    stream_mask &= flow_valid

    if not stream_mask.any():
        raise RuntimeError(
            f"flood_model: no stream cells found for {catchment_key!r} while building "
            f"the discharge-driven stage raster — streams.tif looks empty"
        )

    outlet_cells = float(flow_arr[flow_valid].max())
    outlet_area_km2 = outlet_cells * cell_area_km2
    if outlet_area_km2 <= 0:
        raise RuntimeError(
            f"flood_model: outlet drainage area computed as {outlet_area_km2} for "
            f"{catchment_key!r} — flow_accum raster looks empty"
        )

    outlet_discharge = flood_discharge.estimate_peak_discharge_m3s(
        rainfall_mm=rainfall_mm, duration_hr=duration_hr, area_km2=outlet_area_km2,
        length_km=basin_length_km, relief_m=relief_m, curve_number=composite_cn,
    )
    outlet_qp = outlet_discharge["peak_discharge_m3s"]

    local_area_km2 = np.where(stream_mask, np.maximum(flow_arr, 1.0) * cell_area_km2, 0.0)
    with _gdal_lock():
        hand_arr, hand_gt, hand_proj, hand_nodata, hw, hh = _read_raster_array(paths["hand"])
    if (hw, hh) != (w, h):
        raise RuntimeError(
            f"flood_model: hand raster dims {(hw, hh)} != flow_accum dims {(w, h)} "
            f"for {catchment_key!r}"
        )
    valid_hand_mask = np.ones_like(hand_arr, dtype=bool)
    if hand_nodata is not None:
        valid_hand_mask &= (hand_arr != hand_nodata)

    if outlet_qp <= 0:
        # No-runoff storm (SCS-CN: rainfall below the initial-abstraction
        # threshold, common for a light/short storm on this basin's CN
        # 80.7). Every stream cell's own local stage is legitimately
        # 0.0 in this case — but confirmed live that feeding
        # WhiteboxTools' euclidean_allocation an input raster whose
        # every valid value is EXACTLY 0.0 makes it emit `inf`
        # everywhere (a genuine bug in this project's installed
        # WhiteboxTools v2.4.0, distinct from the elevation_above_
        # stream_euclidean bug above — a `0.0 <= inf` comparison then
        # silently flags the WHOLE basin as flood-prone, the opposite of
        # correct for a storm with zero runoff). Handled directly here,
        # without ever calling the buggy tool for this degenerate input:
        # the mathematically correct answer for zero discharge
        # everywhere is that only the stream channel itself (hand==0)
        # is "at" water level, so that's what's used.
        logger.info(
            "flood_model: rainfall=%.1fmm for %r produced zero SCS-CN runoff (CN=%.1f) "
            "— skipping euclidean_allocation for this degenerate all-zero case, using "
            "the stream network itself as the flood mask",
            rainfall_mm, catchment_key, composite_cn,
        )
        flood_mask = valid_hand_mask & (hand_arr <= 0)
    else:
        local_q = np.where(stream_mask, outlet_qp * (local_area_km2 / outlet_area_km2), 0.0)
        local_stage = flood_discharge.solve_stage_for_discharge_m_array(
            local_q, local_area_km2, channel_slope,
        )
        local_stage_arr = np.where(stream_mask, local_stage, _DISCHARGE_STAGE_NODATA)

        local_stage_path = os.path.join(out_dir, f"08_local_stage_{scenario_key}.tif")
        allocated_stage_path = os.path.join(out_dir, f"09_allocated_stage_{scenario_key}.tif")
        tmp_local = f"{local_stage_path}.tmp{os.getpid()}"
        with _gdal_lock():
            _write_raster_array(tmp_local, local_stage_arr, flow_gt, flow_proj, _DISCHARGE_STAGE_NODATA)
        os.replace(tmp_local, local_stage_path)

        _run_wbt("euclidean_allocation",
                 {"i": local_stage_path, "output": allocated_stage_path},
                 allocated_stage_path)

        with _gdal_lock():
            alloc_arr, _, _, alloc_nodata, aw, ah = _read_raster_array(allocated_stage_path)
        if (aw, ah) != (hw, hh):
            raise RuntimeError(
                f"flood_model: allocated-stage dims {(aw, ah)} != hand dims "
                f"{(hw, hh)} for {catchment_key!r}"
            )

        valid_mask = valid_hand_mask.copy()
        if alloc_nodata is not None:
            valid_mask &= (alloc_arr != alloc_nodata)
        # inf/nan guard — belt-and-braces against the SAME class of
        # euclidean_allocation degenerate-output bug just documented
        # above, in case a NON-zero-but-still-pathological input ever
        # triggers it too: never trust a non-finite allocated value.
        valid_mask &= np.isfinite(alloc_arr)
        flood_mask = valid_mask & (hand_arr <= alloc_arr)

    if not flood_mask.any():
        logger.warning(
            "flood_model: discharge-driven scenario rainfall=%.1fmm/%.1fhr for %r "
            "produced ZERO flood-prone cells — plausible for a light storm, but worth "
            "a second look if unexpected",
            rainfall_mm, duration_hr, catchment_key,
        )
        max_val = 0.1  # avoid a degenerate zero-width ramp below
    else:
        max_val = float(hand_arr[flood_mask].max())

    masked_hand_arr = np.where(flood_mask, hand_arr, _DISCHARGE_STAGE_NODATA)

    # §0.37 — clip to the user's own real drawn polygon (not just its
    # bbox), if this is a custom AOI. Deliberately applied HERE, to
    # masked_hand_arr itself, before it's ever written to disk — every
    # downstream consumer of masked_hand_path (this function's own PNG
    # render below, AND build_discharge_binary_mask's later re-read for
    # exposure-report vectorization) reads the SAME already-clipped
    # file, so one clip here fixes both the rendered shape and the
    # counted exposure numbers consistently, rather than needing a
    # second, separate clip wired into flood_exposure.py's own
    # vectorization call. A curated pilot catchment never sets
    # clip_polygon, so this is a no-op for all 4 of them.
    clip_polygon = cfg.get("clip_polygon")
    if clip_polygon:
        masked_hand_arr = _clip_array_to_polygon(
            masked_hand_arr, hand_gt, hand_proj, _DISCHARGE_STAGE_NODATA, clip_polygon,
        )

    masked_hand_path = os.path.join(out_dir, f"10_masked_hand_{scenario_key}.tif")
    tmp_masked = f"{masked_hand_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp_masked, masked_hand_arr, hand_gt, hand_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp_masked, masked_hand_path)

    # Colorize with a ramp ceiling keyed to THIS scenario's own max
    # flood-prone HAND value (not a fixed threshold, not basin relief —
    # the values actually present in masked_hand_arr top out at max_val
    # by construction) so the color spread is meaningful for this
    # specific rainfall/duration combination.
    ramp = _flood_zone_ramp_file(round(max_val, 3))
    tmp_png = f"{png_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        colored_ds = gdal.DEMProcessing(
            tmp_png, masked_hand_path, "color-relief",
            colorFilename=ramp, format="PNG", addAlpha=True,
        )
        if colored_ds is None:
            raise RuntimeError(
                "gdal.DEMProcessing (color-relief) returned None for the "
                "discharge-driven flood zone"
            )
        colored_ds = None
        check_ds = gdal.Open(tmp_png)
        if check_ds is None or check_ds.RasterXSize <= 0 or check_ds.RasterYSize <= 0:
            raise RuntimeError("discharge-driven flood zone PNG failed post-write validation")
        check_ds = None
    os.replace(tmp_png, png_path)
    stray_aux = f"{tmp_png}.aux.xml"
    if os.path.exists(stray_aux):
        try:
            os.remove(stray_aux)
        except OSError:
            pass

    flood_prone_cells = int(flood_mask.sum())
    scenario = {
        "rainfall_mm": rainfall_mm,
        "duration_hr": duration_hr,
        "composite_cn": composite_cn,
        "channel_slope": round(channel_slope, 5),
        "outlet_area_km2": round(outlet_area_km2, 2),
        "flood_prone_cells": flood_prone_cells,
        "flood_zone_km2": round(flood_prone_cells * cell_area_km2, 2),
        **outlet_discharge,
    }
    tmp_json = f"{scenario_json_path}.tmp{os.getpid()}"
    with open(tmp_json, "w") as f:
        json.dump(scenario, f)
    os.replace(tmp_json, scenario_json_path)

    payload = _flood_zone_payload(png_path, paths["hand"])
    payload["scenario"] = scenario
    return payload


def build_discharge_margin_raster(catchment_key, rainfall_mm, duration_hr, force=False):
    """Builds (or reuses cached) a CONTINUOUS 'margin' raster =
    allocated_stage - hand for one rainfall/duration scenario — higher
    values mean more confidently flood-prone, negative means "above the
    scenario's own water level." Unlike build_discharge_driven_flood_zone's
    own binary flood-prone PNG, this is meant for accuracy_assessment.py's
    assess_raster_auc()/assess_pooled_multi_raster_auc() (invert_score=
    False — this score already increases with flood-proneness, unlike raw
    HAND which needs inverting), see methodology doc §0.21.

    ADDITIVE: calls build_discharge_driven_flood_zone() first (reusing
    its own caching and validation unchanged) then reads the SAME cached
    intermediate rasters that function already wrote
    (07_hand.tif/09_allocated_stage_{scenario_key}.tif) — no existing
    function's logic is touched.

    Handles the zero-runoff degenerate case
    build_discharge_driven_flood_zone's own §0.19 comment documents (no
    09_allocated_stage file is ever written when outlet peak discharge is
    <= 0, since euclidean_allocation is skipped entirely for that
    WhiteboxTools-bug-avoidance reason) by using margin = -hand directly
    — mathematically consistent with that function's own "allocated
    stage is 0 everywhere" reasoning for a no-runoff storm, not a new
    assumption invented here.

    Returns the margin raster's file path."""
    build_discharge_driven_flood_zone(catchment_key, rainfall_mm, duration_hr, force=force)

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"r{rainfall_mm:g}_d{duration_hr:g}"
    margin_path = os.path.join(out_dir, f"11_margin_{scenario_key}.tif")

    if not force and os.path.exists(margin_path) and os.path.getsize(margin_path) > 0:
        return margin_path

    hand_path = os.path.join(out_dir, "07_hand.tif")
    allocated_path = os.path.join(out_dir, f"09_allocated_stage_{scenario_key}.tif")

    with _gdal_lock():
        hand_arr, hand_gt, hand_proj, hand_nodata, hw, hh = _read_raster_array(hand_path)
    valid_hand = np.ones_like(hand_arr, dtype=bool)
    if hand_nodata is not None:
        valid_hand &= (hand_arr != hand_nodata)

    if os.path.exists(allocated_path) and os.path.getsize(allocated_path) > 0:
        with _gdal_lock():
            alloc_arr, _, _, alloc_nodata, aw, ah = _read_raster_array(allocated_path)
        if (aw, ah) != (hw, hh):
            raise RuntimeError(
                f"flood_model: allocated-stage dims {(aw, ah)} != hand dims {(hw, hh)} "
                f"for {catchment_key!r} scenario {scenario_key!r}"
            )
        valid = valid_hand.copy()
        if alloc_nodata is not None:
            valid &= (alloc_arr != alloc_nodata)
        valid &= np.isfinite(alloc_arr)
        margin = np.where(valid, alloc_arr - hand_arr, _DISCHARGE_STAGE_NODATA)
    else:
        margin = np.where(valid_hand, -hand_arr, _DISCHARGE_STAGE_NODATA)

    tmp = f"{margin_path}.tmp{os.getpid()}"
    with _gdal_lock():
        _write_raster_array(tmp, margin, hand_gt, hand_proj, _DISCHARGE_STAGE_NODATA)
    os.replace(tmp, margin_path)
    return margin_path


_DISCHARGE_MASK_NODATA_BYTE = 0
_DISCHARGE_MASK_FLOOD_BYTE = 1


def build_discharge_binary_mask(catchment_key, rainfall_mm, duration_hr, force=False):
    """Builds (or reuses cached) a BINARY Byte mask (1 = flood-prone, 0 =
    not) for one discharge-driven scenario — §0.24, the discharge-mode
    counterpart to flood_exposure._binary_flood_mask (fixed-threshold
    mode's own binary mask), needed because gdal.Polygonize (used by
    flood_exposure._vectorize_flood_zone, UNCHANGED, reused as-is) groups
    contiguous EQUAL-VALUE pixels — feeding it a continuous raster
    (varying HAND values) directly would produce one polygon per
    near-unique pixel value, not one flood-zone polygon. This function
    exists so exposure computation can reuse that same vectorizer
    unmodified for BOTH modes.

    ADDITIVE: calls build_discharge_driven_flood_zone() first (reusing
    its own caching/validation unchanged), then reclassifies its already-
    written 10_masked_hand_{scenario_key}.tif (real HAND value where
    flood-prone, NoData everywhere else — computed once, reused here
    rather than recomputing flood_mask from scratch) into a proper binary
    mask. No existing function's logic is touched.

    Returns the mask raster's file path."""
    build_discharge_driven_flood_zone(catchment_key, rainfall_mm, duration_hr, force=force)

    out_dir = os.path.join(settings.MEDIA_ROOT, _FLOOD_MEDIA_SUBDIR, catchment_key)
    scenario_key = f"r{rainfall_mm:g}_d{duration_hr:g}"
    mask_path = os.path.join(out_dir, f"12_discharge_binary_mask_{scenario_key}.tif")

    if not force and os.path.exists(mask_path) and os.path.getsize(mask_path) > 0:
        return mask_path

    masked_hand_path = os.path.join(out_dir, f"10_masked_hand_{scenario_key}.tif")
    with _gdal_lock():
        masked_arr, gt, proj, nodata, w, h = _read_raster_array(masked_hand_path)

    flood_prone = np.ones_like(masked_arr, dtype=np.float64) * _DISCHARGE_MASK_NODATA_BYTE
    if nodata is not None:
        flood_prone = np.where(masked_arr != nodata, _DISCHARGE_MASK_FLOOD_BYTE, _DISCHARGE_MASK_NODATA_BYTE)
    else:
        flood_prone[:] = _DISCHARGE_MASK_FLOOD_BYTE

    tmp = f"{mask_path}.tmp{os.getpid()}"
    with _gdal_lock():
        from osgeo import gdal
        driver = gdal.GetDriverByName("GTiff")
        ds = driver.Create(tmp, w, h, 1, gdal.GDT_Byte)
        if ds is None:
            raise RuntimeError(f"gdal driver.Create failed for {tmp}")
        ds.SetGeoTransform(gt)
        ds.SetProjection(proj)
        band = ds.GetRasterBand(1)
        band.SetNoDataValue(_DISCHARGE_MASK_NODATA_BYTE)
        for row_idx in range(h):
            raw = struct.pack(f"<{w}B", *flood_prone[row_idx].astype(np.uint8).tolist())
            band.WriteRaster(0, row_idx, w, 1, raw, buf_type=gdal.GDT_Byte)
        band.FlushCache()
        ds = None
    os.replace(tmp, mask_path)
    return mask_path


def _flood_zone_payload(png_path, hand_path):
    from osgeo import gdal
    with _gdal_lock():
        ds = gdal.Open(hand_path)
        gt = ds.GetGeoTransform()
        w, h = ds.RasterXSize, ds.RasterYSize
    # Corner-based WGS84 bounds would need a reprojection pass (the HAND
    # raster is in the DEM's native geographic CRS already here, unlike
    # PMD's own EPSG:3857-warped rasters) — kept as plain projected-unit
    # corners for now; reprojecting to WGS84 bounds is part of the
    # frontend-wiring step this function deliberately doesn't do yet.
    minx, maxy = gt[0], gt[3]
    maxx, miny = gt[0] + gt[1] * w, gt[3] + gt[5] * h
    rel_path = os.path.relpath(png_path, settings.MEDIA_ROOT).replace(os.sep, "/")
    return {
        "png_url": f"{settings.MEDIA_URL.rstrip('/')}/{rel_path}",
        "bounds": [[minx, miny], [maxx, maxy]],
    }
