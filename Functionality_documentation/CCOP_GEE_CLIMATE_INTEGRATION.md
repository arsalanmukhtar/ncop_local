# Google Earth Engine → CCOP: Climate Data, Visualization, Chatbot & Scenario Builder

**Audience:** engineers integrating Google Earth Engine (GEE) into **CCOP (Century
Common Operating Picture)** — a Django + Vite + Mapbox GL JS application — to
fetch, process, and visualise **climate‑change** data: climate‑change impacts,
climate projections, climate scenarios (sea‑level rise, global warming), and the
hazards climate change drives. The process must be automated and optimised, and
surfaced as (a) a **chatbot** and (b) a **scenario builder**.

**Source of truth for the reference pattern:** the existing, working GEE
integration in **NCOP** (`ncop_v1/ncop_local`). This document first documents
exactly how NCOP does it (files, endpoints, code, auth), then shows how to build
the equivalent for CCOP from scratch and tailor it for climate.

> Nothing in this document is speculative about NCOP — every NCOP reference is a
> real file/line/endpoint read from the codebase.

---

## 0. TL;DR — the shape of the whole thing

```
Browser (Vite bundle, Mapbox GL JS)
  │  user types "sea level rise 2100 in Karachi under SSP5-8.5"
  ▼
POST /api/gee/query/                     ← Django view
  │  1. LLM parses intent → {variable, scenario, horizon, aoi, statistic}
  │  2. Resolve AOI bbox, dataset config from the CLIMATE CATALOG
  │  3. Build an ee.Image server-side (filter → reduce → compute → clip)
  │  4. image.getMapId(vis)  → XYZ tile-template URL   (this is the key trick)
  │  5. Cache {params → tile_url} in Redis (GEE map IDs expire ~3 days)
  ▼
JSON { tile_url, legend, vis, stats, narrative, scenario_id }
  │
  ▼
map.addSource(id, { type:'raster', tiles:[tile_url] })
map.addLayer({ id, type:'raster', paint:{ 'raster-opacity':0.8 } })
```

GEE never streams rasters to the browser. It returns a **tile URL template**
(`https://earthengine.googleapis.com/v1/projects/<proj>/maps/<mapid>/tiles/{z}/{x}/{y}`)
that Mapbox GL treats as an ordinary XYZ raster source. All heavy computation
happens on Google's servers; CCOP only orchestrates and caches.

---

## 1. How GEE is integrated in NCOP today (the reference implementation)

All GEE code in NCOP lives in **one file**: `project/ncop_internal/views.py`
(section header `#------ GOOGLE EARTH ENGINE VIEWS HERE (ENHANCED) ------`, ~line
3405 onward). URLs are wired in `project/ncop_internal/urls.py`. The frontend
panel is in `frontend/src/modules/navigation-panel.js`.

### 1.1 Authentication (NCOP's model — and its weakness)

```python
# project/ncop_internal/views.py  (~line 3405)
import ee                                    # earthengine-api (installed: 1.7.1)

GEE_PROJECT_ID = getattr(settings, 'GEE_PROJECT_ID', 'flood-mapping-dashboard-471116')

def initialize_earth_engine():
    try:
        ee.Initialize(project=GEE_PROJECT_ID)   # <-- no explicit credentials
        print("[OK] Google Earth Engine Initialized Successfully")
        return True
    except Exception as e:
        print(f"[FAILED] GEE Initialization Failed: {e}")
        return False

GEE_INITIALIZED = initialize_earth_engine()   # runs at MODULE IMPORT TIME
```

- `GEE_PROJECT_ID` comes from `.env` → `project/ncop_project/settings/base.py`
  line 163: `GEE_PROJECT_ID = env("GEE_PROJECT_ID", default="flood-mapping-dashboard-471116")`.
- `ee.Initialize()` with **no credentials argument** falls back to a **persisted
  OAuth refresh token** at `~/.config/earthengine/credentials` (a 374‑byte file
  on the NCOP host) created once by running `earthengine authenticate` as the
  server user.
- **Weaknesses to fix in CCOP** (§7): (a) a personal OAuth token is not a
  deployable secret — it's tied to a human's Google account and can be revoked;
  (b) init runs at import time, outside any error boundary — a transient auth
  failure at boot leaves `GEE_INITIALIZED = False` and every endpoint 500s until
  restart; (c) `earthengine-api` is **not pinned** in `requirements.txt`.

### 1.2 The dataset catalog — `GEEDataCatalog`

A single class holding two dicts:

```python
class GEEDataCatalog:
    PAKISTAN_BOUNDS = [60.872, 23.634, 77.837, 37.097]
    LOCATIONS = {                              # 55+ named bboxes
        'pakistan': [60.5, 23.3, 77.9, 37.3],
        'karachi':  [66.8, 24.7, 67.4, 25.3],
        'indus_delta': [67.1, 23.4, 68.2, 24.7],
        # ...
    }
    DATASETS = {
        'sea_level_rise_2100': {
            'name': 'Sea Level Rise 2100 (Worst Case)',
            'collection': 'COMPOSITE',
            'compute': 'compute_slr_2100',          # string key → dispatched
            'vis': {'min': 0, 'max': 5,
                    'palette': ['ffffcc','a1dab4','41b6c4','2c7fb8','253494']},
            'type': 'susceptibility_flood',
            'priority': 6,
            'keywords': ['sea level rise 2100','coastal risk','climate projection',
                         'century projection','worst case','long-term impact'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=SLR+2100&palette=...&min=0&max=5',
            'description': 'Worst-case sea level rise projection (up to 5m) by 2100...',
            'supports_temporal': False,
            'semantic_context': {'scenario_type': 'worst-case',
                                 'use_cases': ['strategic planning','policy']},
        },
        # ~40 more entries: flood_sar_extent, flood_occurrence, active_fire_viirs,
        # urban_heat_island, lst_day, ndvi, ndsi_snow, aod_air_quality,
        # population_density, nightlights, dem_elevation, ...
    }
```

Each dataset entry is a **declarative config**: which EE collection, how to reduce
it to a single image (`compute`), how to colour it (`vis`), and enough metadata
(`keywords`, `description`, `priority`, `semantic_context`) for the matcher to
pick it from a free‑text query.

### 1.3 The NLU layer — `SemanticSearchHelper` (rule‑based, **no LLM**)

NCOP's GEE "chatbot" does **not** call an LLM. It scores every dataset against
the query:

```python
class SemanticSearchHelper:
    SYNONYM_MAP = {'sea level': ['ocean rise','coastal flooding','submersion'],
                   'temperature': ['heat','thermal','hot','cold','climate'], ...}
    CONTEXT_PATTERNS = {'future': ['projection','forecast','scenario','prediction'],
                        'historical': ['past','archive','frequency','occurrence'], ...}

    @classmethod
    def calculate_semantic_score(cls, query, dataset):
        score = 0
        for kw in dataset['keywords']:
            if kw in query.lower():
                score += 10 if len(kw.split()) > 1 else 5      # phrase > word
        for term in cls.expand_query(query):                   # synonym expansion
            for kw in dataset['keywords']:
                if term in kw or kw in term: score += 3
        for kw in dataset['keywords']:                         # fuzzy (typos)
            if SequenceMatcher(None, query.lower(), kw).ratio() > 0.7:
                score += int(similarity * 5)
        if 'susceptibility' in query and 'susceptibility' in dataset['type']:
            score += 8
        return score
```

`GEEDataCatalog.get_dataset(query)` returns `argmax(score × priority)`.
`get_location(query)` substring‑matches `LOCATIONS`. `extract_dates(message)`
recognises `"latest" / "yesterday" / "last week" / "last month"` and otherwise
defaults to the last 30 days.

**For CCOP, replace this whole layer with an LLM function‑call** (§5) — climate
queries carry structured parameters (scenario SSP, horizon year, baseline
period, statistic, threshold) that keyword scoring cannot reliably extract.

### 1.4 The compute → tile‑URL pipeline — `DynamicGEELayerView.generate_layer`

```python
def generate_layer(self, dataset_key, cfg, bbox, date_range, location_name):
    aoi = ee.Geometry.Rectangle(bbox)
    compute_func = cfg['compute']

    if compute_func == 'compute_slr_2100':
        img = EnhancedCompute.compute_slr_2100(aoi)
    elif compute_func == 'ahp_flood':
        img = AHPModels.compute_flood_susceptibility(aoi)
    else:
        # standard path: collection → filter → reduce → compute
        if cfg.get('time_filter') is False:
            col = ee.ImageCollection(cfg['collection']).filterBounds(aoi)
            image = col.mosaic()
        elif cfg['time_filter'] == 'latest':
            col = (ee.ImageCollection(cfg['collection'])
                     .filterBounds(aoi)
                     .sort('system:time_start', False).limit(30))
            image = col.median()
        else:
            col = (ee.ImageCollection(cfg['collection'])
                     .filterBounds(aoi).filterDate(date_range[0], date_range[1]))
            image = col.median()

        if not image.bandNames().getInfo():        # guard: empty collection
            raise Exception("No data for that period/area.")
        img = compute_func(image)                   # the lambda in the config

    clipped = img.clip(aoi)
    map_id = clipped.getMapId(cfg['vis'])           # <-- the key call
    return {'tile_url': map_id['tile_fetcher'].url_format}
```

`getMapId(vis)` asks Google to render the image with the given visualisation and
returns a `tile_fetcher.url_format` — an XYZ template string. That string is what
goes to Mapbox.

