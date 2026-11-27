# project/ncop_internal/aqi_engine.py
# ---------------------------------------------------------------------------
# NCOP's single AQI calculator. Pure functions, no I/O: every AQI shown by the
# National Air Quality Watch (briefing, report, API) comes from here.
#
# Standard: selected by settings.AQI_STANDARD, default "us_epa_2024".
#   Breakpoints: 40 CFR Part 58 Appendix G, Table 2 (89 FR 16403, 6 Mar 2024).
#   Method, rounding, NowCast, health statements: US EPA Technical Assistance
#   Document for the Reporting of Daily Air Quality, EPA-403/B-26-003 (May 2026).
# It is a REFERENCE standard for NCOP, not one notified for Pakistan. EPA
# Punjab's Order 355/PA (1 Oct 2025, in force 3 Oct 2025) computes its AQI from
# 8-hour averages and reports on a different index, so the two numbers differ
# for the same air. settings.AQI_STANDARD_APPROVED / AQI_ADVICE_APPROVED flip
# the "pending approval" labels once NDMA and the relevant authorities decide.
#
# Rules kept deliberately strict:
#   - a sub-index is only computed from a concentration with that pollutant's
#     prescribed averaging period (daily_* / nowcast_pm helpers below);
#   - the overall AQI is the highest valid sub-index, never an average;
#   - missing input -> None, never 0 and never a neighbour's value.
# ---------------------------------------------------------------------------

import math
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

CATEGORIES = (
    # key, label, AQI low, AQI high (None = open), EPA colour (TAD Table 2)
    ("good", "Good", 0, 50, "#00e400"),
    ("moderate", "Moderate", 51, 100, "#ffff00"),
    ("usg", "Unhealthy for Sensitive Groups", 101, 150, "#ff7e00"),
    ("unhealthy", "Unhealthy", 151, 200, "#ff0000"),
    ("very_unhealthy", "Very Unhealthy", 201, 300, "#8f3f97"),
    ("hazardous", "Hazardous", 301, None, "#7e0023"),
)
CATEGORY_KEYS = tuple(c[0] for c in CATEGORIES)

_AQI_RANGES = ((0, 50), (51, 100), (101, 150), (151, 200), (201, 300), (301, 500))

# pollutant -> (unit, decimals kept by truncation, rows). A row is
# (conc low, conc high) for the AQI range at the same position; None = the
# standard defines no value there for this averaging period.
_EPA_2024 = {
    "pm25_24h": ("µg/m³", 1, ((0.0, 9.0), (9.1, 35.4), (35.5, 55.4), (55.5, 125.4), (125.5, 225.4), (225.5, 325.4))),
    "pm10_24h": ("µg/m³", 0, ((0, 54), (55, 154), (155, 254), (255, 354), (355, 424), (425, 604))),
    "o3_8h": ("ppm", 3, ((0.0, 0.054), (0.055, 0.070), (0.071, 0.085), (0.086, 0.105), (0.106, 0.200), None)),
    "o3_1h": ("ppm", 3, (None, None, (0.125, 0.164), (0.165, 0.204), (0.205, 0.404), (0.405, 0.604))),
    "co_8h": ("ppm", 1, ((0.0, 4.4), (4.5, 9.4), (9.5, 12.4), (12.5, 15.4), (15.5, 30.4), (30.5, 50.4))),
    "so2_1h": ("ppb", 0, ((0, 35), (36, 75), (76, 185), (186, 304), None, None)),
    "so2_24h": ("ppb", 0, (None, None, None, None, (305, 604), (605, 1004))),
    "no2_1h": ("ppb", 0, ((0, 53), (54, 100), (101, 360), (361, 649), (650, 1249), (1250, 2049))),
}

# Health statements for particle pollution, TAD Table 5 (PM2.5 column).
_PM_STATEMENTS = {
    "good": {"everyone": "It's a great day to be active outside."},
    "moderate": {"sensitive": "Unusually sensitive people: consider making outdoor activities shorter and less intense. Go inside if you have symptoms such as coughing or shortness of breath."},
    "usg": {"sensitive": "Sensitive groups: make outdoor activities shorter and less intense. It's OK to be active outdoors but take more breaks. Watch for symptoms such as coughing or shortness of breath."},
    "unhealthy": {"sensitive": "Sensitive groups: consider rescheduling or moving all activities inside. Go inside if you have symptoms.",
                  "everyone": "Everyone else: keep outdoor activities shorter and less intense. Go inside if you have symptoms."},
    "very_unhealthy": {"sensitive": "Sensitive groups: avoid all physical activity outdoors. Reschedule to a time when air quality is better or move activities indoors.",
                       "everyone": "Everyone else: limit outdoor physical activity. Go indoors if you have symptoms."},
    "hazardous": {"sensitive": "Sensitive groups: stay indoors and keep activity levels light. Follow tips for keeping particle levels low indoors.",
                  "everyone": "Everyone: avoid all physical activity outdoors."},
}
_PLAIN = {
    "good": "Air quality is satisfactory.",
    "moderate": "Air quality is acceptable for most people; unusually sensitive people may notice it.",
    "usg": "Sensitive groups may feel health effects; most other people are unlikely to.",
    "unhealthy": "Everyone may begin to feel health effects; sensitive groups more seriously.",
    "very_unhealthy": "Health alert: the risk of health effects is increased for everyone.",
    "hazardous": "Emergency conditions: everyone is more likely to be affected.",
}
_PM_SENSITIVE = ("People with heart or lung disease, older adults, children and teenagers. Outdoor workers and people with "
                 "lower incomes may have higher exposure.")

