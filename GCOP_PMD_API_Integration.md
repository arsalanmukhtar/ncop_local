# GCOP PMD / FFD Weather & Flood API — Plugin Integration Guide

**Audience:** an AI agent or developer integrating these endpoints as external "plugin" tools into another platform (chatbot, GPT/Claude tool, dashboard, automation pipeline).

**Source system:** GCOP (Global Common Operating Picture), NDMA NEOC GIS Development Team. These 21 endpoints are served by a Django-Ninja backend and documented live at `{GCOP_BASE_URL}/ninja-docs/` (OpenAPI/Swagger UI) and `{GCOP_BASE_URL}/openapi.json` (machine-readable schema — pull this directly if your platform can ingest a raw OpenAPI spec instead of this document).

Three tag groups are covered here: **FFD Flood Forecasting**, **PMD Monitor**, **PMD NWFC**. All three are read-only `GET` endpoints returning JSON (mostly GeoJSON `FeatureCollection`s).

---

## 1. Prerequisites

| Requirement | Detail |
|---|---|
| **Authentication** | **None.** All 21 endpoints below are publicly accessible — no API key, session cookie, or bearer token required. (This is not true of every GCOP endpoint — some unrelated ones do require a logged-in session — but everything in this document does not.) |
| **Base URL** | `{GCOP_BASE_URL}` — substitute your deployment's actual host, e.g. `http://172.18.7.21:8000`, `http://127.0.0.1:8000`, or your production domain. Endpoints are **not** namespaced under `/api/` consistently — some are (`/api/pmd/...`), some are bare (`/get-ffd-waterlevels/`). Use the exact paths given below; do not assume a common prefix. |
| **CORS** | Wide open (`CORS_ALLOW_ALL_ORIGINS = True`). Any browser-based client on any origin can call these directly with `fetch()` — no proxy needed. |
| **Method** | All `GET`. No request body. Query-string parameters only, where noted. |
| **Response format** | `application/json`. Most are GeoJSON `FeatureCollection` (`type`, `features[]`, each `Feature` = `{type, geometry, properties}`). A few are plain JSON objects/lists (noted per-endpoint below). |
| **Rate limiting** | None enforced by GCOP itself. However, most endpoints proxy or scrape a slow/rate-limited upstream (PMD's internal monitor server, PMD's public website) and are **server-side cached** (TTL noted per endpoint, 1 min – 24 h). Calling more often than the TTL wastes your own round-trip for identical data — respect the cache window instead of polling faster. |
| **Timeouts** | Upstream scrapes can occasionally take several seconds on a cache miss (cold cache after TTL expiry). Set your HTTP client timeout to **≥15s** to avoid false negatives. |
| **Error shape** | On upstream failure, most endpoints degrade gracefully and return an **empty-but-valid** payload (e.g. `{"type":"FeatureCollection","count":0,"features":[]}`) with HTTP 200, rather than a 5xx. A few return `{"error": "..."}` with a 4xx/5xx status (noted below). **Always check `count`/`features.length` — don't assume a 200 means non-empty data.** |
| **Time zone** | Most human-readable timestamps are Pakistan Standard Time (PKT, UTC+5), e.g. `"22-Jul 06 PKT"`. Machine-readable `obs_time`/`date_time` fields are typically ISO-8601 without a timezone suffix — treat as PKT unless stated otherwise. |
| **Data provenance** | Ultimately Pakistan Meteorological Department (PMD) and its Flood Forecasting Division (FFD) — either scraped from public PMD web pages or proxied from PMD's internal "PMD Monitor" telemetry server. GCOP does not generate this data; it normalizes and caches it. Attribute PMD/FFD as the data source in any downstream product. |

### 1.1 Recommended client pattern (any language)

```
GET {GCOP_BASE_URL}<path>[?query]
Accept: application/json
```

```python
import requests

BASE = "http://172.18.7.21:8000"  # replace with your deployment
resp = requests.get(f"{BASE}/get-ffd-waterlevels/", timeout=15)
resp.raise_for_status()
data = resp.json()
for feature in data["features"]:
    print(feature["properties"]["name"], feature["properties"]["discharge"])
```

```javascript
const BASE = "http://172.18.7.21:8000";
const res = await fetch(`${BASE}/api/pmd/monitor/stations/`);
const data = await res.json();
console.log(data.count, "stations");
```

