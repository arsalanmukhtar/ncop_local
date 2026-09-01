# project/ncop_internal/flood_riverine.py
# ---------------------------------------------------------------------------
# Sub-phase R2 — real river/barrage discharge input for the riverine flood
# mode. Riverine flooding reuses the SAME HAND + Manning's-equation stage-
# solving engine the flash-flood discharge-driven mode already built
# (flood_model.py — see Sub-phase R1's refactor extracting the shared
# discharge->stage core) — the only genuine difference is WHERE the
# discharge number comes from: a real river/barrage gauge reading here,
# instead of a local SCS-CN rainfall-runoff calculation for a small nullah
# basin. This mirrors exactly how §0.26's flood_forecast.py fed real
# forecast/observed rainfall into the SAME existing discharge pipeline.
#
# DATA SOURCE — confirmed live this session, not assumed:
# views.py's own FfdHistoryAPIView/_ffd_history_from_internal_api machinery
# was tried FIRST and confirmed UNREACHABLE from this dev environment on
# BOTH its paths:
#   - The "primary" internal API (172.18.1.113:5000) — a real TCP connect
#     timeout (10s), not a data/auth error — the host is simply not
#     reachable from here.
#   - The public ffd.pmd.gov.pk/river-state/data fallback — a real HTTP
#     403 (Forbidden), likely a WAF change or a rotated anti-scraping
#     token; the site's own /bulletin/ page also 403s.
#
# A THIRD, separate internal host — confirmed live and working — is used
# instead: the SAME bulk history endpoint the frontend's own Story Mode
# already calls client-side (gcop-api-cache.js's FFD_HISTORY_ALL_BASE_URL,
# "http://172.18.7.35:8000/proxy_api_daily") — on the same reachable
# 172.18.x subnet as GCOP (172.18.7.21, confirmed reachable in §0.26).
# Confirmed live: returns real, current inflow/outflow series for all 31
# FFD stations (Tarbela, Kalabagh, Chashma, Taunsa, Guddu, Sukkur, Kotri,
# and 24 others) in one call. This module calls it directly server-side
# (a genuinely new server-side integration — this endpoint was previously
# only ever called from the browser) rather than reusing views.py's own
# broken-here FFD machinery, which this module's own docstring does NOT
# claim to fix — a real, stated limitation of the OTHER path, not silently
# routed around without comment.
#
# UNIT CONVERSION — confirmed live, a real and important finding: FFD
# reports discharge in CUSECS (cubic feet per second), not m3/s. Confirmed
# by the raw values' own magnitude (e.g. Taunsa outflow ~372,712 during a
# real reading — an entirely ordinary cusecs figure for the Indus in
# monsoon, but a wildly implausible m3/s one). Every downstream consumer
# (flood_discharge.py's Manning's equation, calibrated in m3/s throughout)
# needs the converted value — done here, once, at the source, not left for
# a caller to get wrong.
# ---------------------------------------------------------------------------

import logging
import re

logger = logging.getLogger(__name__)

FFD_HISTORY_ALL_URL = "http://172.18.7.35:8000/proxy_api_daily/api/history-all"
FFD_WATERLEVELS_URL = "http://172.18.7.21:8000/get-ffd-waterlevels/"

# Exact ft^3 -> m^3 conversion factor (1 cusec = 1 ft^3/s).
CUSECS_TO_M3S = 0.0283168466

_TIMEOUT_S = 15