STANDARDS = {
    "us_epa_2024": {
        "id": "us_epa_2024",
        "name": "US EPA Air Quality Index",
        "version": "40 CFR 58 App. G (6 Mar 2024) · EPA-403/B-26-003 (May 2026)",
        "breakpoints": _EPA_2024,
        "statements": _PM_STATEMENTS,
        "sensitive_groups_pm": _PM_SENSITIVE,
        "reference": "https://www.airnow.gov/publications/air-quality-index/technical-assistance-document-for-reporting-the-daily-aqi/",
    },
}
DEFAULT_STANDARD = "us_epa_2024"

# Completeness: a 24-hour PM mean needs at least 18 of 24 hours (75%), an
# 8-hour mean at least 6 of 8 (75%). NowCast: 2 of the last 3 hours (TAD).
MIN_HOURS_24H = 18
MIN_HOURS_8H = 6

# µg/m³ -> ppb at 25 °C, 1 atm (24.45 L/mol), the US EPA reference condition.
_MOLAR = {"o3": 48.00, "no2": 46.0055, "so2": 64.066, "co": 28.010}


def get_standard(std_id=None):
    if std_id is None:
        try:
            from django.conf import settings
            std_id = getattr(settings, "AQI_STANDARD", DEFAULT_STANDARD)
        except Exception:
            std_id = DEFAULT_STANDARD
    if std_id not in STANDARDS:
        raise ValueError(f"unknown AQI standard {std_id!r}")
    return STANDARDS[std_id]


def _finite(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) and v >= 0 else None


def truncate(value, decimals):
    """Truncate (not round) to `decimals` places, as the standard prescribes.
    Decimal via repr so 35.4 does not become 35.3 through binary error."""
    return float(Decimal(repr(float(value))).quantize(Decimal(1).scaleb(-decimals), rounding=ROUND_DOWN))