### 1.2 Universal data-quality gotchas

These apply across most endpoints in this doc — check for them regardless of which one you're consuming:

- **Sentinel/fault values.** Some upstream fields use out-of-range sentinels for "no reading" instead of `null` — most notably `9999.0`, `999.0`, `-9999.0`, `-999.0`, and float-rounded `INT32_MAX` artifacts (`~2147483.647`). GCOP's GLOF endpoint (`/api/pmd/monitor/glof-obs/`) already filters these server-side, but other raw-passthrough fields (e.g. `pre24` inside PMD Monitor city-forecast's embedded `fc` JSON) may still contain them — treat any of these literal values as "no data", not a real reading.
- **Nested JSON-as-string fields.** Because the transport is GeoJSON `properties` (a flat key→value map), some genuinely nested/array data is embedded as a **JSON string that must be parsed again**, not a native array/object. Known offenders: `gauges` and `lag_hours`/`from` (FFD waterlevels), `elements` (PMD Monitor GLOF), `fc` (PMD Monitor city-forecast — 12-step forecast array). Always `JSON.parse()` (or `json.loads()`) these fields before using them; do not `JSON.parse()` fields that are already native (most others).
- **`null` is meaningful, not missing.** A `null` water-level/flow/rain field usually means "this station has no such sensor" or "sensor produced no valid reading this cycle" — check the companion `connectivity`/`status`/`has_water_level_sensor` field before treating a `null` as an error.
- **Empty ≠ broken.** `"features": []` / `"count": 0` is a normal, valid response when nothing is currently active (e.g. no lightning in the last N hours, no monsoon warnings issued). Don't alert/retry on empty results alone.

---

## 2. FFD Flood Forecasting

> Live water levels and flood-routing chain (upstream point, lag hours) for FFD-monitored points. Source: Flood Forecasting Division, PMD (ffd.pmd.gov.pk).

### 2.1 `GET /get-ffd-waterlevels/`

River gauge stations across Pakistan — current discharge, water level, status, and (where available) the previous-year comparison and short-term forecast.

- **Params:** none.
- **Cache:** ~5 minutes (river state changes slowly; scraped from `ffd.pmd.gov.pk/river-state`).
- **Response:** GeoJSON `FeatureCollection`, one `Feature` per gauge, `geometry.type = "Point"`.