# ---------------------------------------------------------------------------
# Official FFD flood-severity thresholds — a real, material design pivot
# from this sub-phase's original plan. R3 (the channel-geometry sanity
# check) computed what flood_discharge.channel_width_m()'s Nullah-Lai-
# fitted Leopold-Maddock power law predicts at riverine drainage-area
# scale: 250-600m for plausible Indus-basin areas. That number LOOKS
# plausible (real Indus channel widths near these barrages are genuinely
# in that range) — but a formula fitted on a basin ~1000-3000x smaller
# landing in a believable range by coincidence is not validation, and this
# project's own composite_cn/channel-geometry precedent (§0.19/§0.23) has
# always required a real, cited number before trusting a scaled parameter,
# not a plausible-looking extrapolation. Rather than present an unvalidated
# spatial extent as riverine mode's primary output, this uses FFD's OWN
# real, official/live severity classification instead — better-evidenced
# for the same goal (know how severe a riverine flood is right now).
#
# Two sources, both confirmed live this session:
#   1. get-ffd-waterlevels/ (GCOP, 172.18.7.21 — same reachable host
#      §0.26 already used) — FFD's own ALREADY-COMPUTED categorical
#      status (NORMAL/LOW/MEDIUM/HIGH/...) per station, for all 31
#      stations, refreshed live. The authoritative, always-available
#      signal — no threshold table needs to be hardcoded/guessed for this
#      to work correctly.
#   2. Numeric Design Capacity / Low / Medium / High / Very High /
#      Exceptional flood thresholds (in lacs = 100,000 cusecs), sourced
#      directly from https://ffd.pmd.gov.pk/flood-limits (the page itself
#      renders client-side from a JS bundle not decoded this session — the
#      table below is exactly the subset the user directly supplied from
#      that page, NOT the full 31-station table; stations without an
#      entry here simply have no numeric threshold available in this
#      pass — real, honest, not filled in with a guess).
FFD_OFFICIAL_FLOOD_LIMITS_CUSECS = {
    # name -> {design_capacity, low, medium, high, very_high, exceptional} in cusecs.
    # None = "—" (not published for this station, per the source page).
    "tarbela": {
        "design_capacity": 1_500_000, "low": 250_000, "medium": 375_000,
        "high": 500_000, "very_high": 650_000, "exceptional": 800_000,
    },
    "attock": {
        "design_capacity": None, "low": 250_000, "medium": 375_000,
        "high": 500_000, "very_high": 650_000, "exceptional": 800_000,
    },
    "kalabagh": {
        "design_capacity": 950_000, "low": 250_000, "medium": 375_000,
        "high": 500_000, "very_high": 650_000, "exceptional": 800_000,
    },
    "chashma": {
        "design_capacity": 950_000, "low": 250_000, "medium": 375_000,
        "high": 500_000, "very_high": 650_000, "exceptional": 800_000,
    },
}
FFD_FLOOD_LIMITS_SOURCE_URL = "https://ffd.pmd.gov.pk/flood-limits"


def _normalize_station_name(name):
    """FFD's own two live feeds spell station names slightly differently
    (confirmed live: 'Tarbela' in the history-all feed vs 'Tarbela Dam' in
    get-ffd-waterlevels; 'Kalabagh' vs 'Kala Bagh') — normalize to a
    lowercase, space/word-boundary-insensitive core name so both feeds'
    spellings match the same lookup key, rather than requiring an exact
    string match that would silently fail on this real inconsistency."""
    return re.sub(r"[^a-z]", "", name.lower())


def _parse_ffd_timestamp(x):
    """FFD's own timestamp format: 'DD-Mon-YYYY HH:MM PKT', e.g.
    '28-Aug-2026 00:00 PKT'. Returns a datetime or None if unparseable —
    degrade gracefully rather than crash on a format drift."""
    import datetime
    try:
        return datetime.datetime.strptime(x.replace(" PKT", ""), "%d-%b-%Y %H:%M")
    except (ValueError, AttributeError):
        return None