**Climate‑relevant compute helpers already in NCOP** (`EnhancedCompute`):

```python
@staticmethod
def compute_slr_2100(aoi):
    dem = ee.ImageCollection('COPERNICUS/DEM/GLO30_2024_1').select('DEM').mosaic().clip(aoi)
    slr_risk = dem.lt(5).multiply(5).subtract(dem).clamp(0, 5).rename('SLR_2100')
    coastal_mask = dem.lt(15).And(dem.gt(-5))
    return slr_risk.updateMask(coastal_mask)

@staticmethod
def compute_uhii(aoi, date_range):                  # urban heat island
    lst = (ee.ImageCollection('MODIS/061/MOD11A1').filterBounds(aoi)
             .filterDate(*date_range).mean().select('LST_Day_1km')
             .multiply(0.02).subtract(273.15).clip(aoi))
    # ... urban mask via S2 NDBI, rural baseline via percentile reducer ...
    return lst.subtract(ee.Image.constant(rural_temp)).rename('UHII')
```

### 1.5 The HTTP endpoints (`project/ncop_internal/urls.py`)

| Method & path | View | Purpose |
|---|---|---|
| `POST /api/gee/dynamic-layer/` | `DynamicGEELayerView` | free‑text message → one tile layer + legend + metadata + temporal config |
| `POST /api/gee/temporal-layer/` | `TemporalGEELayerView` | `{dataset_key, bbox, years[]}` → batch of `{year, tile_url}` for a time slider |
| `GET  /api/gee/catalog/` | `GEECatalogView` | full dataset catalog grouped by `type`, plus `initialized` flag |
| `GET  /api/gee/legend/` | `GenerateLegendView` | server‑drawn PNG legend strip (PIL) from `?palette=&min=&max=` |

Response shape from `dynamic-layer`:

```json
{
  "success": true,
  "layer_id": "gee-sea_level_rise_2100-1789022467",
  "tile_url": "https://earthengine.googleapis.com/v1/projects/.../tiles/{z}/{x}/{y}",
  "dataset": "Sea Level Rise 2100 (Worst Case)",
  "dataset_type": "susceptibility_flood",
  "location": "Karachi",
  "legend": "/api/gee/legend/?dataset=SLR+2100&palette=...&min=0&max=5",
  "visualization": {"min": 0, "max": 5, "palette": ["ffffcc", "..."]},
  "response": "🌊 **Sea Level Rise 2100** for **Karachi** ...",
  "description": "Worst-case sea level rise projection (up to 5m) by 2100 ...",
  "temporal": {"available": false, "dataset_key": "sea_level_rise_2100", "bbox": [...]}
}
```

### 1.6 The frontend panel (`frontend/src/modules/navigation-panel.js`)

- A floating `<div id="gee-chat-modal">` (the HTML you pasted) with
  `#geeChatInput`, `#geeChatSend`, `#geeChatMessages`.
- `#handleSemanticQuery(msg)` answers greetings/help/identity **client‑side**
  (no network) — quick canned strings.
- Otherwise:

```js
const r = await fetch(`${baseUrl}/api/gee/dynamic-layer/`, {
  method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ message }),
});
const data = await r.json();
this.#geeLayers.set(data.layer_id, { tile_url: data.tile_url, legend: data.legend,
                                     visualization: data.visualization, added: false });
this.#addLayerResponse(data);        // renders text + <img src=legend> + "Add to map" checkbox
```

- Toggling "Add to map":

```js
this.#map.addSource(layerId, { type: 'raster', tiles: [layerInfo.tile_url],
                               tileSize: 256, minzoom: 0, maxzoom: 22 });
this.#map.addLayer({ id: layerId, type: 'raster', source: layerId,
                     paint: { 'raster-opacity': 0.7 } });
this.#map.on('error', e => { /* map IDs expire after ~3 days → tell user to re-request */ });
```