**Properties per feature:**

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Gauge/station name, e.g. `"Azad Pattan"` |
| `area_name` | string | River name, e.g. `"Jhelum River"` |
| `height` | string | Gauge datum height, e.g. `"501 m"` |
| `status` | string | `"NORMAL"` / `"LOW"` / `"MEDIUM"` / `"HIGH"` / `"EXCEPTIONALLY HIGH"` (FFD's flood-classification scale) |
| `discharge` | string | Current discharge, comma-formatted cusecs, e.g. `"49,500"` |
| `recording_time` | string | Human-readable PKT timestamp, e.g. `"22-Jul 06 PKT"` |
| `level` | string\|null | Absolute water level reading, where reported |
| `cyp_discharge`, `cyp_status`, `cyp_date` | string\|null | "Corresponding Year Previous" — same date last year, for comparison |
| `forecast_status`, `forecast_qual`, `forecast_quant` | string\|null | Short-term forecast, where FFD publishes one for this gauge |
| `gauges` | **JSON string** | Array of `{type: "INFLOW"|"OUTFLOW", discharge, trend, trend_icon, status}` — parse before use |
| `from` | array | Upstream routing point name(s) feeding this gauge (flood-routing chain) |
| `lag_hours` | array | Travel-time lag (hours) from each `from` point to this gauge — pairs positionally with `from` |

**Example (real, live):**
```json
{
  "type": "Feature",
  "properties": {
    "name": "Azad Pattan", "area_name": "Jhelum River", "height": "501 m",
    "status": "NORMAL", "discharge": "49,500", "recording_time": "22-Jul 06 PKT",
    "gauges": "[{\"type\":\"OUTFLOW\",\"discharge\":\"49,500\",\"trend\":\"Falling\",\"trend_icon\":\"down\",\"status\":\"NORMAL\"},{\"type\":\"INFLOW\",\"discharge\":\"49,500\",\"trend\":\"Falling\",\"trend_icon\":\"down\",\"status\":\"NORMAL\"}]",
    "from": [], "lag_hours": []
  },
  "geometry": { "type": "Point", "coordinates": [73.601, 33.731] }
}
```

**Use for:** flood early-warning dashboards, river discharge trend queries, "is river X rising" chat answers, routing/lag-time chain visualization.

### 2.2 `GET /get-ffd-rivers/`

River-basin outline polygons (for map context alongside the gauges above — not itself telemetry).

- **Params:** none. **Cache:** long-lived (static geometry).
- **Response:** GeoJSON `FeatureCollection` of `Polygon`/`MultiPolygon` features.
- **Properties:** `color` (hex string, suggested render color), `opacity` (float 0–1). No attribute data beyond styling — join spatially to the waterlevels endpoint above if you need per-basin discharge.

**Use for:** map backdrops only; not a data source for numeric queries.

### 2.3 `GET /get-ffd-bulletins/`

Flood bulletins and advisories (PDF document index), scraped from `ffd.pmd.gov.pk/bulletin`, merged and sorted newest-first.

- **Params:** none. **Cache:** 4 hours.
- **Response:** plain JSON object (**not** GeoJSON):

```json
{
  "source": "FFD Flood Forecasting Division (ffd.pmd.gov.pk)",
  "count": 31,
  "items": [
    {
      "id": "45",
      "kind": "Bulletin",
      "issued": "21 Jul 2026, 11:30",
      "title": "DAILY FLOOD BULLETIN 21-JUL-2026",
      "download_url": "https://ffd.pmd.gov.pk/bulletin/45/download"
    }
  ]
}
```

- `kind` is `"Bulletin"` or `"Advisory"` (both listing sources are merged into one array).
- `download_url` points directly at a PDF on `ffd.pmd.gov.pk` — fetch it yourself if you need the document body (GCOP does not proxy/extract bulletin PDF text; see §4 for the equivalent NWFC press-release text extractor, which is PMD-domain-only and won't accept an FFD URL).

**Use for:** "latest flood bulletin" lookups, listing recent advisories by date, surfacing a download link in a chat response.

---

## 3. PMD Monitor

> Live telemetry proxied from PMD's internal "PMD Monitor" system (`115.186.56.181:12304`) — SYNOP/METAR/AWS stations, early warnings, GLOF stations, lightning, monsoon, city forecasts, glacier lakes, forecast polygons. GCOP holds the upstream credentials server-side; none reach the client.

### 3.1 `GET /api/pmd/monitor/stations/`

Live observations from SYNOP, METAR, and AWS/FloodAWS stations network-wide.

- **Params:** none. **Cache:** 5 minutes.
- **Response:** GeoJSON `FeatureCollection`, `count` ≈ 250–280 stations.

**Properties:** `code`, `name`, `station_type` (`"synop"`\|`"metar"`\|`"aws"`\|`"floodaws"`), `date_time`, `temperature` (°C), `humidity` (%), `pressure` (hPa), `wind_speed` (m/s), `wind_direction` (°), `rain_1h`/`rain_6h`/`rain_24h` (mm), `visibility` (km), `status` (bool), and `warn_temp`/`warn_wind`/`warn_rain`/`warn_vis` — each `null` or one of `"blue"`/`"yellow"`/`"orange"`/`"red"` (active threshold-alert color for that channel, if any).

**Example:**
```json
{
  "code": "OPZB", "name": "ZHOB", "station_type": "metar",
  "date_time": "2026-07-02 12:00:00", "temperature": 35.0,
  "wind_speed": 2.0, "wind_direction": 230.0, "visibility": 60.0,
  "warn_vis": "orange"
}
```
**Use for:** current-conditions lookups by city/station, station-level alert status.

### 3.2 `GET /api/pmd/monitor/station-history/`

Time-series for a single station.

- **Params:** `code` (string, default `"41725"` — PMD 5-digit station code, **not** the ICAO code used above), `days` (int, 1–30, default 7), `data_type` (string, default `"synop"`).
- **Cache:** keyed by `(code, days, data_type)`.
- **Response:**
```json
{ "code": "41718", "days": 2, "data_type": "synop", "data": [ /* raw upstream rows, schema varies by data_type */ ] }
```
`data` can legitimately be `[]` if the station has no rows for the requested window — not an error.

**Use for:** trend charts ("has station X's rainfall been rising?"), historical comparisons. This is the endpoint to use for §6's charting example.

### 3.3 `GET /api/pmd/monitor/warnings/`

Active early-warning polygons, color-coded by severity.

- **Params:** `diag` (bool, default `false` — bypass cache for troubleshooting; do not use `diag=1` in production polling, it forces an uncached upstream hit every call).
- **Cache:** 2 minutes.
- **Response:** GeoJSON `FeatureCollection` of `Polygon`/`MultiPolygon` features, plus a `warnings_list` array (any warning rows that couldn't be geolocated to a polygon).

**Properties** (per polygon): `level` (`"blue"`\|`"yellow"`\|`"orange"`\|`"red"`\|`"gust"`\|`"thunderstorm"`), `element`/`element_label` (hazard type, e.g. `"TPE"`/`"Rainstorm"`), `area_km2`, `model`, `forecast_time`, `data_time`, `message` (free-text warning body).

**Use for:** "are there any active weather warnings near X" queries, severity-filtered alert feeds.

### 3.4 `GET /api/pmd/monitor/monsoon/`

Monsoon-season-specific warnings.

- **Params:** `warning_only` (bool, default `false` — filter to only warning-level rows).
- **Cache:** 5 minutes.
- **Response:** GeoJSON `FeatureCollection` + `raw` (rows that had no lat/lon to geolocate). Properties: `province`, `level`, `type`, `text`, `valid_time`, `rain_24h`, `rain_forecast`.

**Use for:** monsoon-specific alerting distinct from the general warnings feed above (§3.3) — narrower scope, same underlying alert concept.

### 3.5 `GET /api/pmd/monitor/glof-obs/`

GLOF (Glacial Lake Outburst Flood) monitoring network — ~250 stations (ARG/AWS/DG/WL-R types) reporting water level, discharge/flow, and rainfall.

- **Params:** none. **Cache:** 2 minutes.
- **Response:** GeoJSON `FeatureCollection`.

**Properties:** `id` (station id), `name`, `city`, `province`, `station_type`, `obs_time`, `water_level` (m), `water_level_rate` (m/10min), `flow` (m³/s), `cumulative_flow`, `flow_velocity` (m/s), `discharge_area` (m²), `rainfall` (mm), `rain_intensity` (mm/h), `temperature`/`water_temperature` (°C), `humidity` (%), `battery_voltage` (V), `battery_current`, `battery_low` (bool), `alert_level` (int: `0`=normal, `20`=watch, `40`=warning, `60`=emergency), `alert_label` (string form of the same), `stale` (bool — no reading in 48h+), `connectivity` (`"OK"`\|`"OFFLINE"`\|`"SENSOR_FAULT"`), `has_water_level_sensor` (bool), `elements` — **JSON string**, full per-sensor-channel readings array (parse before use).

```json
{
  "id": "960200", "name": "Rupal_AWS-H_1", "city": "Rupal", "station_type": "AWS-H",
  "obs_time": "2026-07-22T04:40:00", "alert_level": 40, "alert_label": "WARNING",
  "connectivity": "SENSOR_FAULT", "has_water_level_sensor": false,
  "elements": [ { "name": "Air Temperature Hukseflux", "val": null, "unit": "°C" } ]
}
```
**Use for:** GLOF risk monitoring, "is there a flood risk at glacier station X" queries, per-sensor diagnostic detail.

### 3.6 `GET /api/pmd/monitor/lightning/`

Recent lightning strikes.

- **Params:** `hours` (int, 1–48, default 1).
- **Cache:** 3 minutes.
- **Response:** `{"type":"FeatureCollection","source":"PMD Monitor Lightning","count":N,"window_hours":H,"features":[...]}`. Frequently `count: 0` — no active storms is the normal case.

### 3.7 `GET /api/pmd/monitor/city-forecast/`

12-period forecast for major cities from PMD Monitor.

- **Params:** none. **Cache:** 30 minutes.
- **Response:** GeoJSON `FeatureCollection`, one feature per city. Top-level properties (`temp`, `temp_max`, `temp_min`, `weather`, `wind_speed`, `wind_dir`, `precipitation`, `pressure`, `humidity`, `visibility`, `cloud_cover`) are the **current** reading. `fc` is a **JSON string** — parse it to get the full 12-step forecast array, each step shaped:
```json
{ "ft": "2026-07-26 20:00", "tem": 22.77, "tmax": 24.1, "tmin": 17.7, "rhu": 62.58,
  "wspd": 0.64, "wdir": "N", "wdesc": "Light Air (or Calm)", "pre": 0.0, "pre24": 0.1,
  "prs": 812.2, "vis": 19.69, "tcc": 2.17, "wx": "Clear" }
```
⚠️ `pre24` uses the `9999.0` sentinel for "no data" — see §1.2.

**Use for:** multi-day city forecast chat answers, "will it rain in Kabul on Thursday" type queries (note: covers regional cities, not Pakistan-only — the sample above is Kabul).

### 3.8 `GET /api/pmd/monitor/wfs-forecast/`

GeoServer WFS forecast polygons for Pakistan.

- **Params:** `prov_code` (string, optional — CQL filter on the `FIRST_PRO` field, e.g. `"5"` for a specific province).
- **Cache:** 1 hour.
- **Response:** raw GeoServer WFS GeoJSON passthrough — schema follows the upstream `FIRST_PRO`-keyed layer, not GCOP-normalized.

### 3.9 `GET /api/pmd/monitor/glacier-lakes/`

Static glacier lake inventory (2018–2021 satellite survey), Pakistan region.

- **Params:** none. **Cache:** 24 hours (static data — safe to cache aggressively client-side too).
- **Response:** GeoJSON `FeatureCollection`. Properties: `area_km2`, `elevation_m`, `region`, `lake_type`, `survey_date`.

### 3.10 `GET /api/pmd/public-forecast/`

Proxies PMD's own public daily-forecast + press-release APIs (`pmd.gov.pk`) — distinct from the NWFC scraper in §4 and from PMD Monitor above; this is PMD's separate public-facing API.

- **Params:** none. **Cache:** 30 minutes.
- **Response:** passthrough JSON from `pmd.gov.pk` — no credentials reach the client (proxied server-side).

### 3.11 `GET /api/pmd/monitor/debug/` — internal/diagnostic, do not integrate

Raw upstream probe for GCOP developers troubleshooting the PMD Monitor connection. Not part of the stable data contract — response shape is whatever the upstream returned verbatim, and the `path` param lets a caller hit *any* upstream PMD Monitor route. **Exclude this from any plugin/tool manifest** you build from this document; it's not intended for external consumption.

---

## 4. PMD NWFC

> Scraped from PMD's National Weather Forecasting Centre pages (`weather.gov.pk`) — observations, forecasts, rainfall/press-release reports, weekly outlook, record temperatures.

### 4.1 `GET /api/pmd/nwfc/observations/`

Live station observations (SYNOP-style), similar in spirit to §3.1 but from the NWFC source rather than PMD Monitor — cross-check against §3.1 for a second opinion on the same physical stations if needed.

- **Params:** none.
- **Response:** GeoJSON `FeatureCollection`. Properties: `id`, `code`, `name`, `province_id`, `temperature`, `humidity`, `pressure`, `wind_speed`, `wind_direction` (string, e.g. `"130"`), `dew_point`, `rain_3h`, `rain_24h`, `weather` (text description), `sea_level_pressure`, `max_temperature`.

### 4.2 `GET /api/pmd/nwfc/forecast/`

Daily city forecast scraped from PMD NWFC's forecast page.

- **Params:** none. **Cache:** 6 hours.

### 4.3 `GET /api/pmd/nwfc/reports/`

Daily rainfall PDF list + press-release PDF list.

- **Params:** none. **Cache:** 4 hours.
- Feed the returned PDF URLs into §4.5 to get extracted text (weather.gov.pk URLs only).

### 4.4 `GET /api/pmd/nwfc/weekly-outlook/`

Multi-day narrative weather outlook for Pakistan.

- **Params:** none.
- **Response:**
```json
{
  "source": "PMD NWFC", "issue_date": "...", "preamble": "",
  "days": [
    { "date": "21 July, 2026 Tuesday", "outlook": "Widespread intermittent rain-wind/thundershower is expected in..." }
  ]
}
```
**Use for:** "what's the weather outlook this week" summary answers — this is free-text prose per day, not structured numeric data; good for direct quoting in a chat response.

### 4.5 `GET /api/pmd/nwfc/press-release-text/`

Extracts and returns plain text from a PMD NWFC press-release **PDF**.

- **Params:** `url` (string, **required**). **Must start with `https://weather.gov.pk/`** — any other domain returns `400 {"error": "Only weather.gov.pk URLs are allowed."}`. Get candidate URLs from §4.3's output.
- **Cache:** 1 hour, keyed per URL.

### 4.6 `GET /api/pmd/nwfc/max-temperatures/`

Historical record maximum temperatures per station.

- **Params:** none. **Cache:** 24 hours.

### 4.7 `GET /api/pmd/nwfc/debug-station/` — internal/diagnostic, do not integrate

Same caveat as §3.11 — developer probe, not a stable contract. `code` param (default `"41643"`). Exclude from any external tool manifest.

---

## 5. Tool/Function Schemas (ready to paste into a plugin manifest)

Generic JSON-Schema function definitions for the **stable, non-debug** endpoints — compatible with OpenAI function-calling, Anthropic tool-use, and most agent frameworks with minor reshaping. `{GCOP_BASE_URL}` must be substituted at registration time.

```json
[
  {
    "name": "gcop_ffd_waterlevels",
    "description": "Get current river gauge water levels, discharge, and flood status across Pakistan from PMD's Flood Forecasting Division. No parameters.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/get-ffd-waterlevels/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_ffd_bulletins",
    "description": "List the most recent flood bulletins and advisories (PDF documents) issued by PMD's Flood Forecasting Division, newest first.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/get-ffd-bulletins/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_monitor_stations",
    "description": "Get live weather observations (temperature, wind, humidity, visibility, active alerts) from ~270 SYNOP/METAR/AWS stations across Pakistan.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/stations/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_station_history",
    "description": "Get historical time-series readings for one weather station over the last 1-30 days.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/station-history/",
    "parameters": {
      "type": "object",
      "properties": {
        "code": { "type": "string", "description": "PMD 5-digit station code, e.g. 41718" },
        "days": { "type": "integer", "minimum": 1, "maximum": 30, "default": 7 },
        "data_type": { "type": "string", "default": "synop" }
      },
      "required": []
    }
  },
  {
    "name": "gcop_pmd_warnings",
    "description": "Get active PMD early-warning zones (storms, heatwaves, fog, etc.) as colored severity polygons.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/warnings/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_glof_stations",
    "description": "Get live Glacial Lake Outburst Flood (GLOF) monitoring station readings: water level, discharge/flow, rainfall, and alert level.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/glof-obs/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_lightning",
    "description": "Get recent lightning strike locations in Pakistan within a configurable time window.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/lightning/",
    "parameters": {
      "type": "object",
      "properties": { "hours": { "type": "integer", "minimum": 1, "maximum": 48, "default": 1 } },
      "required": []
    }
  },
  {
    "name": "gcop_pmd_city_forecast",
    "description": "Get a 12-step weather forecast for major cities, including current conditions.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/monitor/city-forecast/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_weekly_outlook",
    "description": "Get PMD's multi-day narrative weather outlook for Pakistan, in prose form, day by day.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/nwfc/weekly-outlook/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "gcop_pmd_nwfc_observations",
    "description": "Get live weather station observations from PMD's National Weather Forecasting Centre.",
    "method": "GET",
    "url": "{GCOP_BASE_URL}/api/pmd/nwfc/observations/",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  }
]
```

(Add the remaining §3/§4 endpoints to this array following the same shape if your integration needs them — omitted here for brevity, not because they're unsupported.)

---

## 6. Charting & Report Integration

### 6.1 Reference implementation already in GCOP

GCOP's own "PMD Weather" report tab (`#wrp-tab-glof` in the weather-report panel, `showPmdWeatherReport()` / `_pmdDownloadWeatherReport()` in `gcop-i-map.js`) is a working reference implementation that consumes nearly every endpoint in this document in parallel (`Promise.allSettled`), then renders it into a combined HTML/CSV/PDF report with per-section tables. If you're building a similar "PMD weather report" surface on another platform, that function is the pattern to mirror: fetch all relevant endpoints concurrently, tolerate individual failures (a `Promise.allSettled` rejection for one endpoint shouldn't block rendering the others), and clearly label each section with its source endpoint and cache freshness.

### 6.2 Worked example: a station water-level/discharge trend chart

Using `/api/pmd/monitor/station-history/` (§3.2) to plot a time-series with Chart.js:

```javascript
async function renderPmdStationChart(canvasEl, stationCode, days = 7) {
  const res = await fetch(
    `${BASE}/api/pmd/monitor/station-history/?code=${stationCode}&days=${days}&data_type=synop`
  );
  const { data } = await res.json();
  if (!data.length) {
    canvasEl.replaceWith(document.createTextNode("No historical data for this station/window."));
    return;
  }

  // Shape depends on data_type — for synop rows, expect a timestamp field
  // (commonly `date_time`) plus the measured channel(s) requested upstream.
  const labels = data.map((row) => row.date_time ?? row.time ?? "");
  const values = data.map((row) => row.temperature ?? row.rain ?? row.value ?? null);

  new Chart(canvasEl, {
    type: "line",
    data: {
      labels,
      datasets: [{ label: `Station ${stationCode}`, data: values, borderColor: "#06b6d4", tension: 0.25 }],
    },
    options: { responsive: true, scales: { x: { ticks: { maxTicksLimit: 12 } } } },
  });
}
```

For a **discharge/flood chart** instead, poll `/get-ffd-waterlevels/` (§2.1) on an interval (respect the ~5 min cache — polling faster than that just re-serves the same cached snapshot) and plot `discharge` per gauge over time client-side, since that endpoint itself only returns the current snapshot, not history — you build the time-series by sampling it repeatedly and storing each poll's value.

### 6.3 If you want this built directly into GCOP's live report tab

This document is written for **external** integration. If instead you want an actual new chart added to GCOP's own existing `#wrp-tab-glof` report tab (a GCOP codebase change, not an external plugin), that's a separate, smaller task — say so explicitly and it can be implemented directly in `gcop-i-map.js` alongside the existing report-building functions.

---

## 7. Summary table (all 21 endpoints)

| # | Tag | Method | Path | Params | Cache |
|---|---|---|---|---|---|
| 1 | FFD | GET | `/get-ffd-waterlevels/` | — | 5 min |
| 2 | FFD | GET | `/get-ffd-rivers/` | — | long |
| 3 | FFD | GET | `/get-ffd-bulletins/` | — | 4 h |
| 4 | PMD Monitor | GET | `/api/pmd/monitor/stations/` | — | 5 min |
| 5 | PMD Monitor | GET | `/api/pmd/monitor/station-history/` | `code`, `days`, `data_type` | per-key |
| 6 | PMD Monitor | GET | `/api/pmd/monitor/warnings/` | `diag` | 2 min |
| 7 | PMD Monitor | GET | `/api/pmd/monitor/monsoon/` | `warning_only` | 5 min |
| 8 | PMD Monitor | GET | `/api/pmd/monitor/glof-obs/` | — | 2 min |
| 9 | PMD Monitor | GET | `/api/pmd/monitor/lightning/` | `hours` | 3 min |
| 10 | PMD Monitor | GET | `/api/pmd/monitor/city-forecast/` | — | 30 min |
| 11 | PMD Monitor | GET | `/api/pmd/monitor/wfs-forecast/` | `prov_code` | 1 h |
| 12 | PMD Monitor | GET | `/api/pmd/monitor/glacier-lakes/` | — | 24 h |
| 13 | PMD Monitor | GET | `/api/pmd/public-forecast/` | — | 30 min |
| 14 | PMD Monitor | GET | `/api/pmd/monitor/debug/` | `path` | — internal only |
| 15 | PMD NWFC | GET | `/api/pmd/nwfc/observations/` | — | — |
| 16 | PMD NWFC | GET | `/api/pmd/nwfc/forecast/` | — | 6 h |
| 17 | PMD NWFC | GET | `/api/pmd/nwfc/reports/` | — | 4 h |
| 18 | PMD NWFC | GET | `/api/pmd/nwfc/weekly-outlook/` | — | — |
| 19 | PMD NWFC | GET | `/api/pmd/nwfc/press-release-text/` | `url` (required) | 1 h/URL |
| 20 | PMD NWFC | GET | `/api/pmd/nwfc/max-temperatures/` | — | 24 h |
| 21 | PMD NWFC | GET | `/api/pmd/nwfc/debug-station/` | `code` | — internal only |

---

*Generated from the live GCOP OpenAPI schema and sampled live responses on 2026-07-22. Verify against `{GCOP_BASE_URL}/openapi.json` if integrating after a significant time gap, since cache TTLs and field sets are drawn from the current server implementation and may evolve.*