def fetch_barrage_discharge(station_name, days=3, use="outflow"):
    """Fetches the latest available REAL discharge reading (converted to
    m3/s) for a named FFD barrage/gauge station.

    `station_name` — matched case-insensitively against FFD's own station
    names (confirmed live: 'TAUNSA', 'GUDDU', 'TARBELA', 'KALABAGH',
    'CHASHMA', 'SUKKUR', 'KOTRI', and 24 others — see this module's own
    docstring for how that list was obtained).
    `use` — 'outflow' (default; the discharge actually released
    downstream, the physically relevant number for flooding BELOW the
    barrage) or 'inflow' (upstream arriving flow — the storm signal
    itself, before regulation).

    Series entries can have real timing gaps (confirmed live: e.g. a
    ~36h gap in Taunsa's own readings) — this takes whichever entry has
    the LATEST parseable timestamp, not simply the last list item,
    since the feed's own ordering wasn't independently verified to be
    strictly chronological.

    Returns {"discharge_m3s", "discharge_cusecs", "station", "reading_time",
    "source"} or None on any failure (unreachable, unknown station, no
    parseable readings) — matching this project's established degrade-to-
    None convention (flood_forecast.py's own fetchers)."""
    import requests

    try:
        r = requests.get(FFD_HISTORY_ALL_URL, params={"days": days}, timeout=_TIMEOUT_S)
        r.raise_for_status()
        data = r.json()
    except Exception:
        logger.warning(
            "flood_riverine: FFD bulk history fetch failed (station=%s) — degraded, "
            "no riverine discharge available", station_name, exc_info=True,
        )
        return None

    stations = data.get("stations") or {}
    wanted_norm = _normalize_station_name(station_name)
    matched_name, series_block = None, None
    for name, block in stations.items():
        if _normalize_station_name(name) == wanted_norm:
            matched_name, series_block = name, block
            break
    if series_block is None:
        logger.info(
            "flood_riverine: station %r not found in FFD feed's %d stations — no riverine "
            "discharge available (a real, confirmed condition, not a bug)",
            station_name, len(stations),
        )
        return None

    series = series_block.get(use) or []
    best_time, best_value = None, None
    for point in series:
        t = _parse_ffd_timestamp(point.get("x"))
        v = point.get("y")
        if t is None or v is None:
            continue
        if best_time is None or t > best_time:
            best_time, best_value = t, float(v)

    if best_value is None:
        logger.info(
            "flood_riverine: station %r has no parseable %s readings in the last %d days — "
            "no riverine discharge available", station_name, use, days,
        )
        return None

    discharge_m3s = best_value * CUSECS_TO_M3S
    return {
        "discharge_m3s": round(discharge_m3s, 2),
        "discharge_cusecs": best_value,
        "station": matched_name,
        "reading_time": best_time.isoformat(),
        "source": "ffd_history_all",
    }


def _parse_height_m(raw):
    """FFD's own 'height' field is a string like '191 m' — a real, genuine
    water-surface elevation (confirmed live, §R4: values form a perfect
    monotonic gradient down the Indus — Tarbela 430m -> Kalabagh 211m ->
    Chashma 191m -> Taunsa 131m -> Guddu 74m -> Sukkur 57m -> Kotri 15m,
    exactly matching real downstream geography — not some other unrelated
    metric). Returns a float or None if unparseable."""
    if not raw:
        return None
    try:
        return float(str(raw).replace("m", "").strip())
    except ValueError:
        return None