- Temporal: if `data.temporal.available`, `#showTemporalDialog()` offers 5 evenly
  spaced years, POSTs them to `/api/gee/temporal-layer/`, adds every year's raster
  with `layout:{visibility:'none'}` (so tiles aren't fetched until shown), then a
  slider flips `visibility` per year.

### 1.7 Known limitations in NCOP's implementation (design around these in CCOP)

1. **Rule‑based NLU** — brittle for structured climate queries.
2. **`getInfo()` / `getMapId()` are synchronous, blocking** the Django worker
   thread for the whole GEE round‑trip (1–15 s). No async, no queue.
3. **Init at import time**, no retry, no health re‑check.
4. **No caching** — every identical query recomputes and re‑issues a map ID.
5. **Map IDs expire (~3 days)** — surfaced only as a Mapbox tile error the user
   must react to.
6. **Personal OAuth credentials**, not a service account.
7. **One 8000‑line `views.py`** — the GEE code is ~1400 lines inside it.
8. **`earthengine-api` unpinned.**
9. **Blocking `.getInfo()` inside loops** (`TemporalGEELayerView.batch_generate_layers`
   calls `year_collection.size().getInfo()` per year).

---

## 2. Part A — GEE integration into CCOP from scratch

Target stack: **Django (backend) + Vite (frontend build) + Mapbox GL JS (map)**,
same as CCOP already is.

### Step 1 — Google Cloud project + Earth Engine registration

1. Create / pick a **Google Cloud project** (e.g. `ccop-climate-ee`).
   Console → *IAM & Admin → Create Project*. Note the **Project ID**.
2. Enable the **Earth Engine API**:
   `https://console.cloud.google.com/apis/library/earthengine.googleapis.com`
   → *Enable*.
3. Register the project for Earth Engine (one‑time, requires an EE account):
   `https://code.earthengine.google.com/register` → choose *Use with a Cloud
   project* → select `ccop-climate-ee` → pick **noncommercial** or a paid plan.
   Government/agency use generally qualifies for the free noncommercial tier;
   confirm at `https://earthengine.google.com/noncommercial/`.
4. (Optional but recommended) Enable **billing** on the project even for the free
   tier — some EE export/asset operations require it, and it unlocks higher
   concurrency quotas.

### Step 2 — Service account + JSON key (the production‑correct auth)

**Do not use `earthengine authenticate` for a server.** Use a service account.

1. Console → *IAM & Admin → Service Accounts → Create Service Account*.
   Name: `ccop-ee-runner`. ID: `ccop-ee-runner@ccop-climate-ee.iam.gserviceaccount.com`.
2. Grant it the role **Earth Engine Resource Viewer**
   (`roles/earthengine.viewer`) — enough to run computations and read the public
   data catalog. Add **Earth Engine Resource Writer** only if CCOP will create EE
   assets/exports.
3. *Keys → Add Key → Create new key → JSON* → download
   `ccop-ee-runner.json`. **Treat as a secret** (see Step 5).
4. Register the **service account** with Earth Engine:
   `https://code.earthengine.google.com/register` again, or via the EE
   *Service Accounts* page — add
   `ccop-ee-runner@ccop-climate-ee.iam.gserviceaccount.com` to the registered
   project so it may call the API.

### Step 3 — Python dependencies (pin them)

`requirements.txt` additions:

```
earthengine-api==1.7.1        # pin to a tested version; bump deliberately
google-auth==2.35.0           # transitively required, pin for reproducibility
google-cloud-storage==2.18.2  # only if you'll export COGs to GCS (Step 9 / §7)
redis==5.0.8                  # tile-URL cache
```

`pip install -r requirements.txt`. Verify: `python -c "import ee; print(ee.__version__)"`.

### Step 4 — The `gee` Django app

Create a dedicated app so GEE code is never again buried in one giant `views.py`.

```
python manage.py startapp gee_climate
```

```
project/gee_climate/
  __init__.py
  apps.py
  ee_client.py          # init + a resilient singleton
  catalog.py            # the CLIMATE dataset catalog (§4)
  compute.py            # climate compute helpers (§4)
  scenarios.py          # scenario-builder compute (§6)
  nlu.py                # LLM intent parser (§5)
  cache.py              # Redis tile-URL cache
  views.py              # thin HTTP layer
  urls.py
  models.py             # SavedScenario (§6.3)
  serializers.py
  tests/
```

**`ee_client.py` — resilient init (fixes NCOP limitations 3 & 6):**

```python
import json, logging, threading
import ee
from django.conf import settings

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_state = {"initialized": False, "last_error": None}

def _credentials():
    """Service-account creds from an env var (raw JSON) or a file path.
    Never falls back to a personal OAuth token in production."""
    raw = getattr(settings, "GEE_SERVICE_ACCOUNT_JSON", "") or ""
    path = getattr(settings, "GEE_SERVICE_ACCOUNT_FILE", "") or ""
    if raw.strip():
        info = json.loads(raw)
        return ee.ServiceAccountCredentials(info["client_email"], key_data=raw)
    if path:
        with open(path) as f:
            info = json.load(f)
        return ee.ServiceAccountCredentials(info["client_email"], key_file=path)
    raise RuntimeError("No GEE service-account credentials configured")

def ensure_initialized(force: bool = False) -> bool:
    """Idempotent, thread-safe, retryable. Call at the TOP of every view
    (cheap once initialized) instead of once at import time."""
    if _state["initialized"] and not force:
        return True
    with _lock:
        if _state["initialized"] and not force:
            return True
        try:
            ee.Initialize(
                credentials=_credentials(),
                project=settings.GEE_PROJECT_ID,
                opt_url="https://earthengine-highvolume.googleapis.com",  # see note
            )
            # a trivial round-trip proves auth + connectivity
            ee.Number(1).getInfo()
            _state.update(initialized=True, last_error=None)
            logger.info("GEE initialized (project=%s)", settings.GEE_PROJECT_ID)
        except Exception as e:                       # noqa: BLE001
            _state.update(initialized=False, last_error=str(e))
            logger.exception("GEE init failed")
    return _state["initialized"]

def health() -> dict:
    return dict(_state)
```

> **`earthengine-highvolume.googleapis.com`** is Google's endpoint tuned for many
> small tile/`getMapId` requests (higher concurrency, no per‑request quota
> tantrum). Use it for a tile server. Use the default endpoint for interactive
> analysis. It is a drop‑in `opt_url`.

**`apps.py` — warm up off the request path (mirrors NCOP's translate warm‑up):**

```python
from django.apps import AppConfig

class GeeClimateConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "gee_climate"

    def ready(self):
        import os, sys, threading
        if "runserver" in sys.argv and os.environ.get("RUN_MAIN") != "true":
            return                       # skip the autoreload watcher process
        from .ee_client import ensure_initialized
        threading.Timer(3.0, ensure_initialized).start()   # non-blocking head start
```

### Step 5 — Settings & secrets

`project/ccop_project/settings/base.py`:

```python
GEE_PROJECT_ID          = env("GEE_PROJECT_ID", default="ccop-climate-ee")
# Provide ONE of the following:
GEE_SERVICE_ACCOUNT_JSON = env("GEE_SERVICE_ACCOUNT_JSON", default="")   # raw JSON blob
GEE_SERVICE_ACCOUNT_FILE = env("GEE_SERVICE_ACCOUNT_FILE", default="")   # path to file
GEE_TILE_ENDPOINT        = env("GEE_TILE_ENDPOINT",
                               default="https://earthengine-highvolume.googleapis.com")
GEE_CACHE_TTL_SECONDS    = env.int("GEE_CACHE_TTL_SECONDS", default=60 * 60 * 36)  # < 3 days
REDIS_URL                = env("REDIS_URL", default="redis://127.0.0.1:6379/1")
LLM_PROVIDER             = env("LLM_PROVIDER", default="groq")    # groq | anthropic | openai
LLM_API_KEY              = env("LLM_API_KEY", default="")
LLM_MODEL                = env("LLM_MODEL", default="llama-3.3-70b-versatile")
```

`.env` (repo‑root, git‑ignored — CCOP already ignores `.env`):

```
GEE_PROJECT_ID=ccop-climate-ee
# Option A — mount the file, point at it (simplest for a single VM):
GEE_SERVICE_ACCOUNT_FILE=/etc/ccop/ee-service-account.json
# Option B — inline the JSON (best for Docker/K8s secrets; escape newlines):
# GEE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"ccop-climate-ee",...}
GEE_CACHE_TTL_SECONDS=129600
REDIS_URL=redis://127.0.0.1:6379/1
LLM_PROVIDER=groq
LLM_API_KEY=gsk_xxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=llama-3.3-70b-versatile
```

**Docker:** mount the key as a secret, never `COPY` it into the image:

```yaml
# docker-compose.yml
services:
  web:
    environment:
      - GEE_SERVICE_ACCOUNT_FILE=/run/secrets/ee_sa
    secrets: [ee_sa]
secrets:
  ee_sa:
    file: ./deploy/ee-service-account.json
```

**Kubernetes:** `kubectl create secret generic ee-sa --from-file=key.json=...`
then project it to a file or an env var.

### Step 6 — The climate dataset catalog

See **§4** for the full climate‑tailored catalog. The config *shape* is identical
to NCOP's `DATASETS` entry; the *contents* change to climate collections.

### Step 7 — Compute helpers

See **§4.6** and **§6.2**. Same pattern as NCOP's `EnhancedCompute` /
`AHPModels`: pure functions `f(aoi, params) -> ee.Image`.

### Step 8 — The tile endpoint

**`gee_climate/views.py`:**

```python
import json, time
from django.http import JsonResponse
from django.utils.decorators import method_decorator
from django.views import View
from django.views.decorators.csrf import csrf_exempt

from .ee_client import ensure_initialized, health
from .catalog import CLIMATE_CATALOG, resolve_location
from .compute import build_climate_image
from .nlu import parse_climate_query
from .cache import cached_tile_url

@method_decorator(csrf_exempt, name="dispatch")
class ClimateQueryView(View):
    """POST { message } OR { params:{...} } -> one raster tile layer."""

    def post(self, request):
        if not ensure_initialized():
            return JsonResponse({"error": "Earth Engine unavailable",
                                 "detail": health().get("last_error")}, status=503)
        body = json.loads(request.body or b"{}")

        params = body.get("params")
        narrative = None
        if params is None:
            message = (body.get("message") or "").strip()
            if not message:
                return JsonResponse({"error": "message or params required"}, status=400)
            parsed = parse_climate_query(message)           # LLM (§5)
            if parsed.get("kind") == "chat":                # small talk / help
                return JsonResponse({"success": True, "chat": parsed["reply"]})
            params = parsed["params"]
            narrative = parsed.get("narrative")

        cfg = CLIMATE_CATALOG.get(params["dataset"])
        if not cfg:
            return JsonResponse({"error": f"unknown dataset {params['dataset']!r}"}, status=400)
        aoi_name, bbox = resolve_location(params.get("location"))

        def _compute():
            image, stats, vis = build_climate_image(cfg, bbox, params)
            map_id = image.getMapId(vis)
            return {
                "tile_url": map_id["tile_fetcher"].url_format,
                "vis": vis, "stats": stats,
            }

        cache_key = json.dumps({"d": params["dataset"], "b": bbox, "p": params}, sort_keys=True)
        result = cached_tile_url(cache_key, _compute)       # Redis, TTL < 3 days

        return JsonResponse({
            "success": True,
            "layer_id": f"gee-{params['dataset']}-{int(time.time())}",
            "dataset": cfg["name"],
            "location": aoi_name,
            "tile_url": result["tile_url"],
            "vis": result["vis"],
            "stats": result["stats"],
            "legend": cfg.get("legend"),
            "narrative": narrative or cfg.get("description"),
            "params": params,
        })


class HealthView(View):
    def get(self, request):
        ok = ensure_initialized()
        return JsonResponse({"gee": health(), "ok": ok}, status=200 if ok else 503)
```

### Step 9 — Cache layer (fixes NCOP limitations 4 & 5)

**`gee_climate/cache.py`:**

```python
import json, time
import redis
from django.conf import settings

_r = redis.from_url(settings.REDIS_URL, decode_responses=True)

def cached_tile_url(key: str, compute):
    """compute() -> dict with 'tile_url'. Cache the whole dict.
    TTL is deliberately shorter than GEE's ~3-day map-ID expiry so a
    stale URL is refreshed before Mapbox ever sees a dead tile."""
    hit = _r.get(key)
    if hit:
        return json.loads(hit)
    val = compute()
    val["_cached_at"] = int(time.time())
    _r.set(key, json.dumps(val), ex=settings.GEE_CACHE_TTL_SECONDS)
    return val

def invalidate(prefix: str = ""):
    for k in _r.scan_iter(f"{prefix}*"):
        _r.delete(k)
```

For an extra safety net, add a `/api/gee/refresh/<layer_id>/` endpoint the
frontend calls on a Mapbox `error` event to force `cached_tile_url(..., force=True)`.

### Step 10 — URL wiring

**`gee_climate/urls.py`:**

```python
from django.urls import path
from .views import ClimateQueryView, HealthView
from .scenario_views import ScenarioBuildView, ScenarioListView, ScenarioDetailView
from .catalog_views import CatalogView, LegendView

urlpatterns = [
    path("api/gee/query/",            ClimateQueryView.as_view(),   name="gee-query"),
    path("api/gee/catalog/",          CatalogView.as_view(),        name="gee-catalog"),
    path("api/gee/legend/",           LegendView.as_view(),         name="gee-legend"),
    path("api/gee/health/",           HealthView.as_view(),         name="gee-health"),
    path("api/gee/scenario/build/",   ScenarioBuildView.as_view(),  name="gee-scenario-build"),
    path("api/gee/scenario/",         ScenarioListView.as_view(),   name="gee-scenario-list"),
    path("api/gee/scenario/<uuid:pk>/", ScenarioDetailView.as_view(), name="gee-scenario-detail"),
]
```

`project/ccop_project/urls.py`: `path("", include("gee_climate.urls"))`.

### Step 11 — Frontend chat panel module (Vite)

**`frontend/src/modules/gee-climate-chat.js`** — a self‑contained ES module,
same style as NCOP's panel but leaner:

```js
import { addRasterLayer, removeRasterLayer } from "./gee-map-layers.js";

const API = "/api/gee";

export class GeeClimateChat {
  #map; #root; #messages; #input; #layers = new Map();

  constructor(map, mountEl) {
    this.#map = map;
    this.#root = mountEl;
    this.#render();
    this.#wire();
  }

  #render() {
    this.#root.innerHTML = `
      <div class="gee-chat-header">
        <span>Climate Data Assistant</span>
        <button data-role="close" aria-label="Close">&times;</button>
      </div>
      <div class="gee-chat-messages" data-role="messages"></div>
      <div class="gee-chat-input-wrapper">
        <input type="text" data-role="input" placeholder="e.g. mean warming in Punjab by 2050 under SSP2-4.5" />
        <button data-role="send">Send</button>
      </div>`;
    this.#messages = this.#root.querySelector('[data-role="messages"]');
    this.#input = this.#root.querySelector('[data-role="input"]');
    this.#addMsg("assistant",
      "Ask me for climate layers:\n• \"Sea level rise 2100 in Karachi (SSP5-8.5)\"\n" +
      "• \"Days above 40°C in Sindh, 2040s vs 1995–2014\"\n" +
      "• \"Rainfall change over the Indus basin by 2070\"");
  }

  #wire() {
    this.#root.querySelector('[data-role="send"]').onclick = () => this.#submit();
    this.#input.addEventListener("keydown", e => { if (e.key === "Enter") this.#submit(); });
    this.#root.querySelector('[data-role="close"]').onclick =
      () => { this.#root.style.display = "none"; };
  }

  async #submit() {
    const message = this.#input.value.trim();
    if (!message) return;
    this.#addMsg("user", message);
    this.#input.value = "";
    const loading = this.#addMsg("assistant", "Building layer…", true);

    try {
      const res = await fetch(`${API}/query/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      loading.remove();

      if (data.chat) { this.#addMsg("assistant", data.chat); return; }
      if (!data.success) { this.#addMsg("assistant", data.error || "Something went wrong."); return; }

      this.#layers.set(data.layer_id, { ...data, added: false });
      this.#addLayerCard(data);
    } catch (err) {
      loading.remove();
      this.#addMsg("assistant", `Network error: ${err.message}`);
    }
  }

  #addLayerCard(data) {
    const el = document.createElement("div");
    el.className = "gee-chat-message gee-chat-assistant gee-layer-card";
    el.innerHTML = `
      <div class="gee-narrative">${escapeHtml(data.narrative || data.dataset)}</div>
      ${data.legend ? `<img class="gee-legend" src="${data.legend}" alt="legend" />` : ""}
      ${data.stats ? `<div class="gee-stats">${statLine(data.stats)}</div>` : ""}
      <label class="gee-toggle">
        <input type="checkbox" data-layer="${data.layer_id}" /> Add to map
      </label>
      <button class="gee-scenario-link" data-layer="${data.layer_id}">Open in Scenario Builder →</button>`;
    el.querySelector('input[type="checkbox"]').addEventListener("change", e => {
      const rec = this.#layers.get(data.layer_id);
      if (e.target.checked) { addRasterLayer(this.#map, data.layer_id, rec.tile_url); rec.added = true; }
      else { removeRasterLayer(this.#map, data.layer_id); rec.added = false; }
    });
    el.querySelector(".gee-scenario-link").addEventListener("click",
      () => window.dispatchEvent(new CustomEvent("ccop:open-scenario", { detail: data.params })));
    this.#messages.appendChild(el);
    this.#messages.scrollTop = this.#messages.scrollHeight;
  }

  #addMsg(role, text, transient = false) {
    const el = document.createElement("div");
    el.className = `gee-chat-message gee-chat-${role}`;
    el.textContent = text;
    if (transient) el.dataset.transient = "1";
    this.#messages.appendChild(el);
    this.#messages.scrollTop = this.#messages.scrollHeight;
    return el;
  }
}

const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const statLine = s => Object.entries(s).map(([k, v]) => `${k}: <b>${v}</b>`).join(" · ");
```

### Step 12 — Frontend: GEE raster layers on Mapbox GL

**`frontend/src/modules/gee-map-layers.js`:**

```js
const RASTER_BEFORE_ID = undefined;  // or an existing layer id to insert beneath labels

export function addRasterLayer(map, id, tileUrl, opts = {}) {
  removeRasterLayer(map, id);
  map.addSource(id, {
    type: "raster",
    tiles: [tileUrl],
    tileSize: 256,
    minzoom: 0,
    maxzoom: 22,
    attribution: "Google Earth Engine",
  });
  map.addLayer({
    id,
    type: "raster",
    source: id,
    paint: {
      "raster-opacity": opts.opacity ?? 0.85,
      "raster-fade-duration": 0,
      "raster-resampling": "nearest",   // categorical/scenario rasters: no blur
    },
  }, opts.before ?? RASTER_BEFORE_ID);

  // Dead-tile detection → ask the backend for a fresh map ID
  const onError = (e) => {
    if (e.sourceId === id) {
      map.off("error", onError);
      fetch(`/api/gee/refresh/${encodeURIComponent(id)}/`, { method: "POST" })
        .then(r => r.json())
        .then(d => { if (d.tile_url) { removeRasterLayer(map, id); addRasterLayer(map, id, d.tile_url, opts); } });
    }
  };
  map.on("error", onError);
}

export function removeRasterLayer(map, id) {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
}

export function setRasterOpacity(map, id, value) {
  if (map.getLayer(id)) map.setPaintProperty(id, "raster-opacity", value);
}
```

Mounting the panel (wherever CCOP builds its right‑rail):

```js
import { GeeClimateChat } from "./modules/gee-climate-chat.js";
const panel = document.getElementById("gee-chat-modal");
new GeeClimateChat(window.map, panel);
```

---

## 3. Part B — Tailoring the catalog for climate change

The mechanism (config → filter → reduce → compute → `getMapId` → tile) is
unchanged. Only the **collections** and **compute functions** change. Below are
the GEE collections worth wiring, grouped by climate use case. All are in the
public Earth Engine Data Catalog (`https://developers.google.com/earth-engine/datasets`).

### 3.1 Observed / recent climate (reanalysis & satellite)

| Concept | EE collection ID | Key bands | Notes |
|---|---|---|---|
| Temperature (2 m), reanalysis | `ECMWF/ERA5_LAND/DAILY_AGGR` | `temperature_2m`, `temperature_2m_max`, `temperature_2m_min` | 1950–present, ~9 km, daily. The workhorse for observed warming. |
| Temperature (monthly) | `ECMWF/ERA5_LAND/MONTHLY_AGGR` | same | Cheaper for long climatologies. |
| Precipitation (satellite) | `UCSB-CHG/CHIRPS/DAILY` | `precipitation` | 1981–present, ~5 km, land only, good for South Asia. |
| Land Surface Temperature | `MODIS/061/MOD11A2` | `LST_Day_1km` (×0.02 − 273.15 → °C) | 8‑day, 2000–present. Already used in NCOP (`compute_uhii`). |
| Sea surface temperature | `NOAA/CDR/OISST/V2_1` | `sst` | Marine heat, cyclone potential. |
| Sea level anomaly (altimetry) | `NASA/SSH/REF/JPL/V2` or `HYCOM/*` | `ssha` | Observed sea‑level trend near the coast. |
| Snow cover / SWE | `MODIS/061/MOD10A1` (`NDSI_Snow_Cover`), `NASA/GLDAS/V022/CLSM/G025/DA1D` (`SWE_inst`) | — | Cryosphere loss over the Karakoram/HKH. |
| Drought (SPEI/PDSI) | `GRIDMET/DROUGHT` (US) / compute SPI from CHIRPS | `spi90d`, `pdsi` | For non‑US regions compute SPI from CHIRPS anomalies. |
| Vegetation stress | `MODIS/061/MOD13Q1` | `NDVI` | Climate impact proxy on agriculture. |
| GHG columns | `COPERNICUS/S5P/OFFL/L3_CO2` (XCO₂ limited), `EDGAR/*` emissions grids | — | Emissions context, not concentration trends. |

### 3.2 Climate **projections** — the core of CCOP

**Primary dataset: `NASA/GDDP-CMIP6`** (NEX‑GDDP‑CMIP6). Downscaled, bias‑adjusted
CMIP6 to ~25 km global, **daily**, 1950–2100.

- **Bands:** `tas` (mean temp, K), `tasmax`, `tasmin`, `pr` (precip flux,
  kg m⁻² s⁻¹ → ×86400 for mm/day), `hurs`, `huss`, `rlds`, `rsds`, `sfcWind`.
- **Image properties to filter on:**
  - `model` — e.g. `ACCESS-CM2`, `CanESM5`, `MIROC6`, `MPI-ESM1-2-HR`,
    `EC-Earth3`, `GFDL-ESM4`, `INM-CM5-0`, … (35 models). Use a fixed
    **ensemble** of ~8–10 for stability.
  - `scenario` — `historical`, `ssp126`, `ssp245`, `ssp370`, `ssp585`.
  - `system:time_start` — daily timestamp.
- **The canonical projection query** (mean warming, future period vs baseline):

```python
def cmip6_delta(aoi, variable="tas", scenario="ssp245",
                baseline=("1995-01-01", "2015-01-01"),
                future=("2040-01-01", "2060-01-01"),
                models=None):
    col = ee.ImageCollection("NASA/GDDP-CMIP6").select(variable)
    models = models or ["ACCESS-CM2","CanESM5","EC-Earth3","GFDL-ESM4",
                        "INM-CM5-0","MIROC6","MPI-ESM1-2-HR","MRI-ESM2-0"]
    col = col.filter(ee.Filter.inList("model", models))

    hist = (col.filter(ee.Filter.eq("scenario", "historical"))
               .filterDate(*baseline).mean())
    futr = (col.filter(ee.Filter.eq("scenario", scenario))
               .filterDate(*future).mean())

    delta = futr.subtract(hist)                       # K for tas; scale pr below
    if variable == "pr":
        # fractional change in %:
        delta = futr.subtract(hist).divide(hist).multiply(100).rename("pr_pct_change")
    return delta.clip(aoi)
```

- **Exceedance / threshold indices** (e.g. "days above 40 °C per year in the
  2050s"):

```python
def cmip6_hot_days(aoi, scenario="ssp585", period=("2045-01-01","2056-01-01"),
                   threshold_c=40, models=None):
    col = (ee.ImageCollection("NASA/GDDP-CMIP6").select("tasmax")
             .filter(ee.Filter.eq("scenario", scenario))
             .filter(ee.Filter.inList("model", models or _DEFAULT_MODELS))
             .filterDate(*period))
    thr_k = threshold_c + 273.15
    # per-model annual count, then ensemble mean
    years = ee.List.sequence(int(period[0][:4]), int(period[1][:4]) - 1)
    def per_year(y):
        y = ee.Number(y)
        yr = col.filter(ee.Filter.calendarRange(y, y, "year"))
        return yr.map(lambda img: img.gt(thr_k)).sum().rename("hot_days")
    annual = ee.ImageCollection(years.map(per_year))
    return annual.mean().clip(aoi)          # mean hot-days/year over the period
```

- **Model spread / confidence** — return the ensemble **standard deviation**
  alongside the mean so the UI can show agreement:

```python
stack = ee.ImageCollection(per_model_images)     # one image per model
mean_img = stack.mean()
std_img  = stack.reduce(ee.Reducer.stdDev())
```

**Secondary:** `ECMWF/CAMS/NRT` (aerosol/air‑quality nowcast, not projection),
`IPCC/AR6/*` if/when Google publishes gridded AR6 atlas layers.

### 3.3 Sea‑level rise

NCOP already ships `compute_slr_2050` / `compute_slr_2100` — a simple **bathtub
inundation** model on Copernicus GLO‑30 DEM. Keep that as the fast default, and
add a parameterised version driven by an actual SLR value:

```python
def slr_inundation(aoi, rise_m=1.0, dem_id="COPERNICUS/DEM/GLO30_2024_1"):
    dem = ee.ImageCollection(dem_id).select("DEM").mosaic().clip(aoi)
    # connected-to-ocean bathtub: cells at/below rise_m AND hydrologically
    # connected to the sea (approximate with a coastal buffer + cumulative cost)
    below = dem.lte(rise_m)
    ocean = ee.Image("NASA/OCEANDATA/MODIS-Aqua/L3SMI").select("chlor_a").gt(0).unmask(0)
    # simple approximation — for production use a real connectivity fill:
    inundation = below.selfMask().rename("inundation_depth_m") \
                      .where(below, ee.Image(rise_m).subtract(dem).clamp(0, rise_m))
    return inundation.clip(aoi)
```

Feed `rise_m` from a scenario: e.g. IPCC AR6 medium‑confidence global mean
SLR by 2100 is ~0.4–0.8 m (SSP2‑4.5) to ~0.6–1.0 m (SSP5‑8.5), with a
low‑confidence high‑end near 2 m. Expose those as scenario presets (§6).

### 3.4 Global warming / temperature anomaly

```python
def warming_since_baseline(aoi, target_year=2050, scenario="ssp245", models=None):
    # 20-yr window centred on target_year vs 1850–1900 pre-industrial proxy
    # (NEX-GDDP historical starts 1950; use 1951–1980 as the practical baseline
    #  and add the known ~0.3–0.5 K 1850–1900→1951–1980 offset if you need
    #  "degrees above pre-industrial")
    base = ("1951-01-01", "1981-01-01")
    lo, hi = f"{target_year-10}-01-01", f"{target_year+10}-01-01"
    return cmip6_delta(aoi, "tas", scenario, base, (lo, hi), models)
```

### 3.5 Climate‑change‑driven hazards (reuse NCOP's AHP pattern, swap inputs)

NCOP's `AHPModels.compute_flood_susceptibility` etc. already combine DEM, slope,
rainfall, land cover into a weighted index. For CCOP, build **future‑forced**
versions: same weights, but the *rainfall* / *temperature* layer is a CMIP6
projection instead of recent CHIRPS.

| Hazard | Climate forcing to swap in |
|---|---|
| Pluvial/flash flood | CMIP6 `pr` p95 or Rx1day (annual max 1‑day precip) for the horizon |
| Riverine flood | Basin‑integrated CMIP6 `pr` seasonal totals |
| Drought / water stress | CMIP6 SPEI (needs `pr` and PET from `tas` + `rsds`) |
| Heat stress | CMIP6 `tasmax` days > threshold, or WBGT proxy |
| Wildfire | CMIP6 `tasmax` + `hurs` + `sfcWind` → Fire Weather Index proxy |
| GLOF (glacier lake outburst) | Snow/ice loss trend (MODIS NDSI slope) + warming |
| Coastal | SLR value (§3.3) + storm‑surge DEM buffer |

### 3.6 The climate catalog config template

```python
# gee_climate/catalog.py
CLIMATE_CATALOG = {
    "warming_2050_ssp245": {
        "name": "Projected Warming by 2050 (SSP2-4.5)",
        "family": "projection",
        "compute": "warming_since_baseline",
        "compute_params": {"target_year": 2050, "scenario": "ssp245"},
        "vis": {"min": 0.5, "max": 4.0,
                "palette": ["#ffffb2","#fecc5c","#fd8d3c","#f03b20","#bd0026"]},
        "unit": "°C",
        "legend": "/api/gee/legend/?dataset=Warming+2050&min=0.5&max=4&palette=ffffb2,fd8d3c,bd0026",
        "description": "Ensemble-mean 2 m air-temperature change, 2040–2060 minus "
                       "1951–1980, from 8 bias-adjusted CMIP6 models under SSP2-4.5.",
        "keywords": ["warming","temperature rise","global warming","heat","2050",
                     "ssp245","climate projection"],
        "supports_scenario_axes": ["scenario", "horizon"],   # what the builder can vary
        "supports_temporal": True,
        "temporal_range": "decadal", "temporal_start_year": 2020, "temporal_end_year": 2100,
        "confidence_layer": True,     # also return ensemble stdDev
    },
    "slr_inundation": {
        "name": "Sea-Level-Rise Inundation",
        "family": "scenario",
        "compute": "slr_inundation",
        "compute_params": {"rise_m": 1.0},
        "vis": {"min": 0, "max": 3,
                "palette": ["#c7e9b4","#7fcdbb","#41b6c4","#2c7fb8","#253494"]},
        "unit": "m depth",
        "keywords": ["sea level rise","slr","coastal flooding","inundation",
                     "submersion","coastal risk"],
        "supports_scenario_axes": ["rise_m"],
        "presets": {"AR6 SSP2-4.5 2100": 0.55, "AR6 SSP5-8.5 2100": 0.75,
                    "High-end (low confidence)": 2.0},
    },
    "hot_days_2050s_ssp585": {
        "name": "Days above 40 °C per year (2050s, SSP5-8.5)",
        "family": "projection",
        "compute": "cmip6_hot_days",
        "compute_params": {"scenario": "ssp585",
                           "period": ["2045-01-01","2056-01-01"], "threshold_c": 40},
        "vis": {"min": 0, "max": 120,
                "palette": ["#ffffcc","#fd8d3c","#e31a1c","#800026"]},
        "unit": "days/yr",
        "keywords": ["hot days","extreme heat","heatwave","40 degrees","heat stress"],
        "supports_scenario_axes": ["scenario", "threshold_c", "period"],
    },
    "precip_change_2070_ssp370": { "...": "..." },
    "spei_drought_2060_ssp245":   { "...": "..." },
}

# --- reused verbatim from NCOP's GEEDataCatalog.LOCATIONS pattern ---
LOCATIONS = {
    "pakistan": [60.5, 23.3, 77.9, 37.3],
    "karachi":  [66.8, 24.7, 67.4, 25.3],
    "indus_basin": [66.5, 23.5, 75.0, 36.5],
    "punjab":   [69.0, 27.0, 75.8, 34.5],
    "sindh":    [66.0, 23.3, 71.2, 28.7],
    # ... copy NCOP's 55-entry list; add basin/coast polygons as needed ...
}
DEFAULT_BBOX = LOCATIONS["pakistan"]

def resolve_location(name):
    if not name:
        return "pakistan", DEFAULT_BBOX
    key = name.lower().strip().replace(" ", "_").replace("-", "_")
    for loc, bbox in LOCATIONS.items():
        if loc in key or key in loc:
            return loc, bbox
    return "pakistan", DEFAULT_BBOX
```

**`gee_climate/compute.py` — the dispatcher (mirrors NCOP's `generate_layer`):**

```python
import ee

_DEFAULT_MODELS = ["ACCESS-CM2","CanESM5","EC-Earth3","GFDL-ESM4",
                   "INM-CM5-0","MIROC6","MPI-ESM1-2-HR","MRI-ESM2-0"]

_REGISTRY = {}   # name -> f(aoi, **params) -> ee.Image

def register(name):
    def _wrap(fn): _REGISTRY[name] = fn; return fn
    return _wrap

@register("warming_since_baseline")
def _warming(aoi, target_year=2050, scenario="ssp245", models=None): ...

@register("slr_inundation")
def _slr(aoi, rise_m=1.0): ...

@register("cmip6_hot_days")
def _hot(aoi, scenario="ssp585", period=None, threshold_c=40, models=None): ...

def build_climate_image(cfg, bbox, params):
    aoi = ee.Geometry.Rectangle(bbox)
    fn = _REGISTRY[cfg["compute"]]
    merged = {**cfg.get("compute_params", {}),
              **{k: v for k, v in params.items()
                 if k in cfg.get("supports_scenario_axes", [])}}
    image = fn(aoi, **merged)

    stats = image.reduceRegion(
        reducer=ee.Reducer.mean().combine(ee.Reducer.percentile([10, 90]), sharedInputs=True),
        geometry=aoi, scale=25_000, maxPixels=1e9, bestEffort=True
    ).getInfo()
    vis = cfg["vis"]
    return image, {k: round(v, 2) for k, v in (stats or {}).items() if v is not None}, vis
```

---

## 4. Part C — The LLM‑backed chatbot (replace NCOP's keyword matcher)

### 4.1 Why

Climate queries encode structured parameters that keyword scoring drops:

> *"compare rainfall in the 2050s vs the 2090s over the Indus basin under a
> high‑emissions scenario, show only where it drops more than 20 %"*

→ `{dataset: "precip_change", location: "indus_basin", scenario: "ssp585",
periods: ["2045-2056","2085-2096"], compare: true, threshold_pct: -20}`

An LLM with a tool schema extracts all of that in one call. NCOP's matcher
cannot.

### 4.2 The tool schema

```python
# gee_climate/nlu.py
CLIMATE_TOOL = {
    "name": "build_climate_layer",
    "description": "Build a climate data / projection / scenario map layer.",
    "parameters": {
        "type": "object",
        "properties": {
            "dataset": {"type": "string",
                        "enum": list(CLIMATE_CATALOG.keys()) + ["auto"],
                        "description": "Catalog key, or 'auto' to let the matcher choose."},
            "variable": {"type": "string",
                         "enum": ["tas","tasmax","tasmin","pr","hurs","sfcWind","spei","slr"]},
            "scenario": {"type": "string",
                         "enum": ["historical","ssp126","ssp245","ssp370","ssp585"]},
            "horizon_year": {"type": "integer", "minimum": 2020, "maximum": 2100},
            "baseline": {"type": "string",
                         "description": "e.g. '1995-2014' or 'pre-industrial'"},
            "location": {"type": "string", "description": "Named place or 'pakistan'"},
            "statistic": {"type": "string",
                          "enum": ["mean","delta","pct_change","exceedance_days","p95","rx1day"]},
            "threshold": {"type": "number",
                          "description": "For exceedance stats, e.g. 40 (°C) or 20 (mm)"},
            "rise_m": {"type": "number", "description": "Sea-level rise in metres"},
            "compare_to_year": {"type": "integer",
                                "description": "If set, return a two-period comparison"}
        },
        "required": ["location"]
    }
}
```

### 4.3 The parser

```python
import json
from django.conf import settings

SYSTEM_PROMPT = """You are the climate-data intent parser for CCOP, a national
common operating picture. Convert the user's request into ONE call to
build_climate_layer. Rules:
- Default scenario is ssp245 if the user doesn't specify emissions.
- 'high emissions'/'worst case' -> ssp585; 'low emissions'/'Paris' -> ssp126;
  'moderate' -> ssp245; 'current policies' -> ssp370.
- Default baseline is 1995-2014 (or 'pre-industrial' if the user says
  'above pre-industrial').
- 'mid-century' -> horizon_year 2050; 'end of century' -> 2090; a decade like
  'the 2070s' -> 2075.
- If the user only chats (greeting, help, thanks), DO NOT call the tool; reply
  briefly in plain text.
- Never invent datasets outside the catalog; if unsure, set dataset='auto'.
Locations are in Pakistan unless stated otherwise."""

def parse_climate_query(message: str) -> dict:
    provider = settings.LLM_PROVIDER
    if provider == "groq":
        from groq import Groq
        client = Groq(api_key=settings.LLM_API_KEY)
        resp = client.chat.completions.create(
            model=settings.LLM_MODEL,
            messages=[{"role": "system", "content": SYSTEM_PROMPT},
                      {"role": "user", "content": message}],
            tools=[{"type": "function", "function": CLIMATE_TOOL}],
            tool_choice="auto", temperature=0,
        )
        choice = resp.choices[0].message
        if not choice.tool_calls:
            return {"kind": "chat", "reply": choice.content or "How can I help with climate data?"}
        args = json.loads(choice.tool_calls[0].function.arguments)
    elif provider == "anthropic":
        from anthropic import Anthropic
        client = Anthropic(api_key=settings.LLM_API_KEY)
        resp = client.messages.create(
            model=settings.LLM_MODEL, max_tokens=1024, system=SYSTEM_PROMPT,
            tools=[{"name": CLIMATE_TOOL["name"],
                    "description": CLIMATE_TOOL["description"],
                    "input_schema": CLIMATE_TOOL["parameters"]}],
            messages=[{"role": "user", "content": message}],
        )
        tool_use = next((b for b in resp.content if b.type == "tool_use"), None)
        if not tool_use:
            text = "".join(b.text for b in resp.content if b.type == "text")
            return {"kind": "chat", "reply": text or "How can I help with climate data?"}
        args = tool_use.input
    else:
        raise RuntimeError(f"unsupported LLM_PROVIDER {provider!r}")

    params = _normalise(args)          # map horizon_year/statistic/etc → catalog params
    return {"kind": "layer", "params": params,
            "narrative": _narrative(params)}

def _normalise(args: dict) -> dict:
    """Turn loose LLM args into a concrete {dataset, location, compute-params} dict.
    If dataset=='auto', fall back to a keyword match over CLIMATE_CATALOG
    (reuse NCOP's SemanticSearchHelper logic here as a safety net)."""
    ...

def _narrative(params: dict) -> str:
    return (f"{params['dataset'].replace('_',' ').title()} for "
            f"{params.get('location','Pakistan').title()}"
            + (f", scenario {params['scenario'].upper()}" if params.get('scenario') else "")
            + (f", horizon {params['horizon_year']}" if params.get('horizon_year') else "")
            + ".")
```

### 4.4 Guardrails

- `temperature=0`, `tool_choice="auto"`, hard `enum`s on scenario/variable.
- Whitelist datasets to `CLIMATE_CATALOG.keys()` — reject anything else.
- Wrap the LLM call in a 8 s timeout; on failure, fall back to NCOP's
  keyword matcher (`SemanticSearchHelper.calculate_semantic_score`) ported into
  `nlu.py` as `_keyword_fallback(message)`.
- Rate‑limit per session (DRF `AnonRateThrottle`, e.g. `20/min`).
- Log every `{message → params}` pair for offline eval.

---

## 5. Part D — The Scenario Builder

A **scenario** is a saved, shareable, reproducible parameter set:

```json
{
  "id": "3f9a…",
  "title": "Karachi coastal risk, SSP5-8.5, 2100",
  "variable": "slr",
  "scenario": "ssp585",
  "horizon_year": 2100,
  "baseline": "1995-2014",
  "rise_m": 0.75,
  "location": "karachi",
  "statistic": "mean",
  "threshold": null,
  "compare_to_year": null,
  "created_by": "user@agency.gov.pk",
  "created_at": "2026-09-10T…"
}
```

### 5.1 Backend model + endpoints

```python
# gee_climate/models.py
import uuid
from django.db import models

class SavedScenario(models.Model):
    id            = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    title         = models.CharField(max_length=200)
    params        = models.JSONField()           # the dict above (minus id/meta)
    thumbnail_url = models.URLField(blank=True)
    created_by    = models.CharField(max_length=254, blank=True)
    created_at    = models.DateTimeField(auto_now_add=True)
    updated_at    = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]
```

```python
# gee_climate/scenario_views.py
class ScenarioBuildView(View):
    """POST params -> compute + (optionally) persist. Returns tile_url(s)."""
    def post(self, request):
        if not ensure_initialized():
            return JsonResponse({"error": "Earth Engine unavailable"}, status=503)
        body   = json.loads(request.body or b"{}")
        params = body["params"]
        save   = bool(body.get("save"))
        title  = body.get("title") or _narrative(params)

        cfg = CLIMATE_CATALOG[params["dataset"]]
        aoi_name, bbox = resolve_location(params.get("location"))

        # single layer, OR a two-period comparison
        layers = []
        periods = _periods_for(params)                 # 1 or 2 (compare_to_year)
        for label, p in periods:
            key = json.dumps({"d": params["dataset"], "b": bbox, "p": p}, sort_keys=True)
            res = cached_tile_url(key, lambda p=p: _compute_one(cfg, bbox, p))
            layers.append({"label": label, **res})

        scenario_id = None
        if save:
            obj = SavedScenario.objects.create(
                title=title, params=params,
                thumbnail_url=layers[0]["tile_url"],
                created_by=getattr(request.user, "email", ""))
            scenario_id = str(obj.id)

        return JsonResponse({"success": True, "scenario_id": scenario_id,
                             "title": title, "location": aoi_name,
                             "layers": layers, "params": params})

class ScenarioListView(View):
    def get(self, request):
        qs = SavedScenario.objects.all()[:100]
        return JsonResponse({"scenarios": [
            {"id": str(s.id), "title": s.title, "params": s.params,
             "thumbnail_url": s.thumbnail_url, "created_at": s.created_at.isoformat()}
            for s in qs]})

class ScenarioDetailView(View):
    def get(self, request, pk):
        s = get_object_or_404(SavedScenario, pk=pk)
        # recompute fresh tiles (stored map IDs may have expired)
        cfg = CLIMATE_CATALOG[s.params["dataset"]]
        _, bbox = resolve_location(s.params.get("location"))
        res = cached_tile_url(json.dumps({"d": s.params["dataset"], "b": bbox,
                                          "p": s.params}, sort_keys=True),
                              lambda: _compute_one(cfg, bbox, s.params))
        return JsonResponse({"id": str(s.id), "title": s.title,
                             "params": s.params, "tile_url": res["tile_url"],
                             "vis": res["vis"], "stats": res["stats"]})
```

`python manage.py makemigrations gee_climate && python manage.py migrate`.

### 5.2 Frontend — the builder form

**`frontend/src/modules/scenario-builder.js`** (a panel, opened from the chat
card's "Open in Scenario Builder →" button, which dispatches
`ccop:open-scenario` with the params):

```js
import { addRasterLayer, removeRasterLayer, setRasterOpacity } from "./gee-map-layers.js";

const SSP = [
  { id: "ssp126", label: "SSP1-2.6 · Paris-aligned" },
  { id: "ssp245", label: "SSP2-4.5 · Middle of the road" },
  { id: "ssp370", label: "SSP3-7.0 · Regional rivalry" },
  { id: "ssp585", label: "SSP5-8.5 · Fossil-fuelled" },
];
const HORIZONS = [2030, 2050, 2070, 2090];

export class ScenarioBuilder {
  #map; #root; #state;

  constructor(map, mountEl) {
    this.#map = map; this.#root = mountEl;
    window.addEventListener("ccop:open-scenario", e => this.open(e.detail));
  }

  open(params = {}) {
    this.#state = {
      dataset: params.dataset ?? "warming_2050_ssp245",
      scenario: params.scenario ?? "ssp245",
      horizon_year: params.horizon_year ?? 2050,
      location: params.location ?? "pakistan",
      rise_m: params.rise_m ?? 0.75,
      threshold: params.threshold ?? null,
      compare_to_year: null,
      opacity: 0.85,
    };
    this.#root.style.display = "block";
    this.#render();
    this.#run();
  }

  #render() {
    const s = this.#state;
    this.#root.innerHTML = `
      <div class="sb-header">Scenario Builder
        <button data-role="close">&times;</button></div>
      <label>Emissions scenario
        <select data-role="scenario">
          ${SSP.map(o => `<option value="${o.id}" ${o.id === s.scenario ? "selected" : ""}>${o.label}</option>`).join("")}
        </select></label>
      <label>Horizon
        <select data-role="horizon">
          ${HORIZONS.map(y => `<option value="${y}" ${y === s.horizon_year ? "selected" : ""}>${y}</option>`).join("")}
        </select></label>
      <label>Compare with
        <select data-role="compare">
          <option value="">— none —</option>
          ${HORIZONS.map(y => `<option value="${y}">${y}</option>`).join("")}
        </select></label>
      ${s.dataset.startsWith("slr") ? `
      <label>Sea-level rise (m): <output data-role="rise-val">${s.rise_m}</output>
        <input type="range" min="0.3" max="2.0" step="0.05" value="${s.rise_m}" data-role="rise" /></label>` : ""}
      <label>Layer opacity
        <input type="range" min="0" max="1" step="0.05" value="${s.opacity}" data-role="opacity" /></label>
      <div class="sb-stats" data-role="stats"></div>
      <div class="sb-actions">
        <button data-role="run">Update map</button>
        <button data-role="save">Save scenario</button>
        <button data-role="swipe">Compare (swipe)</button>
      </div>`;
    this.#wire();
  }

  #wire() {
    const q = sel => this.#root.querySelector(`[data-role="${sel}"]`);
    q("close").onclick = () => { this.#clearLayers(); this.#root.style.display = "none"; };
    q("scenario").onchange = e => { this.#state.scenario = e.target.value; this.#run(); };
    q("horizon").onchange  = e => { this.#state.horizon_year = +e.target.value; this.#run(); };
    q("compare").onchange  = e => { this.#state.compare_to_year = e.target.value ? +e.target.value : null; this.#run(); };
    q("opacity").oninput   = e => { this.#state.opacity = +e.target.value; this.#applyOpacity(); };
    if (q("rise")) q("rise").oninput = e => {
      this.#state.rise_m = +e.target.value; q("rise-val").textContent = e.target.value;
    };
    if (q("rise")) q("rise").onchange = () => this.#run();
    q("run").onclick  = () => this.#run();
    q("save").onclick = () => this.#save();
    q("swipe").onclick = () => this.#toggleSwipe();
  }

  async #run() {
    const res = await fetch("/api/gee/scenario/build/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ params: this.#stateToParams() }),
    }).then(r => r.json());

    this.#clearLayers();
    this.#layerIds = res.layers.map((L, i) => {
      const id = `sb-${res.params.dataset}-${i}`;
      addRasterLayer(this.#map, id, L.tile_url, { opacity: this.#state.opacity });
      return id;
    });
    this.#renderStats(res.layers);
  }

  #stateToParams() {
    const s = this.#state;
    return { dataset: s.dataset, scenario: s.scenario, horizon_year: s.horizon_year,
             location: s.location, rise_m: s.rise_m, threshold: s.threshold,
             compare_to_year: s.compare_to_year };
  }

  async #save() {
    const res = await fetch("/api/gee/scenario/build/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ params: this.#stateToParams(), save: true }),
    }).then(r => r.json());
    window.dispatchEvent(new CustomEvent("ccop:scenario-saved", { detail: res }));
  }

  #applyOpacity() { (this.#layerIds || []).forEach(id => setRasterOpacity(this.#map, id, this.#state.opacity)); }
  #clearLayers()  { (this.#layerIds || []).forEach(id => removeRasterLayer(this.#map, id)); this.#layerIds = []; }

  #renderStats(layers) {
    const box = this.#root.querySelector('[data-role="stats"]');
    box.innerHTML = layers.map(L =>
      `<div><b>${L.label}</b> — mean ${L.stats?.mean ?? "—"} · p10 ${L.stats?.["mean_p10"] ?? "—"} · p90 ${L.stats?.["mean_p90"] ?? "—"}</div>`
    ).join("");
  }

  // "Swipe" comparison = Mapbox GL "rain" of a clip rectangle on mousemove;
  // simplest robust version = mapbox-gl-compare plugin between two map instances,
  // OR a CSS clip-path on the top raster layer's canvas. For a single map:
  #toggleSwipe() {
    if (!this.#layerIds || this.#layerIds.length < 2) return;
    this.#swipe = !this.#swipe;
    const topId = this.#layerIds[1];
    const onMove = (e) => {
      const w = this.#map.getContainer().clientWidth;
      const frac = e.point.x / w;
      // reveal the top layer only left of the cursor
      this.#map.setPaintProperty(topId, "raster-opacity",
        ["step", ["*", ["-", ["number", ["get", "x"]], 0], 0], 0]); // placeholder
      // Practical approach: use two synced maps + mapbox-gl-compare.
    };
    if (this.#swipe) this.#map.on("mousemove", onMove);
    else this.#map.off("mousemove", onMove);
  }
}
```

> For a production swipe/split‑screen comparison, use **two synchronised Mapbox
> instances + `mapbox-gl-compare`** (`https://github.com/mapbox/mapbox-gl-compare`)
> rather than fighting `clip-path` on one canvas. Left map = baseline period,
> right map = future period, both driven by the same scenario params with
> different `horizon_year`.

### 5.3 Chatbot ↔ scenario builder handoff

- Chat card → `ccop:open-scenario` custom event carrying `data.params` →
  `ScenarioBuilder.open(params)` pre‑fills the form.
- Builder "Save" → `ccop:scenario-saved` → a "Saved scenarios" list panel adds a
  row (thumbnail from `thumbnail_url`, click to re‑open).
- Optionally let the chatbot *read back* saved scenarios: add a
  `list_saved_scenarios` tool so *"show my Karachi scenario"* resolves to
  `GET /api/gee/scenario/<id>/`.

---

## 6. Part E — Recommended improvements (prioritised)

### P0 — correctness & security

1. **Service‑account auth** (Step 2) — never ship a personal `earthengine
   authenticate` token. Store the JSON key as a mounted secret / env var, not in
   the image or repo.
2. **Pin `earthengine-api`** and `google-auth` in `requirements.txt`.
3. **`ensure_initialized()` at request time**, not import time; return **503**
   (not 500) with `health()` detail when GEE is down; add `/api/gee/health/` for
   load‑balancer checks.
4. **Redis tile‑URL cache with TTL < 3 days** (Step 9) + a `refresh` endpoint the
   frontend hits on a Mapbox tile `error`. This alone removes NCOP's single
   worst UX bug (expired map IDs).

### P1 — performance & scale

5. **Use `earthengine-highvolume.googleapis.com`** for the tile server
   (`opt_url` in `ee.Initialize`).
6. **Move compute off the request thread.** `getMapId()` blocks 1–15 s. Options,
   cheapest first:
   - Thread‑pool executor + `future.result(timeout=…)` (NCOP's own pattern for
     Overture/WBT in `flood_exposure.py` / `flood_model.py`).
   - Celery/RQ task + a `job_id` polling endpoint (mirror NCOP's
     `flood_model_views.py` async job pattern — `_JOBS` dict, `/status/<job_id>/`).
   - For the scenario builder, precompute on save and store the map ID.
7. **Precompute the hot climate layers nightly.** The CMIP6 ensemble means for
   the standard `{scenario × horizon × variable}` grid don't change. A nightly
   Celery beat / cron job (mirror NCOP's `views.py` PMD‑predictions warmer)
   writes fresh map IDs into Redis so the first user request is instant.
   Even better: **`Export.image.toCloudStorage`** the ensemble means as
   **Cloud‑Optimized GeoTIFFs** once per data release, host them on GCS, and
   serve via `titiler`/`rio-tiler` — removes GEE from the hot path entirely and
   makes tiles permanent.
8. **Batch `getInfo()`** — NCOP's `TemporalGEELayerView` calls `.size().getInfo()`
   per year in a loop. Replace with a single server‑side `ee.List`/`.aggregate_*`
   round‑trip, or skip the availability check for datasets known to be complete
   (CMIP6 is).
9. **`scale`/`bestEffort` on every `reduceRegion`** for stats — never let a
   national‑extent reduction run at native resolution.

### P2 — product depth

10. **Ensemble confidence layer** — return `stdDev` / model‑agreement alongside
    the mean; render as a hatch overlay or a toggle. Users of climate
    projections need the spread, not just the central estimate.
11. **Time‑series charts, not just maps.** Add `POST /api/gee/timeseries/` that
    returns an `ee.ImageCollection...reduceRegion` per year for the AOI centroid
    or polygon → a line chart of the trajectory 2020→2100 per SSP. This is the
    single most requested climate‑tool feature.
12. **Zonal statistics** — accept a GeoJSON polygon (district, basin) instead of
    only a bbox; return per‑feature mean/max/exceedance so CCOP can drive a
    choropleth, not only a raster.
13. **Downloadable outputs** — `Export.image.toDrive` / `toCloudStorage` for the
    exact scenario the user built (GeoTIFF + a `scenario.json` sidecar). NCOP
    already hands out tile‑URL "download info"; go one better with a real raster.
14. **Scenario comparison as first‑class** — the two‑period compare in §5.2 should
    also support **scenario × scenario** (SSP2‑4.5 vs SSP5‑8.5 at the same
    horizon) and **model vs ensemble**.
15. **Narrative generation** — after computing stats, a second small LLM call:
    *"Under SSP5‑8.5, mean warming over Sindh reaches +2.9 °C by 2050 (model
    range +2.1 to +3.6 °C); the number of days above 40 °C roughly triples from
    ~25 to ~78 per year."* Grounded strictly in the returned `stats`.

### P3 — operability

16. **Split the code** — a dedicated `gee_climate` app (Step 4), not lines
    3400–4800 of a shared `views.py`.
17. **Structured logging** of every `{query, params, dataset, latency, cache
    hit?}` — feeds both eval and a cost dashboard.
18. **Quota awareness** — EE has per‑project concurrent‑request and
    compute‑unit limits. Add a semaphore around `getMapId`/`getInfo` sized to
    your plan; queue beyond it.
19. **Tests** — a `tests/` with (a) catalog‑config validation (every `compute`
    key resolves, every `vis.palette` is valid hex), (b) one live smoke test per
    dataset family behind a `--live` marker, (c) NLU golden set (`message →
    expected params`).
20. **Attribution & licensing** — surface *"Source: NASA NEX‑GDDP‑CMIP6 via
    Google Earth Engine"* in the legend/README; CMIP6 terms require citing the
    modelling groups.

---

## 7. Consolidated reference — keys, URLs, env vars

### 7.1 Environment variables (CCOP `.env`)

| Var | Example | Purpose |
|---|---|---|
| `GEE_PROJECT_ID` | `ccop-climate-ee` | Cloud project registered with Earth Engine |
| `GEE_SERVICE_ACCOUNT_FILE` | `/run/secrets/ee_sa` | Path to the service‑account JSON key (Option A) |
| `GEE_SERVICE_ACCOUNT_JSON` | `{"type":"service_account",…}` | Inline key JSON (Option B, for K8s/Docker secrets) |
| `GEE_TILE_ENDPOINT` | `https://earthengine-highvolume.googleapis.com` | High‑volume EE endpoint for the tile server |
| `GEE_CACHE_TTL_SECONDS` | `129600` (36 h) | Redis TTL, must be < GEE map‑ID expiry (~3 days) |
| `REDIS_URL` | `redis://127.0.0.1:6379/1` | Tile‑URL cache + job queue broker |
| `LLM_PROVIDER` | `groq` \| `anthropic` \| `openai` | Which LLM backs the intent parser |
| `LLM_API_KEY` | `gsk_…` / `sk-ant-…` | Key for that provider |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | Model id for tool/function calling |

> NCOP precedent: `.env` already holds `GEE_PROJECT_ID`, `GROQ_API_KEY`,
> `GROQ_API_KEY_FALLBACK`, `MAPBOX_ACCESS_TOKEN`. Same file, same `django-environ`
> loader (`project/ncop_project/settings/base.py`).

### 7.2 URLs

| URL | What it is |
|---|---|
| `https://console.cloud.google.com/apis/library/earthengine.googleapis.com` | Enable the Earth Engine API |
| `https://code.earthengine.google.com/register` | Register the Cloud project / service account with EE |
| `https://console.cloud.google.com/iam-admin/serviceaccounts` | Create the service account & JSON key |
| `https://earthengine.google.com/noncommercial/` | Noncommercial eligibility (gov/agency) |
| `https://developers.google.com/earth-engine/datasets/catalog/NASA_GDDP-CMIP6` | NEX‑GDDP‑CMIP6 dataset docs (bands, models, scenarios) |
| `https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR` | ERA5‑Land daily |
| `https://developers.google.com/earth-engine/datasets/catalog/UCSB-CHG_CHIRPS_DAILY` | CHIRPS daily precip |
| `https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30` | GLO‑30 DEM (SLR bathtub) |
| `https://earthengine-highvolume.googleapis.com` | High‑volume compute/tile endpoint (`opt_url`) |
| `https://earthengine.googleapis.com/v1/projects/<proj>/maps/<mapid>/tiles/{z}/{x}/{y}` | The XYZ tile template `getMapId()` returns |
| `https://github.com/mapbox/mapbox-gl-compare` | Swipe/split‑screen comparison plugin for the scenario builder |
| `https://console.cloud.google.com/earth-engine` | EE quota, usage, registered assets |

### 7.3 NCOP files referenced (read these for the working pattern)

| File | Contains |
|---|---|
| `project/ncop_internal/views.py` (~L3405–4800) | `initialize_earth_engine`, `GEEDataCatalog`, `SemanticSearchHelper`, `EnhancedCompute`, `AHPModels`, `DynamicGEELayerView`, `TemporalGEELayerView`, `GEECatalogView`, `GenerateLegendView` |
| `project/ncop_internal/urls.py` (L37–101) | the four `api/gee/*` routes |
| `project/ncop_project/settings/base.py` (L158–163) | `GEE_PROJECT_ID` via `django-environ` |
| `project/ncop_internal/apps.py` | `ready()` warm‑up‑on‑a‑timer pattern (copy for `ensure_initialized`) |
| `frontend/src/modules/navigation-panel.js` (L189–3300) | the GEE chat modal, `#addLayerResponse`, `map.addSource/addLayer` raster wiring, temporal timeline |
| `project/ncop_internal/chat_engine.py` | Groq/`ChatGroq` LLM handle pattern (reuse for `nlu.py`) |
| `project/ncop_internal/flood_model_views.py` | async job‑id polling pattern (reuse for long GEE computes) |

---

## 8. Minimal end‑to‑end checklist

```
[ ] GCP project created, Earth Engine API enabled, project registered at code.earthengine.google.com/register
[ ] Service account ccop-ee-runner created, role roles/earthengine.viewer, JSON key downloaded
[ ] Service account added to the registered EE project
[ ] JSON key mounted as a secret; GEE_SERVICE_ACCOUNT_FILE / _JSON set in .env
[ ] requirements.txt: earthengine-api==1.7.1, google-auth pinned, redis
[ ] gee_climate Django app created; ee_client.ensure_initialized() written & called from views
[ ] apps.py ready() schedules a non-blocking warm-up
[ ] Redis running; cache.cached_tile_url wired
[ ] catalog.py: CLIMATE_CATALOG populated (warming, SLR, hot-days, precip-change, drought)
[ ] compute.py: cmip6_delta / cmip6_hot_days / slr_inundation / warming_since_baseline registered
[ ] nlu.py: LLM tool schema + parse_climate_query + keyword fallback
[ ] views.py: /api/gee/query/, /api/gee/health/, /api/gee/legend/, /api/gee/catalog/
[ ] scenario_views.py + SavedScenario model + migration
[ ] Frontend: gee-map-layers.js (addRasterLayer w/ dead-tile refresh)
[ ] Frontend: gee-climate-chat.js panel mounted in the right rail
[ ] Frontend: scenario-builder.js panel, opened via ccop:open-scenario event
[ ] mapbox-gl-compare added for swipe comparison
[ ] Smoke test: POST /api/gee/query/ {"message":"sea level rise 1m in Karachi"} → tile_url renders on the map
[ ] Nightly precompute job for the standard {scenario × horizon × variable} grid
[ ] /api/gee/health/ wired to the load balancer
```