def sub_index(key, conc, std_id=None):
    """AQI sub-index for a concentration in the standard's own unit and
    averaging period, or None when missing / not defined at that level.
    `key` is e.g. 'pm25_24h' or 'o3_8h'. Above the AQI-500 concentration the
    last segment is extrapolated (TAD Table 6, note 4)."""
    c = _finite(conc)
    if c is None:
        return None
    _, dec, rows = get_standard(std_id)["breakpoints"][key]
    c = truncate(c, dec)
    last = None
    for (ilo, ihi), row in zip(_AQI_RANGES, rows):
        if row is None:
            continue
        lo, hi = row
        last = (ilo, ihi, lo, hi)
        if c < lo:
            return None      # below the lowest level this averaging period defines
        if c <= hi:
            break
    else:
        if last is None or last[1] != 500:
            # Top of a truncated scale (8-h O3, 1-h SO2): the caller must use
            # the companion averaging period for anything higher.
            return None
    ilo, ihi, lo, hi = last
    aqi = (ihi - ilo) / (hi - lo) * (c - lo) + ilo
    return int(Decimal(repr(aqi)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def category(aqi):
    """Category key for an AQI value (None -> None)."""
    if aqi is None:
        return None
    for key, _, _, hi, _ in CATEGORIES:
        if hi is None or aqi <= hi:
            return key
    return CATEGORY_KEYS[-1]


def label(key):
    return next((c[1] for c in CATEGORIES if c[0] == key), None)


def overall(subs):
    """(AQI, dominant pollutant) = the highest valid sub-index of {pollutant:
    sub-index}. Never an average; (None, None) when nothing is valid."""
    valid = {k: v for k, v in subs.items() if v is not None}
    if not valid:
        return None, None
    dom = max(valid, key=valid.get)
    return valid[dom], dom


def nowcast_pm(hourly):
    """EPA PM NowCast concentration from up to 12 hourly values, most recent
    LAST (None = missing). Needs 2 of the last 3 hours. Returns µg/m³ or None."""
    vals = [_finite(v) for v in list(hourly)[-12:]]
    if sum(v is not None for v in vals[-3:]) < 2:
        return None
    present = [v for v in vals if v is not None]
    hi = max(present)
    w = 1.0 if hi == 0 else max(0.5, min(1.0, 1 - (hi - min(present)) / hi))
    num = den = 0.0
    for ago, v in enumerate(reversed(vals)):
        if v is not None:
            f = w ** ago
            num += f * v
            den += f
    return num / den


def mean_24h(hourly):
    """Mean of one calendar day's hourly values, or None below 18 valid hours."""
    vals = [v for v in (_finite(x) for x in hourly) if v is not None]
    return sum(vals) / len(vals) if len(vals) >= MIN_HOURS_24H else None


def max_1h(hourly):
    vals = [v for v in (_finite(x) for x in hourly) if v is not None]
    return max(vals) if len(vals) >= MIN_HOURS_24H else None


def max_8h(hourly):
    """Highest 8-hour running mean in the day (each needs 6 of 8 hours)."""
    vals = [_finite(x) for x in hourly]
    best = None
    for i in range(0, max(len(vals) - 7, 0)):
        w = [v for v in vals[i:i + 8] if v is not None]
        if len(w) >= MIN_HOURS_8H:
            m = sum(w) / len(w)
            best = m if best is None or m > best else best
    return best


def to_ppb(pollutant, ugm3):
    v = _finite(ugm3)
    return None if v is None else v * 24.45 / _MOLAR[pollutant]


def daily_subindices(day, std_id=None):
    """Sub-indices for one day of hourly µg/m³ series {pm25, pm10, o3, no2,
    so2, co}, each with its own averaging period:
      PM 24-h mean · O3 max 8-h (and 1-h where defined) · CO max 8-h ·
      SO2 max 1-h (24-h at 305 ppb and above) · NO2 max 1-h.
    Returns {pollutant: {"aqi", "conc", "unit", "avg"}} (aqi None if not valid)."""
    out = {}

    def put(p, aqi, conc, unit, avg):
        out[p] = {"aqi": aqi, "conc": None if conc is None else round(conc, 1 if unit != "ppm" else 3), "unit": unit, "avg": avg}

    for p in ("pm25", "pm10"):
        if p in day:
            m = mean_24h(day[p])
            put(p, sub_index(f"{p}_24h", m, std_id), m, "µg/m³", "24-h mean")
    if "o3" in day:
        m8, m1 = max_8h(day["o3"]), max_1h(day["o3"])
        p8 = None if m8 is None else to_ppb("o3", m8) / 1000.0
        p1 = None if m1 is None else to_ppb("o3", m1) / 1000.0
        subs = [s for s in (sub_index("o3_8h", p8, std_id), sub_index("o3_1h", p1, std_id)) if s is not None]
        put("o3", max(subs) if subs else None, p8, "ppm", "max 8-h mean")
    if "co" in day:
        m8 = max_8h(day["co"])
        ppm = None if m8 is None else to_ppb("co", m8) / 1000.0
        put("co", sub_index("co_8h", ppm, std_id), ppm, "ppm", "max 8-h mean")
    if "no2" in day:
        m = max_1h(day["no2"])
        ppb = None if m is None else to_ppb("no2", m)
        put("no2", sub_index("no2_1h", ppb, std_id), ppb, "ppb", "max 1-h")
    if "so2" in day:
        m1, m24 = max_1h(day["so2"]), mean_24h(day["so2"])
        p1 = None if m1 is None else to_ppb("so2", m1)
        p24 = None if m24 is None else to_ppb("so2", m24)
        s = sub_index("so2_24h", p24, std_id)
        if s is None and p1 is not None:
            # TAD p.16: 1-h >= 305 ppb with a 24-h mean below it is fixed at 200.
            s = 200 if truncate(p1, 0) >= 305 else sub_index("so2_1h", p1, std_id)
        put("so2", s, p1, "ppb", "max 1-h")
    return out


def describe(std_id=None, approved=False, advice_approved=False):
    """The standard as data, for the API, the briefing and the report."""
    s = get_standard(std_id)
    cats = []
    pm = s["breakpoints"]["pm25_24h"][2]
    for i, (key, lab, lo, hi, color) in enumerate(CATEGORIES):
        st = s["statements"].get(key, {})
        cats.append({"key": key, "label": lab, "lo": lo, "hi": hi, "color": color, "meaning": _PLAIN[key],
                     "advice_sensitive": st.get("sensitive"), "advice_everyone": st.get("everyone"),
                     "pm25_24h": [pm[i][0], pm[i][1] if i < 5 else None]})
    return {
        "id": s["id"], "name": s["name"], "version": s["version"], "reference": s["reference"],
        "approved": bool(approved), "advice_approved": bool(advice_approved), "categories": cats,
        "sensitive_groups_pm": s["sensitive_groups_pm"],
        "min_hours_24h": MIN_HOURS_24H, "min_hours_8h": MIN_HOURS_8H,
        "breakpoints": {k: {"unit": u, "truncate_decimals": d, "rows": [list(r) if r else None for r in rows]}
                        for k, (u, d, rows) in s["breakpoints"].items()},
    }