def fetch_live_status(station_name):
    """Reads FFD's OWN already-computed categorical status (e.g. NORMAL,
    LOW, MEDIUM, HIGH) AND real water-surface elevation for a named
    station from get-ffd-waterlevels/ — the authoritative, always-
    available severity signal (confirmed live: covers all 31 stations,
    refreshed on FFD's own schedule; confirmed live to be genuinely
    per-station-calibrated, not a naive absolute-discharge cutoff — e.g.
    Guddu showed 'LOW' at 349,585 cusecs, a large absolute number that's
    still low relative to Guddu's own much higher flood thresholds).

    Returns {"status", "height_m", "discharge_cusecs_raw", "recording_time",
    "station", "source"} or None on failure/unknown station — matching
    this module's own degrade-to-None convention. `discharge_cusecs_raw`
    is this endpoint's own comma-formatted string field, kept as-is (not
    reparsed/converted) since fetch_barrage_discharge already provides the
    converted numeric value from a separate, purpose-built feed — this
    field exists here only for a human-readable cross-check. `height_m` is
    the real water-surface elevation used by build_riverine_flood_zone
    (flood_model.py) to derive a live, gauge-calibrated HAND threshold —
    see that function's own docstring."""
    import requests

    try:
        r = requests.get(FFD_WATERLEVELS_URL, timeout=_TIMEOUT_S)
        r.raise_for_status()
        data = r.json()
    except Exception:
        logger.warning(
            "flood_riverine: FFD waterlevels fetch failed (station=%s) — degraded, no live "
            "status available", station_name, exc_info=True,
        )
        return None

    wanted_norm = _normalize_station_name(station_name)
    for feat in data.get("features") or []:
        props = feat.get("properties") or {}
        if _normalize_station_name(props.get("name") or "") == wanted_norm:
            return {
                "status": props.get("status"),
                "height_m": _parse_height_m(props.get("height")),
                "discharge_cusecs_raw": props.get("discharge"),
                "recording_time": props.get("recording_time"),
                "station": props.get("name"),
                "source": "ffd_waterlevels",
            }

    logger.info(
        "flood_riverine: station %r not found in get-ffd-waterlevels' station list — no "
        "live status available (a real, confirmed condition, not a bug)", station_name,
    )
    return None


def classify_discharge_severity(station_name, discharge_cusecs):
    """Classifies a discharge value (cusecs) against FFD's own officially
    published numeric flood-limit thresholds, ONLY for the stations
    FFD_OFFICIAL_FLOOD_LIMITS_CUSECS actually has real numbers for (see
    that dict's own docstring for provenance and its real coverage gap —
    27 of 31 stations have no numeric threshold recorded in this pass).

    Returns {"level", "thresholds", "design_capacity"} — `level` is one of
    "below_low", "low", "medium", "high", "very_high", "exceptional" — or
    None if this station has no official threshold table available (an
    honest gap, not a guess)."""
    limits = FFD_OFFICIAL_FLOOD_LIMITS_CUSECS.get(_normalize_station_name(station_name))
    if limits is None:
        return None

    level = "below_low"
    for name, key in (
        ("exceptional", "exceptional"), ("very_high", "very_high"),
        ("high", "high"), ("medium", "medium"), ("low", "low"),
    ):
        threshold = limits.get(key)
        if threshold is not None and discharge_cusecs >= threshold:
            level = name
            break

    return {
        "level": level,
        "thresholds": {k: v for k, v in limits.items() if k != "design_capacity"},
        "design_capacity": limits.get("design_capacity"),
        "source_url": FFD_FLOOD_LIMITS_SOURCE_URL,
    }


def get_riverine_discharge_status(station_name):
    """Convenience dispatcher combining everything above into one call for
    flood_model_views.py: the real converted discharge (m3/s, for feeding
    the shared stage-solving engine), FFD's own live status (always
    available), and the official numeric classification (where FFD has
    published thresholds for this station). The three sources are
    reported independently, never forced to agree — e.g. a station's live
    `status` and its `official.level` are computed by DIFFERENT FFD
    mechanisms (FFD's own internal logic vs. this module reading the
    public threshold table) and are not guaranteed to say the same thing
    in every edge case; both are surfaced honestly rather than picking
    one and hiding the other.

    Returns {"discharge", "live_status", "official_classification"} — any
    of the three sub-keys can independently be None if that particular
    source failed or doesn't cover this station."""
    discharge = fetch_barrage_discharge(station_name)
    live_status = fetch_live_status(station_name)
    official = (
        classify_discharge_severity(station_name, discharge["discharge_cusecs"])
        if discharge else None
    )
    return {
        "discharge": discharge,
        "live_status": live_status,
        "official_classification": official,
    }
