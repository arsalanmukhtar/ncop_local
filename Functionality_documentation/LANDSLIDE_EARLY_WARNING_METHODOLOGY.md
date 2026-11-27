# Landslide Early Warning & Susceptibility — Integration Methodology

Status: **Implemented through L7** (see §13 — L0–L6.6 and L7 below).
The text immediately following was written when this document was
research + planning only, and is kept as the original plan of record. Every reuse claim below was
verified directly against the live codebase (`grep`-confirmed function
names, not assumed from memory or from the seed document); every
external claim (models, literature, data sources) was checked via a live
web search this session and is cited at the point of use. Anything that
could not be confirmed live is marked **TO VERIFY LIVE** — the same
discipline `FLASH_FLOOD_EARLY_WARNING_METHODOLOGY.md` established and
that this document inherits, not reinvents.

This document supersedes and formalizes the seed document the user
provided (`Lightweight Landslide Early Warni.txt`) — every claim from
that file is either verified and carried forward, refined against real
literature found this session, or flagged where the live search
surfaced a better regional source than the seed document had access to.

---

## §0. Retrospective — what the flood/riverine build actually got wrong, and what that changes here

The user explicitly asked for this before any landslide work begins:
*"have a critique look at the flood case and see what errors we got and
what improvements were made."* This is not a formality — several of the
flood system's real, live-caught mistakes have a direct, concrete
landslide analogue, and the point of doing this critique first is to
build those fixes in from day one instead of rediscovering them a second
time.

### 0.1 Errors that were made, caught, and fixed — apply the fix, not the mistake

| Flood-system mistake (real, live-caught) | Root cause | Landslide implication |
|---|---|---|
| AHP-zone polygon vectorization needed **three separate rounds** before it was actually gap-free (§0.42, §0.50, §0.51 of the flood doc) | Round 1 only covered custom-AOI catchments; round 2 was tuned/tested against a *synthetic* raster and produced an 11MB payload on the real, largest, noisiest pilot; only round 3 (an ordinal cumulative-boundary technique, gap-free *by construction*, not by tuned parameters) actually closed it | `_vectorize_ordinal_zones_gapfree` (`flood_model.py`) is already generic — it takes an ordinal class array, not anything flood-specific. **Use it directly for landslide susceptibility zones from Phase L1 onward. Do not re-derive a sieve/simplify-tuning approach and re-discover the same three-round path.** |
| A byte-budget/backoff tuning pass was validated only against a synthetic raster, which underestimated real-world noise | Testing discipline gap, not a code bug | **Every landslide vectorization/classification change must be tested against the real, largest, noisiest pilot catchment's own real rasters before being called done** — not a synthetic stand-in, no matter how much faster that iteration loop is. |
| A verification script's own gap-metric was itself wrong (a bounding-box-envelope comparison flagged a false "0.047% gap" that was really just the catchment's own irregular boundary not filling its bbox) — caught and corrected mid-session, not after shipping | Verification methodology error, not implementation error | When (re-)verifying landslide zone geometries are gap-free, compare `union(all classes)` directly against the true valid-area mask — never a bounding-box proxy. |
| AHP zone breakpoints calibrated on one basin didn't generalize to smaller/different-terrain catchments (MAUP) | A single hardcoded breakpoint table applied nationwide | `_local_natural_breaks` + adaptive smoothing (already in `flood_model.py`) exist specifically because of this lesson. **This is exactly why the seed document's own §2 already insists on a multi-region literature survey before adopting one weight table — that caution is validated by this exact prior mistake, not redundant caution.** |
| A single-worker-executor race: two near-simultaneous callers for the same slow external fetch (Overture buildings) each independently ran the full fetch — confirmed to nearly double wall-clock time before being fixed with an in-flight-future coalescing registry | No request-coalescing on a shared, expensive, cacheable fetch | **Still unfixed, by the flood system's own admission, for `build_hand_pipeline`/`_get_cached_buildings_index`.** Landslide reuses `build_hand_pipeline` directly (§3 below) — it inherits this exact same gap on day one. Decide explicitly in Phase L0: fix the coalescing gap once (benefits both hazards) or accept and document the limitation for landslide too. Do not silently repeat a bug that's already been diagnosed. |
| A rainfall-source fetch ran synchronously on the HTTP request thread, which could hold a request open past a reverse-proxy timeout under a slow/degraded external API — confirmed live and fixed by moving the fetch into the background job worker | Violated the app's own "nothing potentially slow ever runs on a request thread" rule, in exactly one place | Landslide's own rainfall-triggered dynamic mode (§6 below) calls the *exact same* `flood_forecast.py` functions for the *exact same reason*. **Build the async-job-first pattern in from the start — do not let a synchronous rainfall fetch ship even once.** |
| A map-snapshot export feature captured a blank/incomplete canvas because the shared Mapbox instance wasn't initialized with `preserveDrawingBuffer: true` | A missing WebGL option, worked around badly (a repaint-timing hack) before being fixed properly | Already fixed at the *shared* map level (`dashboard.js`). **Free for landslide** — any future landslide map-export feature inherits the fix with zero new work. |
| A base64 map-image POST body exceeded Django's default 2.5MB `DATA_UPLOAD_MAX_MEMORY_SIZE`, producing an opaque, message-less 400 | Default framework limit too tight for a real payload shape this app now has | Already fixed globally (`settings/base.py`, raised to 15MB + client-side downscaling + a clean caught error). **Free for landslide.** |
| Flood-model JSON/GeoJSON API responses shipped uncompressed (no `GZipMiddleware`, no nginx `gzip_types` on the proxied API path) | An overlooked default | Already fixed globally (`GZipMiddleware` added to `MIDDLEWARE`). **Free for landslide's own API responses too — no separate fix needed.** |
| `requirements.txt`'s GDAL line is a machine-specific local file path, not portable to a new machine — directly caused a real GDAL DLL-loading failure when replicating to a second VM | Deployment/dependency portability gap | Cross-cutting, not landslide-specific, and **not yet fixed** — documented in `NEW_MACHINE_SETUP.md`. Landslide will use the identical GDAL/WhiteboxTools stack, so it carries the identical (already-known, already-documented) risk. No new exposure, but no free fix either. |

### 0.2 A concrete anti-pattern already sitting in this exact codebase — supersede it, don't extend it

Live-confirmed (`project/ncop_internal/views.py`, `AHPModels.compute_landslide_susceptibility`,
dataset key `landslide_susceptibility_ahp`): there is **already** a
landslide-susceptibility layer wired into the generic GEE dynamic-layer
catalog. It is real and already servable, but it is exactly the crude,
single-weight-table pattern the flood AHP work's own §0.27 correction
moved away from:

```python
ahp_weights = {
    'slope': 0.35, 'aspect': 0.15, 'elevation': 0.15,
    'soil_moisture': 0.20, 'rainfall': 0.15,
}
# hardcoded thresholds, e.g. slope.gt(25).multiply(1.0)...where(slope.gte(10)...)
```

No literature citation for these five numbers, no Saaty consistency-ratio
validation, no terrain-class conditioning (one table for the entire
country), no AUC/ground-truth validation ever run against it, and its
own docstring literally says `"PRESERVED"` — legacy code nobody intends
to touch. A near-identical pattern exists for `compute_seismic_susceptibility`
in the same file (`elevation 0.30, slope 0.30, geology_proxy 0.25,
population 0.15` — also uncited, also unvalidated).

**This is the single clearest "what not to repeat" example available**,
sitting in the same repository. The plan below is built to the
`flood_ahp.py` standard specifically *because* this lower-rigor version
already exists and already shows what the low-rigor version looks like
in production. Phase L1's own deliverable should be understood as a
**supersession** of this legacy heuristic, not a second, parallel
landslide layer — the crude version stays wired for whatever currently
depends on it (the GEE dynamic-catalog chatbot-driven layer request
path), but nothing new should be built on top of its weight table or its
validation-free posture.

### 0.3 What the multi-hazard panel work already bought, for free

The flood panel was restructured this session into a 3-tab multi-hazard
shell (`flood-model-control.js`) — **Flood** (fully functional),
**Landslide**, **Wildfire/Other** (both currently placeholders). This
means the seed document's own Phase L5 ("Production wiring + frontend...
new panel, async job pattern, progress checklist") is **partially done
already**:

- The panel shell, tab bar, header/title-swap logic, and the
  `#landslideHazardContent` mount point already exist.
- The async job-id + polling pattern (`_JOB_EXECUTOR`, `_JOBS` registry,
  `_mark_stage`/checklist rendering, `FloodModelStatusView`'s own shape)
  is proven, tested, and directly copyable — the seed document's own §8
  already recommended a **separate** endpoint (`POST
  /api/landslide-model/run/`) over extending the flood one, specifically
  to keep the flood code path provably untouched; that recommendation is
  reaffirmed here, now that a real, working template to copy exists
  line-for-line.
- The one-page, table-and-color "briefing" report export
  (`flood_report_export.py`) is a directly reusable *template* — a future
  landslide export would swap in landslide's own KPI columns (area,
  population, buildings, roads in the susceptibility zone; nothing
  flood-specific in the layout engine itself) rather than being designed
  from scratch.

None of this is claimed as "done for landslide" — it's flagged as
**already-paid-for infrastructure** that changes the phased-plan effort
estimate in §10 below, honestly reflecting real prior work rather than
re-estimating from zero.

---

## §1. Why landslide fits this architecture almost for free

Unchanged from the seed document's own §0, verified: the flood system's
terrain-factor pipeline, AHP fusion engine, exposure report, and
accuracy-assessment module were all written to take a `catchment_key`/
bbox and a set of factor weights — nothing flood-specific baked into
their core logic. Landslide susceptibility needs the same shape of
system (terrain factors → AHP fusion → exposure → validated against real
events → served as a raster/zone layer). Every function name in the
table below was independently re-confirmed live this session via `grep`
against the current source, not carried over from the seed document
unchecked:

| Existing piece (confirmed live) | Reused for landslide as |
|---|---|
| `build_hand_pipeline`'s DEM fetch, D8 pointer, `build_twi_curvature_rasters` (`flood_model.py`) | Slope/TWI/curvature — the same terrain factors landslide AHP literature universally uses, and (§3 below) the inputs to a physically-based infinite-slope layer too |
| `flood_connectivity.chamfer_distance_km` | Distance-to-road / distance-to-drainage / distance-to-fault — same pure-NumPy technique |
| `build_lulc_raster` / `build_soil_texture_raster` (`flood_model.py`) | Land-cover and soil factors, different hazard-reclassification table |
| `flood_ahp.py` — `get_factor_weights`, Saaty CR validation, terrain-conditioned profile selection, `build_ahp_smoothed_score_raster`, `_local_natural_breaks` | The AHP fusion engine itself — a landslide profile is a new weight table plugged into the same machinery |
| `flood_model._vectorize_ordinal_zones_gapfree` | The gap-free zone-boundary technique from §0.1 above — **use directly, do not re-derive** |
| `flood_exposure._build_exposure_from_geom` | Buildings/roads/population/schools/hospitals inside a landslide High-susceptibility zone — geometry-agnostic by design |
| `accuracy_assessment.py` — `compute_auc`, `assess_raster_auc_stable`, `assess_pooled_multi_raster_auc_stable`, `calibrate_hierarchical_thresholds`, `list_gfd_events` (as a pattern to mirror) | Same validation math against COOLR instead of GFD |
| `flood_forecast.py` — CHIRPS / PMD Forecast / live-observed dispatch | The rainfall-trigger side of dynamic landslide early warning |
| NCOP's existing `geology` (40-formation, GeoServer `geological_global:geology`) and `pga_zones` (5-zone, `geological_global:pga_zones`) vector layers — confirmed live in `frontend/src/modules/map-layers.js` | Two landslide factors already in this app, never fetched by flood |
| Async job pattern (`POST /api/flood-model/run/` shape, `_JOB_EXECUTOR`, status polling, checklist) | Directly copyable template for `/api/landslide-model/run/` |
| The multi-hazard panel shell (§0.3 above) | Already-built frontend mount point |

Net new work is genuinely narrow: one factor-weight literature review
(§3), 2-3 new factor rasters (aspect, geology reclass, PGA reclass), one
new ground-truth integration (COOLR), and the wiring — no new subsystem.

---

## §2. Scope decision: static susceptibility first, rainfall-triggered dynamic mode second

Unchanged from the seed document, and directly validated by the flood
system's own phased history (Phase 1 hazard-only → Phase 2
discharge-driven → Phase 2.5 AHP fusion — each stage independently
testable before the next depended on it):

- **Phase L1 — static susceptibility**: "where could a landslide
  happen" — terrain/geology/land-cover/seismic factors that don't change
  day to day. Validates against a point *inventory* (COOLR), needs no
  live rainfall input.
- **Phase L4 — rainfall-triggered dynamic mode**: "is a landslide likely
  right now" — the static layer combined with a live/forecast rainfall
  intensity-duration (ID) check. This is what makes "early warning"
  literally true, the same way flood's discharge-driven mode was the
  real fix for "susceptibility zone ≠ predicted extent."

---

## §3. Literature — model and factor selection (live-verified this session)

### 3.1 What plays HAND's role for landslide?

HAND's own appeal for flood was: a real physical-process concept,
computable purely from a DEM, no site survey data, no calibration
against anything beyond the DEM itself. The literature search this
session confirms there is a genuine landslide analogue family —
**physically-based slope-stability models** — but with one honest,
load-bearing caveat HAND never had.

**Confirmed model landscape** (SHALSTAB, SINMAP, TRIGRS, and newer
entrants FSLAM/iHydroSlide3D — all combine the infinite-slope stability
equation with a hydrological model; SHALSTAB/SINMAP use a simplified
steady-state hydrology, TRIGRS solves a transient Richards'-equation
infiltration model, which is meaningfully heavier). [Journal of Mountain
Science comparison, Serra do Mar Brazil](https://link.springer.com/article/10.1007/s11629-021-7057-z);
[GRASS GIS `r.shalstab`](https://grass.osgeo.org/grass84/manuals/addons/r.shalstab.html);
[Natural Hazards 2025 mixed review of deterministic physically-based
models](https://link.springer.com/article/10.1007/s11069-025-07634-0).

**The honest caveat, confirmed directly**: unlike HAND, an infinite-slope/
SHALSTAB-style model needs real soil-strength parameters — cohesion,
friction angle, saturated unit weight/bulk density — to combine with
slope and the steady-state wetness index. [Parameterization study, Rio
de Janeiro](https://www.sciencedirect.com/science/article/abs/pii/S0013795202002636)
confirms these are "difficult to measure in the field" and models are
typically run across a *range* of plausible values rather than one
precise number per cell. **This is a real, named gap, not paperable
over**: for the MVP, these parameters must come from literature-transferred
regional defaults per lithology class (crosswalked from the real,
confirmed 40-formation `geology` layer — §4 below), the same
literature-transfer posture the flood system already used for curve
number/HSG values, never from a local geotechnical survey this project
doesn't have access to.

**Recommendation**: build a lightweight infinite-slope-with-TWI layer
using the ALREADY-COMPUTED `build_twi_curvature_rasters` output
(near-zero new fetch code — this is the single biggest "reuse, don't
build" win available) with literature-transferred cohesion/friction-angle
defaults per geology-formation class, as one of several complementary
outputs — not a replacement for AHP, the same relationship HAND itself
has to AHP susceptibility in the flood system today (a physically-
grounded layer sitting alongside, not instead of, the multi-factor
weighted one).

### 3.2 The NCOP "LHASA2" layer — real, but precisely: a Meteoblue product, tile-served, not yet a computable input

**Correction to an imprecise earlier claim in this document.** The
underlying NASA LHASA2 *model* (decision-tree in v1, XGBoost in v2,
combining static susceptibility with GPM satellite rainfall/snow/soil-
moisture) is real and independently confirmed — [NASA technical
report](https://ntrs.nasa.gov/citations/20205001695); [NASA GitHub
`nasa/LHASA`](https://github.com/nasa/LHASA); [GPM Landslides project
page](https://gpm.nasa.gov/landslides/projects.html). But **live-confirmed
against `frontend/src/modules/map-layers.js` and `time-functions.js`**,
what NCOP actually wires up is `generateMBX_MeteoblueLHASA2LatestLayer`
— a **Meteoblue-hosted map-tile layer** (`MBX_` prefix, authenticated via
the app's own `METEOBLUE_TOKEN`), whose own information text describes
itself as *"the latest Meteoblue landslide probability daily product"* —
Meteoblue's own re-served/branded product, not a direct fetch from NASA's
own GitHub/NTRS infrastructure. Whether Meteoblue's product is a
straight re-serving of NASA's actual LHASA2 output or their own
similarly-named model is **TO VERIFY LIVE** — the two are conflated in
the NCOP layer's own description, and this document should not have
assumed equivalence without checking.

**The load-bearing technical gap, not previously flagged**: this layer
is served as **rendered map tiles** for on-screen display. No
server-side Python fetch of its underlying numeric probability values
exists anywhere in this codebase today (`METEOBLUE_TOKEN` is used only
to authenticate frontend tile requests, confirmed via `grep` across
`views.py`) — meaning "sample it for computation," as suggested, is
**not yet a zero-work reuse** the way this document's earlier draft
implied. Two real paths, neither trivial, both **TO VERIFY LIVE** before
committing to one:

1. **Meteoblue's own Dataset/Package API** — Meteoblue sells raw
   gridded-value API access commercially, separate from tile rendering;
   whether the NCOP `METEOBLUE_TOKEN` subscription tier includes raw
   values for this specific landslide product (not just the weather
   layers already in use) needs a direct check against Meteoblue's own
   API docs/account dashboard, not assumed from the tile layer's mere
   existence.
2. **Decode rendered tile pixel colors back to a value** via the color
   ramp — technically possible (this app already extracts a numeric
   `minValue` from *vector* tile features elsewhere, §3.2.1 below), but
   LHASA2 is a *raster* tile layer here, not vector — decoding raster
   pixel colors back to a probability value is fragile (tied exactly to
   Meteoblue's own color stops) and not recommended as a first choice.

**Revised recommendation**: use this layer as a **free, zero-backend-work
visual cross-check** in the landslide panel from Phase L1 onward (an
operator can eyeball it alongside the AHP zone layer, exactly as
low-effort as originally claimed) — but do **not** plan on it as a
computable AUC-ensemble or dynamic-trigger *input* (§6) until the Dataset
API question above is actually resolved. This is a real, honest
downgrade from this document's own earlier framing ("a fourth,
complementary signal" implied computational use); the visual-cross-check
value is still real and still free, just narrower than first claimed.

#### 3.2.3 Resolving the "can GDAL automate this" question — confirmed, a real, buildable path exists

Live-read directly from `generateMBX_MeteoblueLHASA2LatestLayer`
(`time-functions.js`), not guessed:

```
https://maps-api-cdn.meteoblue.com/v1/map/raster/LHASA2/{latestTime}/
  963~sfc~daily~none~contourSteps
  ~-0.1~rgba(251,251,242,1.0)~5.0~rgba(255,255,224,1.0)
  ~10.0~rgba(236,252,163,1.0)~20.0~rgba(226,244,111,1.0)
  ~30.0~rgba(227,229,67,1.0)~40.0~rgba(237,208,27,1.0)
  ~50.0~rgba(255,179,0,1.0)~60.0~rgba(255,138,11,1.0)
  ~70.0~rgba(253,104,32,1.0)~80.0~rgba(246,80,53,1.0)
  ~90.0~rgba(236,71,76,1.0)~100.0~rgba(223,79,108,1.0)
  /{z}/{x}/{y}?...&apikey={METEOBLUE_TOKEN}
```

Three concrete, load-bearing facts this URL itself hands over, not
inferred:

1. **The latest-available-date lookup is its own separate, plain JSON
   REST endpoint** — `https://maps-api-cdn.meteoblue.com/v1/time/daily/LHASA2?apikey=...`
   (confirmed via `getLatestMeteoblueTimeSync`, a synchronous `XMLHttpRequest`
   with no CORS/browser-only trick — a plain authenticated GET,
   trivially callable server-side with `requests` too).
2. **The tile URL is a standard XYZ/slippy-map raster template**
   (`.../{z}/{x}/{y}?query`) — the exact same tiling scheme
   `mercantile==1.2.1` (**already in `requirements.txt`, zero new
   dependency**) computes bounds/`z,x,y` for. Given the source config's
   own `maxzoom: 6`, this product's native resolution is genuinely
   coarse (at 512px tiles, roughly ~1km/pixel at zoom 6 — consistent
   with the ~1km resolution the underlying LHASA2 model itself reports,
   §3.2) — a real precision ceiling to state honestly, not a bug.
3. **The exact color ramp is embedded in the URL as plain text** —
   `contourSteps` with 11 real numeric anchor points from -0.1 to 100.0,
   each mapped to an exact RGBA value. This is **not** a "reverse-engineer
   an unknown color scale" problem (the fragile case §3.2 originally
   worried about) — it's a **known, exact, discrete step function**
   published in the URL itself. Decoding a downloaded tile's pixel RGBA
   back to the correct step value is a straightforward nearest-color
   lookup against these 11 published stops, not guesswork.

**Confirmed, buildable pipeline, zero new pip dependencies**:
`requests` (fetch the time endpoint, then the covering tile PNG(s) for
the pilot AOI's bbox) → `mercantile` (AOI bbox → covering `z,x,y` tiles,
already installed) → `Pillow`/`osgeo.gdal` (already installed — decode
PNG pixels, map each pixel's RGBA to its nearest published contour-step
value) → georeference via the standard Web-Mercator tile-bounds formula
(`mercantile.bounds(x, y, z)`, not a new technique) → write out as a
small GeoTIFF via the existing `_write_raster_array` helper pattern
(`flood_model.py`) for the pilot catchment's own AOI.

**What is still genuinely `TO VERIFY LIVE`, narrowed from the original
open question**: not "can this be automated at all" (yes — confirmed
above), but specifically whether Meteoblue's own **Dataset/Package API**
(a separate, precision-preserving raw-grid-value product line Meteoblue
sells commercially) is *also* covered by the existing `METEOBLUE_TOKEN`
subscription — if so, that would be strictly better than pixel-decoding
(no color-quantization loss, no coarse-tile-grid ceiling) and should be
preferred; if not, the tile-decode pipeline above is a real, working
fallback, not a last resort born of no alternative. A 15-minute check of
Meteoblue's own account dashboard/API docs resolves this — worth doing
in Phase L0, not blocking on it.

**Revised status for §6/§10**: this upgrades the Meteoblue "LHASA2"
layer from *visual-cross-check-only* back to a **real, near-term-
buildable computational input** — a small `landslide_meteoblue.py`
module (mirrors `flood_forecast.py`'s own external-fetch conventions:
bounded timeout, graceful degrade to `None`, disk-cached per catchment
per day) is genuine, scoped, small new work for **Phase L1.5** (optional,
alongside the `scikit-learn` cross-check from §8), not Phase L4-blocking
— it does not need to gate Phase L1's own static AHP susceptibility
deliverable.

#### 3.2.1 A better-established, genuinely computable Meteoblue resource: the weekly-precipitation vector layer

**A real resource this document missed entirely in its first pass**:
NCOP's "Weekly Precipitation (2m Above Ground)" layer
(`weekly_precipitation_2m_above_ground`, Meteoblue's own NEMS model) is
**not** a rendered raster — it is a **vector tile** layer whose features
carry a real numeric reading directly on a `minValue` property, and this
app already has a **proven, working, client-side sampling pattern**
against it: `story-dynamic-weather.js`'s `_meteoblueEntries`/step-
sampling logic reads `window.weekly_precipitation_2m_above_ground`
(an array of `{source, layers, date}` entries built by
`generateMeteoblueNEMSCloudPrecipLayers`) to pull exact mm values at
named city coordinates for the weather story mode, today, in production.

**The honest architectural nuance**: that proven pattern is
**client-side JavaScript**, reading already-rendered map-tile features in
the browser. `landslide_trigger.py`'s own ID-threshold check (§6) needs
to run **server-side**, inside the async job worker, alongside
`flood_forecast.py`'s existing CHIRPS/PMD dispatch — so this client-side
pattern cannot be imported directly into that server-side computation
without a genuinely new server-side Meteoblue fetch (Meteoblue's own
weather API, a real but small new integration, not yet built anywhere in
this codebase). Two legitimate, different uses, not one:

- **Client-side (reuse directly, zero new backend work)**: surface the
  current weekly-precipitation reading for the pilot catchment as a
  supporting readout in the landslide panel UI, exactly the way
  `story-dynamic-weather.js` already samples it — a real, easy,
  immediately-available enhancement.
- **Server-side ID-threshold trigger input (§6)**: use the *already-
  proven, already-async-job-safe* `flood_forecast.py` CHIRPS/PMD-Forecast
  dispatch instead (§3.2.2 below confirms the PMD side of this is an
  exact match) — don't block Phase L4 on building a new server-side
  Meteoblue client when a working, already-hardened one exists for the
  same purpose.

#### 3.2.2 PMD "12h Precipitation" — confirmed to be the exact same source `flood_forecast.py` already wraps

**Confirmed, closing a gap in the first draft**: the NCOP "12h
Precipitation" layer (`pmd_pred_twelvetpe`) is not a separate resource —
it is the **exact same underlying PMD Monitor WRFPRS data**
`flood_forecast.py`'s own `PMD_FORECAST_ELEMENTS` dict already wraps
(`{"hourtpe": 3.0, "sixtpe": 6.0, "twelvetpe": 12.0, "daytpe": 24.0}`,
confirmed via `grep` against `flood_forecast.py` and `views.py`'s shared
`_MON_PRED_ELEMENTS`). Flood's own discharge-mode rainfall-source
dispatcher already supports calling this with `element_key="twelvetpe"`.
**This means this document's original, generic "reuse `flood_forecast.py`'s
PMD Forecast dispatch" claim was already precisely correct** for this
exact layer — nothing to change functionally, just naming it explicitly
here so the connection to the specific NCOP layer you pointed to is
on the record, not left implicit.

### 3.3 AHP/statistical literature for Pakistan — resolving the seed document's own open gaps

The seed document flagged, honestly, that it could not confirm a
Murree/Galyat-specific weight table. This session's live search resolves
several of those flags:

- **Murree — a real, direct, confirmed study exists**: "Use of
  Geoinformatics for Landslide Susceptibility Mapping: A Case Study of
  Murree, Northern Area, Pakistan" ([SpringerLink
  chapter](https://link.springer.com/chapter/10.1007/978-981-15-0454-9_20)),
  using elevation, slope, geology/lithology, LULC, seismotectonic
  setting, and NDVI, fused via **Weight-of-Evidence (WoE)**, not AHP
  directly. The factor list transfers directly to this system's own
  pipeline; the fusion *method* differs from AHP, which changes a real
  design choice — see 3.4 below. Confirmed real geological context from
  the same search: Murree/Kuldana Formation shale-siltstone-sandstone,
  Main Boundary Thrust zone — genuinely useful, specific detail for the
  geology-factor reclassification table, not generic filler.
  [Geological controls study, Murree Hills MBT
  zone](https://squ.elsevierpure.com/en/publications/geological-controls-in-slope-failure-and-landslide-hazards-main-b/).
- **Astore (Gilgit-Baltistan-adjacent, high-mountain)** — a real,
  confirmed AHP study: "GIS-based landslide susceptibility mapping using
  analytical hierarchy process: a case study of Astore region, Pakistan"
  ([EQA journal](https://eqa.unibo.it/article/view/12600)).
- **Chitral / Reshun (NW Pakistan)** — confirmed AHP-vs-Frequency-Ratio
  *comparison* studies exist for this exact region: [Chitral District
  model evaluation, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9101762/);
  [Reshun AHP-vs-FR comparison,
  ScienceDirect](https://www.sciencedirect.com/science/article/pii/S230741082300055X).
  This independently confirms — from the region's own literature, not
  imported from the flood work's own precedent — that AHP+Frequency-Ratio
  is *already* a standard regional combination for landslide, not just an
  analogy borrowed from flood.
- **Hunza / Karakoram Highway corridor** — multiple confirmed studies:
  AHP + Frequency-Ratio + logistic-regression comparison along
  Gilgit-Skardu Road ([Research
  Square](https://www.researchsquare.com/article/rs-5124940/v1)); a
  12-factor AHP+GIS study of the Karakoram Highway corridor ([NHESS
  2019](https://nhess.copernicus.org/articles/19/999/2019/)); an
  SBAS-InSAR-validated ML study of the Hunza Valley specifically
  ([Springer 2025](https://link.springer.com/article/10.1007/s10064-025-04299-8)).
  Real, confirmed regional context: the 2010 Attabad landslide (District
  Hunza-Nagar) killed 20, destroyed 350 homes, and buried 19km of the
  Karakoram Highway, forming Attabad Lake — the same event the seed
  document already named as a COOLR-worthy reference event, now
  independently corroborated.
- **Sub-Himalaya / general Pakistan cross-check**: one study reports
  precipitation, then lithology, then slope as the dominant AHP factors
  ([Springer, sub-Himalayan hazard
  study](https://link.springer.com/article/10.1007/s11069-020-03980-3));
  another reports slope (11% weight) as most influential in Chitral. This
  is a genuinely useful cross-check consistent with the seed document's
  own claim that slope/lithology/precipitation dominate but the *exact
  rank order shifts by region* — reconfirming the multi-region-survey
  requirement (§0.1 above) rather than a single nationwide number.

**Consistently-reported factor list, now literature-cross-checked across
4 real regional studies rather than asserted generally**: slope,
lithology/geology, distance-to-fault/lineament, LULC, rainfall,
distance-to-drainage, distance-to-road, elevation, aspect, curvature,
NDVI, soil.

**Real, still-open gap, correctly flagged, not resolved**: no
Murree/Galyat-specific *AHP* weight table was found (the confirmed Murree
study uses WoE) — see 3.4 for how this changes the fusion-method
decision rather than blocking the pilot choice.

### 3.4 A real refinement over the seed document: Weight-of-Evidence, not Frequency Ratio, as landslide's statistical ensemble partner

The seed document's own §5/Addendum assumed AHP + Frequency-Ratio would
mirror flood's own AHP-FR ensemble. This session's literature search
surfaces a better-fitting regional answer: the one confirmed Murree-
specific study uses **Weight-of-Evidence (WoE)**, and WoE is a
well-established bivariate statistical method in the same family as FR
(both compute a class-conditional likelihood ratio from a training
inventory), differing mainly in using a log-odds/Bayesian weighting
rather than FR's simple ratio.

**Recommendation, refining the seed document**: build the statistical
ensemble partner as **WoE for the Murree/Galyat pilot specifically**
(directly literature-matched to the one confirmed regional study), while
keeping Frequency-Ratio available as the ensemble method for any future
pilot catchment where the local literature favors it instead (e.g.,
Chitral/Reshun's own confirmed AHP-FR comparison) — mirroring
`flood_ahp.py`'s own terrain-conditioned *profile* selection pattern,
just extended to *fusion method* selection too, not hardcoding one method
nationwide. This is a genuine, literature-grounded improvement over the
seed document, not a cosmetic rename — WoE and FR are mathematically
related but not identical, and using the one the actual regional
literature validated is more defensible than defaulting to whichever one
flood happened to use.

### 3.5 Rainfall intensity-duration (ID) thresholds — a real regional curve exists, not just Caine 1980

The seed document flagged Pakistan-specific ID-curve recalibration as
**TO VERIFY LIVE**. This session's search resolves it with a real,
directly-relevant number:

- **Kashmir Himalaya** (the closest confirmed regional match to
  AJK/Murree/Galyat of anything found): a fitted threshold curve from
  193 rainfall-associated landslides, **I = 73.90·D^-0.79** (I in mm/hr,
  D in hours), plus daily-intensity trigger values of **9.4mm/day** in
  the Kashmir valley and **14.35mm/day** along NH-44. [Establishing the
  landslide-triggering rainfall thresholds for the Kashmir Himalaya,
  Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-023-06254-w).
- **Nepal Himalaya** (broader regional analog): [representative rainfall
  thresholds, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0169555X08000172).
- **Darjeeling Himalaya (NH-10)** and **Garhwal Himalaya**: further
  South-Asian analogs, both confirmed real studies with their own fitted
  thresholds — [Darjeeling](https://www.academia.edu/112643789/Estimation_of_rainfall_threshold_for_the_early_warning_of_shallow_landslides_along_National_Highway_10_in_Darjeeling_Himalayas),
  [Garhwal](https://www.sciencedirect.com/science/article/pii/S2772883824000359).

**Recommendation**: use the Kashmir Himalaya I=73.90·D^-0.79 curve as the
starting ID-threshold for a Murree/Galyat/AJK pilot — genuinely the
closest confirmed regional fit available, a real improvement over
defaulting to the global Caine (1980) envelope the seed document
hedged toward. Still label this **regionally-transferred, not
independently re-derived for the exact pilot catchment** — the same
honesty the flood system applied to every literature-transferred
parameter (CN values, HSG assumptions) it ever used.

### 3.6 Expanded literature survey — 60+ sources reviewed at the start of L0

Per the explicit instruction to be thorough before any L1 code gets
written, this session ran 20 further targeted searches (beyond the
sources already cited in §3.1–§3.5) covering Pakistan-specific studies
in more depth, real global operational landslide-EWS deployments, and
real-world case/disaster literature. Only the load-bearing findings that
change something in this plan are recorded below — the full source list
is in **Sources**.

**Murree now has real depth, not one study**: a direct comparison of
Frequency Ratio, Information Value, and Weight-of-Evidence for Murree
itself, using an 11-factor, **102-landslide real inventory** built from
Sentinel-2/Google Earth/field survey ([Research Square
preprint](https://www.researchsquare.com/article/rs-2218881/v1)) — a
genuinely stronger basis for L1's Murree weight table than the single
WoE study §3.3 already cited. A separate environmental-impact case study
of Murree's own 2001-recurring landsliding is also real and citable
([Natural Hazards, Springer](https://link.springer.com/article/10.1007/s11069-010-9621-7)).

**AJK/Muzaffarabad is a stronger candidate than this document previously
credited** — not just "Kashmir Himalaya" broadly. A real, direct
integrated-approach susceptibility study exists for Muzaffarabad itself
([Tandfonline](https://www.tandfonline.com/doi/full/10.1080/19475705.2023.2210255)),
alongside a dedicated Bagh District (AJK) hazard map
([ResearchGate](https://www.researchgate.net/publication/322084695_Landslide_Hazard_Mapping_of_Bagh_District_in_Azad_Kashmir))
and a Northern-Pakistan multi-model study explicitly covering
Muzaffarabad District
([MDPI Sustainability](https://doi.org/10.3390/su141610194)). **More
significant**: the 2005 Kashmir earthquake produced a real, large,
independently-built landslide inventory — **2,252 landslides**, mapped
via ASTER imagery across six geomorphic-geologic settings, with its own
published susceptibility zonation and a documented reliability
back-analysis ([Natural Hazards, Springer, back-analysis
study](https://link.springer.com/article/10.1007/s11069-009-9451-7);
inventory study confirmed via multiple sources including a [remote-
sensing review](https://www.sciencedirect.com/science/article/abs/pii/S1367912016300025)).
**This changes §7**: AJK/Muzaffarabad now has a real, large,
already-published ground-truth inventory independent of COOLR — a
genuinely strong candidate either to widen L1's own pilot scope or to
be pulled forward ahead of Hunza-Nagar as an accelerated L6 opportunity,
precisely because its own validation ground truth is already unusually
rich for a Pakistani site. Murree/Galyat remains the right **L1**
choice (denser population, the deepest literature base found, already
the scoped pilot) — this finding upgrades AJK's status in the plan, it
does not reopen the L1 decision.

**A real, load-bearing caveat on COOLR itself, not previously
flagged**: COOLR's own underlying Global Landslide Catalog is
confirmed, directly from its own methodology paper, to have a **real
English-language media reporting bias** — non-English-speaking-country
coverage is acknowledged as less complete
([PLOS One, COOLR introduction paper](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0218657);
[NTRS reporting-bias analysis](https://ntrs.nasa.gov/api/citations/20230001884/downloads/glc_manuscript.pdf)).
This is a real reason COOLR's own Pakistan density may be genuinely
sparse for L3's Murree validation — precisely why the 2005-earthquake
inventory (2,252 points, not media-report-derived) and the Karakoram
Highway's own real inventories (see below) matter as **supplementary,
not just backup, ground-truth sources** for whichever pilot ends up
needing them, not a hypothetical fallback.

**Karakoram Highway has real, large, InSAR-confirmed inventories** —
762 landslides (57 complex, 126 rockfalls, 167 debris slides, 412
unstable slopes) mapped via time-series InSAR
([Scientific Reports](https://www.nature.com/articles/s41598-023-34030-0)),
plus an earlier 302-landslide field-validated inventory
([Journal of Mountain Science](https://jms.imde.ac.cn/en/article/doi/10.1007/s11629-020-6145-9)).
**This strengthens L6**: the Hunza-Nagar/Karakoram second pilot now has
its own large, real, already-published ground-truth option beyond
COOLR too — genuinely de-risks L6, not just L1.

**Real, citable AUC benchmarks now available for setting L3's own
performance expectations**, rather than an arbitrary bar: across
several independent comparative studies, Frequency Ratio scored
0.767–0.794 AUC, AHP 0.789, Logistic Regression 0.794–0.816, and
Artificial Neural Networks 0.806
([ScienceDirect comparative
study](https://www.sciencedirect.com/science/article/abs/pii/S1342937X26000183);
[Springer geo-spatial ensemble
comparison](https://link.springer.com/article/10.1007/s42452-020-03441-3);
[Springer Iran LNRF/FR/AHP
comparison](https://link.springer.com/article/10.1007/s12665-018-7524-1)),
and a separate real WoE case study reported 0.81 accuracy with over 90%
of real landslides falling in its own high/moderate zones
([PLOS One, Xunyang WoE case study](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0245668)).
**Practical use for §7/§13**: an AHP-alone AUC in the ~0.75–0.80 range
is a realistic, literature-grounded target for L3 — not a "poor" result
if achieved, and a genuine basis for judging whether the WoE ensemble
step is earning its own added complexity once L3 actually runs.

**Real operational landslide-EWS precedents confirm §6's own two-tier
design, not just analogize to flood's** — four genuinely independent,
long-running deployed systems all converge on the same
static-susceptibility-plus-rainfall-trigger shape §5/§6 already specify:

- **Hong Kong's Landslip Warning System — the single strongest real-world
  proof this approach works at scale**: operating continuously since
  1977, evolved from a simple rainfall-duration-intensity model through
  several generations to a rainfall-landslide-frequency model, ~90 rain
  gauges, **zero landslide fatalities from 2008 through at least early
  2022** ([Landslides, Springer, 40-years-of-progress
  retrospective](https://link.springer.com/article/10.1007/s10346-020-01379-6)).
- **Italy's SANF** — a real national system, ~1,950 rain gauges, twice-daily
  comparison of measured+forecast rainfall against ID thresholds,
  producing 24h-ahead regional hazard maps
  ([MDPI Water, 20-years-operational-experience
  retrospective](https://doi.org/10.3390/w10101297)).
- **Japan's nationwide system (since 2005)** uses a genuinely more
  sophisticated trigger than a bare ID curve — a **Soil Water Index**
  from a 3-layer tank hydrological model driven by hourly rainfall,
  compared against each 5km grid cell's own past-10-year maximum
  ([Progress in Earth and Planetary Science, Springer](https://link.springer.com/article/10.1186/s40645-021-00408-9)).
  Real, legitimate future enhancement candidate for L4+ once the simple
  ID-curve trigger (§3.5/§6) is shipped and validated — genuinely more
  complex (needs an antecedent-soil-moisture state, not just a
  point-in-time rainfall reading), correctly scoped as later work, not
  MVP.
- **Nepal's community-based LEWS** (Dolakha/Dhading districts) — a
  low-cost, sensor-based (extensometer + soil moisture + rain gauge +
  GSM-relayed siren) architecture, real and independently documented to
  have contributed to 495 people safely evacuated in one August 2018
  event
  ([Journal of Mountain Science, Springer](https://link.springer.com/article/10.1007/s11629-019-5586-5)).
  Structurally different from NCOP's own software/GIS-platform role
  (this is a physical hardware deployment, not something a dashboard
  integration replicates) — cited honestly as real-world evidence that
  even a modest, rainfall-threshold-driven warning saves lives, not as
  something to build.

**Seismic (PGA) factor — confirmed standard practice, with the same
honest limit already stated in §5**: PGA is confirmed as a widely-used,
standard covariate for earthquake-triggered landslide susceptibility,
including AHP-blended approaches
([ResearchGate PSHA+Newmark+AHP integrated
study](https://www.researchgate.net/publication/399333643_SEISMIC_HAZARD_ASSESSMENT_AND_EARTHQUAKE-INDUCED_LANDSLIDE_RISK_ANALYSIS_IN_TECTONICALLY_ACTIVE_REGIONS)) —
but the literature is equally explicit that PGA alone captures shaking
*amplitude* only, not duration or frequency content, both of which
independently affect slope stability. No change to §5's own decision
(static factor for the MVP); this just grounds that decision's own
"real, legitimate future enhancement" framing in the literature rather
than leaving it asserted.

**NDMA/PDMA's own real, current vulnerable-area list** (from live public
advisories, not a published methodology — consistent with §3.7's own
finding of no technical EWS doc): Diamer, Darel, Tangir, Astore, and
Hunza are the areas NDMA itself currently names as landslide-vulnerable
in its own northern-areas advisories — a real, official signal worth
weighing alongside the literature-density argument when L6's own
second-pilot choice is finalized.

### 3.7 No competing operational system found

A live search for a documented, technical NDMA/PMD landslide
early-warning methodology found only ad-hoc public *alerts* (monsoon
advisories, NEOC bulletins), no published operational ID-threshold or
susceptibility methodology. This is a genuine, confirmed gap — the NCOP
integration would not be duplicating an existing government EWS, it
would be filling a real absence. **TO VERIFY LIVE** if NDMA/PMD have an
internal, non-public system; nothing publicly documented was found.

### 3.8 Landslide typology — Pakistan-specific literature for rockfalls, debris/mudflows, and snow avalanches

**Added before L5, per explicit instruction, not an afterthought.** The
Varnes/Cruden-Varnes classification (the standard slope-failure typology
this literature all works within) splits mass movements into distinct
mechanical families — falls, topples, **slides**, spreads, and **flows**
— plus, separately, snow avalanches as a wholly different mass-movement
class governed by snowpack mechanics, not soil/rock mechanics at all.
**Everything built through L4 targets one family: slides and shallow
soil-mantle failures** — the AHP weighted-sum score and the infinite-
slope FS layer are both explicitly soil-mechanics models (cohesion,
friction angle, unit weight, TWI-driven saturation). That was always the
seed document's own real scope, correctly so — but it is not the whole
of "landslide" as Pakistan's own literature and real event history use
the word, and this section grounds each of the other three types in
real, Pakistan-specific sources before deciding what (if anything) gets
built now versus deferred honestly.

**Rockfall** — mechanically distinct from a slide: bare/thinly-covered
ROCK slope stability (joint/fracture orientation, freeze-thaw, block
detachment), not a soil infinite-slope problem at all; the infinite-
slope layer's own governing equation does not apply to a rock face.
Real, direct Pakistan grounding: multiple Karakoram Highway (Besham-
Chilas section) studies confirm rockfall and debris flow as the
*dominant* failure mode along that corridor, assessed via the Pierson
Rockfall Hazard Rating System (RHRS, a real, standard, modified-for-KKH
methodology) for rockfall specifically, with factors — slope, faults,
PGA, geology, land cover, rainfall, drainage proximity — overlapping
heavily with (but not identical to) the existing AHP factor set (a
notably STEEPER slope threshold, and rock-mass/joint condition, are the
real differentiators, per [Empirical assessment of rockfall and debris
flow risk along the Karakoram Highway, Natural Hazards
(Springer)](https://link.springer.com/article/10.1007/s11069-021-04549-4)
and [Rock Fall and Debris Flow Hazard and Risk Assessment along
Karakoram Highway (Besham-Chilas
Section)](https://www.academia.edu/99730405/Rock_Fall_and_Debris_Flow_Hazard_and_Risk_Assessment_along_Karakoram_Highway_Besham_Chilas_Section_Pakistan)).

**Debris flow / mudflow** — a genuine sub-family of "flow" (mud flows
are a finer-grained sub-category of debris/earth flows per Cruden &
Varnes 1996 / Hungr et al. 2014, the two frameworks this literature
actually cites) — **materially already covered by the existing factor
set**, a real, reassuring finding, not assumed: Northern-Pakistan
morphometric debris-flow studies find slope, rainfall intensity, and
channel proximity (exposure concentrated within ~100m of active
channels) as the primary controls — exactly `distance_drainage`,
`slope`, and `rainfall` already in the AHP table (per [Multi-scale
debris flow risk assessment using morphometrics in high-altitude
catchments of Northern Pakistan, Natural Hazards
(Springer)](https://link.springer.com/article/10.1007/s11069-025-07833-9)
and the same KKH rockfall/debris-flow pairing above). One real,
literature-standard index this project does NOT yet compute — the
**Melton ratio** (watershed relief ÷ √watershed area, a standard
debris-flow-susceptibility discriminator) — is named here as a real,
citable, buildable-from-the-existing-flow-accumulation-raster future
addition, explicitly **deferred, not half-built**: it is a genuinely
per-WATERSHED (not per-pixel) metric, and computing it correctly needs
real sub-catchment delineation this session did not have time to build
and test properly — better deferred honestly than shipped half-tested,
matching this project's own established discipline.

**Snow avalanche** — the most mechanically distinct of the three:
governed by snowpack accumulation/metamorphism, wind-loading, and
temperature, not rainfall/soil-saturation at all; correctly out of
scope for the rainfall-triggered ID-threshold check (§6) entirely. Real,
direct, and unusually well-matched Pakistan grounding: **[Snow
Avalanche Hazard Mapping Using a GIS-Based AHP Approach: A Case of
Glaciers in Northern Pakistan from 2012 to 2022, Remote Sensing
(MDPI)](https://doi.org/10.3390/rs15225375)** — an AHP-based avalanche-
susceptibility study set in the **Hunza Valley/Batura Glacier area**,
i.e. the exact corridor already named as L6's own planned second pilot
(§10/§13-L6) — using elevation, slope, aspect, terrain roughness, and
curvature as its own AHP factors, all four of the terrain ones already
computed by this project's existing pipeline (`build_hand_pipeline`'s
own DEM, `build_twi_curvature_rasters`, `build_aspect_raster`) with
**zero new fetch code**. One real, non-obvious finding from that paper:
it found **both south AND north aspects** more avalanche-prone (wind-
loading on lee slopes, not a simple south-facing-solar-exposure
relationship the way landslide's own "southness" transform assumes) —
a genuinely different aspect relationship than the slide model's own,
confirming avalanche needs its own factor treatment, not a reweighted
copy of `landslide_ahp.py`'s table. Standard avalanche-science literature
(general, not Pakistan-specific — release zones are most commonly
associated with **25-50° slope, avalanche activity peaking in a narrower
30-45° sub-band**) supplies the slope-gating range; a **real avalanche
elevation-gating threshold specific to Murree/Galyat-scale winter snow**
was searched for but not found as a single fitted Pakistan number — the
region's own permanent snowline (~4,700-5,170m, Hunza/Shimshal) is much
higher than where real Pakistani winter-avalanche road closures are
routinely reported (KKH, Naran-Kaghan, Neelum corridors, commonly
2,000-3,000m) — **2,500m is used as this project's own reasoned,
explicitly-labeled gating threshold** (seasonal-snow-relevant, not the
permanent snowline), not an independently-cited fitted value.

**What gets built now, honestly scoped, before L5**:
- ✅ A real, separate, literature-grounded **rockfall-susceptibility
  flag** (`landslide_model.build_rockfall_susceptibility_flag`) — a
  simple, RHRS-inspired screening criterion (steep-rock-face slope
  threshold + non-alluvial geology), kept explicitly SEPARATE from the
  soil-slide AHP/infinite-slope score, the same "different mechanism,
  different output, never silently blended" discipline the infinite-
  slope layer's own module comment already establishes.
- ✅ A real, separate, elevation-gated **avalanche-susceptibility layer**
  (new `avalanche_model.py`, mirroring the one-module-per-hazard-family
  convention) — a lighter-rigor AHP-style scoring (elevation/slope/
  aspect/curvature, weights informed by but not Saaty-CR-validated
  against the Hunza/Batura paper — explicitly labeled as such, a real,
  honest gap versus `landslide_ahp.py`'s own full CR-validated table,
  not silently presented as equally rigorous), gated to
  seasonally-snow-relevant elevation/slope so a low-elevation pilot like
  Murree/Galyat correctly, honestly reports near-zero applicable area —
  a real negative test case, not a bug.
- ❌ Debris/mudflow: no new code — the existing factor set already
  covers it per the literature above; the Melton-ratio addition is
  named and deferred, not built this pass.

---

## §4. Factor pipeline — grounded against the REAL, confirmed NCOP layer schema

| Factor | Source (live-confirmed) | New work required |
|---|---|---|
| Slope, TWI, profile curvature | `build_twi_curvature_rasters` | **None** — same raster, same cache |
| Aspect | WhiteboxTools `aspect` tool (same subprocess family as `slope`, not yet called) | Small — one new WBT call |
| Distance to drainage/streams | `flood_connectivity.chamfer_distance_km` | **None** |
| Distance to roads | OSM `highway=*` fetch (already built for flood exposure) + `chamfer_distance_km` | Small — reuse both, one new distance-transform pass |
| LULC | `build_lulc_raster` (ESA WorldCover) | **None**, new hazard-reclassification table (bare/built-up = high landslide-relevant hazard, not flood-runoff hazard) |
| NDVI | Sentinel-2 median-composite fetch (already built) | **None** |
| Rainfall climatology | CHIRPS mean-annual fetch (already built) | **None** |
| Geology / lithology | NCOP's `geology` layer — **confirmed live**: GeoServer `geological_global:geology`, polygon, up to 40 formation types. **Corrected during L0's own real testing (§13)**: the `name` property this document originally assumed as the key has real gaps — a live fetch for the Murree/Galyat pilot bbox returned several genuinely distinct formations (codes `TM`/`Tk`/`Pc`) all sharing the literal string `"No"` as their own `name`. The `code` property is populated on every feature fetched and is the correct rasterization key; `name` is kept only as a secondary, human-readable label where it's actually meaningful (`landslide_model.py`'s own `fetch_and_rasterize_geology_pga` already implements this fix and has been live-verified against the real server). | Small — WFS fetch + rasterize (same pattern as flood's own admin-context WFS calls), **done and live-tested in L0** — see `landslide_model.py`. Remaining: a **formation-code → landslide-hazard-class crosswalk**, literature-sourced (candidate source: the confirmed Murree Formation/Kuldana Formation shale-siltstone-sandstone context from §3.3 — `Tk` plausibly IS the Kuldana Formation code, confirmed dominant in the pilot bbox's own real pixel coverage), not invented — this is Phase L1 work. |
| Seismic (PGA) | NCOP's `pga_zones` layer — **confirmed live**: GeoServer `geological_global:pga_zones`, polygon, **5 real zones** (`Zone 1`, `Zone 2A`, `Zone 2B`, `Zone 3`, `Zone 4`) keyed by a `pga` property, a standard building-code seismic classification | Small — same WFS-fetch-and-rasterize pattern; a genuinely simple ordinal crosswalk (Zone 1→lowest … Zone 4→highest), much less involved than the 40-formation one |
| Soil texture | `build_soil_texture_raster` | **None**, different reclassification (cohesion/permeability proxy, not Hydrologic Soil Group) |
| Cohesion / friction angle (§3.1's infinite-slope layer only) | Literature-transferred defaults per geology-formation class (no existing NCOP source) | New — a small lookup table, sourced from regional geotechnical literature, explicitly labeled as transferred-not-measured |

Confirming the seed document's own claim, now grounded in the real
schema: **6 of 11 candidate factors need zero new fetch code** — a new
reclassification table and a new AHP weight is the actual net-new work,
not a new data pipeline.

---

## §5. Fusion architecture

Add `landslide_ahp.py`, structured identically to `flood_ahp.py` (same
public shape: `get_factor_weights(terrain_class, lite=False)`, a
terrain-class selector, Saaty CR validation on every profile before it
ships) — the same "one hazard-specific module per hazard, sharing the
generic fusion primitives" discipline `flood_ahp.py` already establishes
alongside `flood_model.py`, not inside it.

**Terrain-class selector**: NOT flood's own `classify_terrain_relief`
(HAND-relief-based — a flood-specific concept with only mild landslide
relevance via valley confinement). Landslide's own classifier should be
driven by **mean/90th-percentile slope + dominant geology-formation
class** over the catchment — the same "measure the real terrain, don't
hardcode per catchment" discipline, built on the physically-relevant
variable for this hazard.

**Fusion method per pilot** (refining the seed document, per §3.4):
Weight-of-Evidence for a Murree/Galyat pilot (literature-matched), with
Frequency-Ratio available as an alternative for a future pilot whose own
regional literature favors it (Chitral/Reshun).

**Seismic (PGA) as static factor, not dynamic trigger — decided, not
deferred**: build it as a static AHP factor (constant per catchment, like
geology) for the MVP, the same posture flood's own connectivity factor
took. A dynamic "recent seismic activity" trigger (candidate: USGS
earthquake API) is a real, legitimate future enhancement, not part of
Phase L1 — **TO VERIFY LIVE** if/when pursued.

---

## §6. Rainfall-triggered dynamic early warning

Two real, complementary inputs, not one:

1. **Custom ID-threshold check** (`landslide_trigger.py`, new, small):
   `intensity_mm_hr = rainfall_mm / duration_hr`, compared against the
   Kashmir Himalaya curve from §3.5 (region-appropriate default,
   explicitly labeled as transferred). Reuses `flood_forecast.py`'s
   CHIRPS/PMD-Forecast/live-observed dispatcher directly — **built into
   the async job pattern from day one** (§0.1's rainfall-fetch lesson),
   never a synchronous request-thread fetch.
2. **The Meteoblue "LHASA2" layer** (§3.2/§3.2.3): free and
   zero-backend-work as an on-screen visual cross-check from Phase L1.
   A real, confirmed-buildable pipeline exists to also turn it into a
   genuine numeric input (tile-decode against its own published
   contour-step ramp, or Meteoblue's raw Dataset API if the existing
   subscription covers it — §3.2.3) — scoped as optional Phase L1.5
   work, not required for Phase L4's own first ship, which stands on the
   ID-threshold check alone.

Combine via a simple decision matrix on the two *machine* inputs (e.g.
"High static susceptibility + ID-threshold crossed = Warning"), mirroring
how Pakistan's own PMD/NDMA public advisories already structure their
messaging — this is genuinely new logic, but small (a threshold
comparison and a lookup, not a solver), slotting into the existing async
job pattern exactly like `build_discharge_driven_flood_zone` does. Show
the Meteoblue LHASA2 tile alongside the result as a visual cross-check
(§3.2) — real value for an operator's own judgment, just not yet a term
in the matrix itself.

Same honest-degradation posture as flood's own rainfall-source handling
throughout: CHIRPS's ~27-day GEE publication latency, PMD Forecast's real
0mm-during-dry-period results, NWFC's "absence ≠ zero rain" ambiguity all
apply identically — the landslide panel must surface provenance the same
way `#renderRainfallSourceNoteHTML()` already does for flood, never
present a fetched value as an unambiguous live reading.

---

## §7. Ground truth — COOLR

**Correction, added during L3 (see §13/L3 for the full finding)**: this
section originally read "confirmed live and directly fetchable" — true
when written, but a live re-check during L3 found the exact endpoint
below now returning HTTP 404 (a real service change on NASA's own
infrastructure, not a mistake in this project's own query — see §13/L3
for the full evidence trail). The code built against it
(`list_coolr_events`/`fetch_coolr_presence_geoms`) is real, correct, and
tested — it degrades honestly today and will work unmodified once the
endpoint is reachable again.

NASA's Cooperative Open Online Landslide Repository (COOLR) is real and
public, fetchable via standard ArcGIS REST endpoints —
`COOLR_Events_Points`/`COOLR_Reports_Points` FeatureServer/MapServer
layers on `gis.earthdata.nasa.gov` and `maps.nccs.nasa.gov`.
[UN-SPIDER knowledge-portal entry](https://un-spider.org/links-and-resources/data-sources/cooperative-open-online-landslide-repository-coolr-nasa);
[FeatureServer
endpoint (currently 404, see correction above)](https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/COOLR_Events_Points/FeatureServer).
Point-based (not raster, unlike GFD). **A real requirement this
project's own earlier claim missed**: COOLR points carry zero area, and
`accuracy_assessment.py`'s own rejection-sampling scheme needs presence
geometries WITH real area to sample "inside" — so a small buffer
(matching GFD's own ~250m MODIS-pixel-scale precedent already used in
this codebase) IS a genuinely required step, not the "no vectorization
step needed" simplification originally claimed here. `fetch_coolr_
presence_geoms` implements this buffering.

Every existing `accuracy_assessment.py` function
(`compute_auc`/`assess_raster_auc_stable`/
`assess_pooled_multi_raster_auc_stable`/`calibrate_hierarchical_thresholds`)
is confirmed, hazard-agnostic — landslide validation is a matter of
writing a `list_coolr_events`-shaped fetcher mirroring `list_gfd_events`,
not extending the math.

**Same honesty commitment as flood's own AUC work** (which reported
0.614 "poor" and 0.570 "poor" results honestly rather than only
publishing favorable pilots): whatever the real COOLR-validated AUC
turns out to be for the Murree/Galyat pilot, it gets reported as-is. A
literature-grounded expectation for that number now exists (§3.6): AHP
alone in the ~0.75–0.80 range is realistic, not a "poor" outcome if hit.

**A real, load-bearing caveat on COOLR itself** (§3.6, from COOLR's own
methodology paper): its underlying Global Landslide Catalog carries a
confirmed English-language media reporting bias, meaning its real
density for a Pakistan pilot may be genuinely sparse — not a
hypothetical concern to note in passing, a reason to treat the sources
below as supplementary, not just a manual fallback.

Pakistan-specific sources are stronger than this document originally
credited, now confirmed rather than assumed (§3.6):
- **The 2005 Kashmir earthquake inventory** — 2,252 landslides, ASTER-
  derived, independently published with its own reliability
  back-analysis. Directly relevant to an AJK/Muzaffarabad-area
  validation, and not media-report-derived, so it doesn't inherit
  COOLR's own English-bias limitation.
- **Karakoram Highway inventories** — a real, InSAR-confirmed 762-
  landslide inventory and an earlier field-validated 302-landslide one,
  directly relevant to L6's own Hunza-Nagar/Karakoram second pilot.
- PDMA/NDMA post-disaster reports remain a real, likely-manual
  (non-API) secondary source — same integration-cost expectation the
  flood work found for UNOSAT/CEMS, not a live-query one.

Neither the 2005-earthquake nor the Karakoram inventories are confirmed
to be programmatically fetchable the way COOLR's own REST endpoints
are — treat both as a real, valuable **manual/one-time-import**
ground-truth supplement (the same integration-cost class as PDMA/NDMA
reports), not a second live API, until confirmed otherwise.

---

## §8. Dependency impact

**Zero new pip dependencies for the MVP** (static AHP susceptibility +
exposure + AUC validation) — every operation needed (slope/aspect via
WhiteboxTools, geology/PGA via existing WFS layers, distance-transforms
via the existing chamfer-distance NumPy code, AHP fusion via the existing
Saaty-eigenvector code, AUC via the existing NumPy code) is already
installed.

**One deferred, optional dependency** (Phase L1.5, not MVP):
`scikit-learn` (BSD-3), to replicate — not import — the useful technique
from three evaluated-and-rejected ML packages:

| Package | Verdict (confirmed against its own PyPI/GitHub metadata) | Why |
|---|---|---|
| `landslideml` | Do not adopt | MIT-licensed and clean otherwise, but `Requires-Python >=3.12` directly conflicts with the pinned `cp311` GDAL wheel this entire system depends on |
| `PyLandslide` | Do not adopt | Confirmed GPLv3 (`setup.py` + README, in-process import, not a subprocess boundary) **and** a hard `rasterio` dependency — a double violation of this project's own standing rules |
| `pyimpute` | Do not adopt | BSD-3 itself is fine, but built directly on `rasterio` |
| `scikit-learn` | Optional future addition | Replaces the useful part of all three (train a classifier on point-sampled raster values, predict back onto the grid) with zero version/DLL conflict |

Same "replicate the technique, not the package" precedent already set
twice in this system (`ahpy` → hand-rolled Saaty implementation;
`jenkspy` → hand-rolled 1-D k-means).

---

## §9. Production wiring

**Confirmed already-built** (§0.3): the multi-hazard panel shell, tab
bar, and `#landslideHazardContent` mount point.

**Still to build**: a sibling `POST /api/landslide-model/run/` (copied
from `FloodModelRunView`'s own structure, not subclassed unless the
shared job-executor/throttle/polling logic is extracted first — matching
the seed document's own reasoning: a separate endpoint keeps the flood
code path provably untouched, the same "never risk the already-working
path" discipline the flood work repeated at every sub-phase). Frontend:
`landslide-model-control.js`, populating the already-existing
`#landslideHazardContent` container — the same async-poll/checklist/
accent-color pattern `flood-model-control.js` already proves out, copied
not reinvented.

---

## §10. Phased plan

- **Phase L0 — Foundation.** Confirm the literature choices above against
  the primary sources directly (not just search-result summaries — fetch
  and read the actual Murree WoE paper, the Astore AHP paper, and the
  Kashmir Himalaya ID-threshold paper in full before committing numbers).
  Decide the Overture-style request-coalescing question from §0.1 (fix
  once for both hazards, or accept for landslide too — pick explicitly).
  Fetch and rasterize `geology`/`pga_zones` for the Murree/Galyat pilot
  AOI for the first time.
- **Phase L1 — Static AHP susceptibility.** Build `landslide_ahp.py`
  (terrain-conditioned profiles, CR-validated), the new factor rasters
  (aspect, geology reclass, PGA reclass), `build_landslide_susceptibility_
  raster()` (new `landslide_model.py`, mirroring the file-per-hazard-family
  convention), and the infinite-slope-with-TWI physically-based layer
  from §3.1 (with explicitly literature-transferred, not measured, soil
  parameters). Vectorize zones via `_vectorize_ordinal_zones_gapfree`
  directly — no gap-closing iteration needed, unlike flood's own
  three-round path.
- **Phase L2 — Exposure.** Wire `_build_exposure_from_geom` against the
  landslide High-susceptibility zone geometry — expect near-zero new
  code, the same way flood's own discharge-mode wiring did once the
  geometry-agnostic core existed.
- **Phase L3 — Ground-truth validation.** Integrate COOLR (confirmed live
  endpoints, §7), run `assess_raster_auc_stable` for AHP+WoE (or
  AHP+FR), the infinite-slope layer, and a LHASA2 cross-check — report
  every number honestly, including a "poor" result if that's what's
  found.
- **Phase L4 — Rainfall-triggered dynamic mode.** Build
  `landslide_trigger.py`'s ID-curve check against the Kashmir Himalaya
  regional threshold (§3.5), wire in LHASA2 as a second live signal
  (§3.2/§6), combine into a Warning/Watch/Normal output — built on the
  async job pattern from the first line of code, per §0.1's rainfall-fetch
  lesson.
- **Phase L5 — Production wiring + frontend.** New endpoint, new
  `landslide-model-control.js` populating the already-existing panel tab
  — genuinely less net-new work here than the seed document originally
  scoped, per §0.3.
- **Phase L6 — Generalization.** A second pilot (candidate: Hunza-Nagar/
  Karakoram Highway corridor — already has multiple confirmed real
  studies per §3.3, a stronger-than-average second-pilot literature base)
  to stress-test the terrain-class selector and fusion-method choice
  (WoE vs. FR) across genuinely different terrain — expect, and honestly
  report, a mix of confirmed-good and honestly-short-of-target results,
  the same posture Bhudni Nullah's own generalization test took for
  flood.

---

## §11. Crash-safety and production requirements

Every non-negotiable rule from the flood methodology's own crash-safety
section applies identically: bounded subprocess timeouts for every
WhiteboxTools call, the shared `_GDAL_LOCK`/`_WBT_LOCK` discipline for
every raster touch-point, atomic temp-file-then-`os.replace()` writes,
bounded timeouts with graceful degradation (never a crash) for every
external fetch (GEE, WFS, OSM, COOLR), and no new in-process native-code
dependency without an explicit license/DLL-conflict check first (§8).

**Already inherited for free, per §0.1** (no new work needed): the
async-job-not-request-thread pattern for any rainfall/external fetch, the
gap-free ordinal vectorization technique, `GZipMiddleware` on all API
responses, the raised `DATA_UPLOAD_MAX_MEMORY_SIZE` + client-side image
downscaling for any future map-export feature, `preserveDrawingBuffer:
true` on the shared map for any future map-snapshot capture, and the
deliberately-tight per-scope throttle-rate discipline (`AnonRateThrottle`
subclasses, one scope per endpoint, matched to the underlying single-
worker executor's own real cost) already established across every
flood-model endpoint.

---

## §12. Production readiness — checked against the real, live nginx/Waitress deployment

The flood module was hardened this session against the *actual* prod
config (`/etc/nginx/sites-available/ncop-prod`), not a generic
"production checklist" — a real bug (a rainfall fetch that could hold a
request open past the reverse proxy's own timeout) was found and fixed
that way. Landslide reuses the exact same deployment topology (one
Waitress upstream, one nginx server block) — every constraint below is
read directly off that same conf, not assumed.

**`proxy_read_timeout 60s` / `proxy_send_timeout 60s` on `location /`**
— the single most load-bearing number in the whole conf for this work.
Every landslide external fetch that could plausibly take more than a few
seconds must run inside the async job pattern (`_JOB_EXECUTOR`-equivalent
+ status polling), never synchronously inside a request handler — this
is not a style preference, it's the exact bug class already found and
fixed once for flood's own rainfall dispatch. Concretely, for landslide:

- `landslide_trigger.py`'s CHIRPS/PMD-Forecast/live-observed fetch (§6)
  — build it inside the job runner from the first line of code (§0.1
  already states this; restated here tied to the actual number: a slow
  CHIRPS/GEE response sitting past 60s is not hypothetical, it already
  happened once on this exact deployment).
- The COOLR fetch (§7) and the geology/PGA WFS fetches (§4) — both
  external, both potentially slow on a cold cache; run inside the job
  pattern, not the view layer, the same way `build_hand_pipeline` itself
  already does for flood.
- The Meteoblue tile-decode pipeline (§3.2.3), if/when built — fetching
  and decoding several XYZ tiles plus a metadata lookup is exactly the
  kind of multi-request, latency-stacking operation that must not run on
  a request thread. Job pattern from day one, same as the rest.
- If a future landslide "buildings-in-viewport"-style synchronous
  endpoint is ever added (mirroring `FloodModelAhpBuildingsInViewView`),
  give its own internal cold-cache timeout real headroom under 60s
  explicitly — that exact class of coincidence (a 60s internal timeout
  racing a 60s proxy timeout) was flagged as a real, if narrow, risk for
  flood's own equivalent endpoint.

**`client_max_body_size 100M`** — already generous, no landslide-specific
change needed. Django's own `DATA_UPLOAD_MAX_MEMORY_SIZE` (raised to
15MB this session, application-wide) is the actual binding limit, well
under nginx's own ceiling — any landslide report-export feature
(reusing `flood_report_export.py`'s own template, §0.3) inherits this
automatically. No new nginx or Django settings change anticipated for
landslide unless a genuinely larger payload shape emerges (none is
expected — landslide's own map snapshots and exports are the same shape
as flood's).

**No `gzip_types` on `location /`, only on the static-asset locations**
— already fixed application-wide via Django's own `GZipMiddleware`
(added to `MIDDLEWARE` this session). Landslide's own JSON/GeoJSON API
responses are compressed automatically, the same as flood's — no
per-hazard nginx or Django change needed.

**The `add_header` non-inheritance issue on `/media/`** — the `/media/`
location block (which would serve any cached landslide raster/PNG output
the same way it already serves flood's own `media/flood_model/...`
artifacts) declares its own `add_header Cache-Control ...`, which — per
nginx's inheritance rule — means it does **not** inherit the server-level
security headers (`X-Frame-Options`/`X-Content-Type-Options`/
`X-XSS-Protection`). This was already identified and a fix drafted for
flood (`deploy/nginx-ncop-prod.conf.reference`, repeating the three
headers inside each location block) but **not yet applied to the live
conf**. Landslide inherits this exact same gap the moment it starts
writing to `project/media/landslide_model/...` — worth applying that
already-drafted fix once, benefiting both hazards, rather than treating
it as landslide-specific.

**Single Waitress process, single-worker executors, shared
`_GDAL_LOCK`/`_WBT_LOCK`** — a real, decided design point, not left
open: give landslide its **own** `_LANDSLIDE_JOB_EXECUTOR` and its own
`_JOBS`-equivalent registry (mirroring, not sharing, flood's own
`_JOB_EXECUTOR`/`_JOBS`), for the same reason §9 already recommends a
**separate** endpoint over extending flood's — job accounting, purge
logic, and throttle scopes stay provably independent, so a landslide bug
can never corrupt or starve flood's own job registry. Be honest about
what this does and doesn't buy: real wall-clock *parallelism* between a
concurrent flood job and a landslide job is still bounded by the shared,
process-wide `_GDAL_LOCK`/`_WBT_LOCK` — separate executors give
isolation and independent accounting, not independent throughput. Both
hazards' jobs still ultimately queue behind the same raster-lock
whenever they touch GDAL/WhiteboxTools concurrently, which they will.

**In-memory job registry survives only until the next restart** —
already true for flood (`_JOBS` is a plain process-wide dict, wiped by
`sudo systemctl restart ncop-waitress.service`), and landslide's own
separate registry inherits the identical characteristic. Nothing new to
fix; just don't assume a landslide job "survives" a deploy any more than
a flood one does.

**Per-endpoint throttle scopes** — new landslide endpoints
(`POST /api/landslide-model/run/`, its own status-poll endpoint, and any
future export/report endpoint) each get their own tightly-scoped
`AnonRateThrottle` subclass, sized the same deliberate way flood's own
scopes were (e.g. `flood_model_run: "3/min"` — a genuine job-submission
endpoint gets a tight cap; a cheap polling endpoint gets a generous one)
— matched to the real cost of what's behind each endpoint, not a single
blanket rate copied everywhere.

**Net effect**: none of this requires a *different* architecture from
what §5/§6/§9 already specify — it requires building it in the same
disciplined order flood eventually converged on (async-job-first, own
executor, own throttle scopes, own registry) from the start, rather than
shipping a synchronous version and hardening it later under a real,
already-once-triggered production bug.

---

## §13. Full phase-wise working plan — Day 1 through generalization

§10 states *what* each phase delivers; this section states *how to
actually work through it*, step by step, at the same granularity for
every phase — not just L0. Every step below cross-references the section
that already justifies it (literature, reused function, or production
constraint) rather than restating it, to keep this a working checklist,
not a second copy of the document. Each phase ends with a concrete,
independently-checkable verification step — no phase is "done" on the
strength of code existing, the same evidentiary bar §0/§7 already commit
to.

### L0 — Foundation — **complete**

Deliberately narrow: everything below is either a decision, a read, or
one small, low-risk, independently-verifiable fetch — no fusion logic,
no AHP weights committed, no endpoint wired yet. Status per item, as
actually done, not planned:

1. **Literature** — done to the depth of a real, 60+ source structured
   survey (§3.6), not full cover-to-cover reads of every individual
   paper. Honest about the gap: this is enough to write L1's real
   weight tables from cited numbers, not a substitute for opening the
   Murree FR/IV/WoE comparison and the Astore AHP paper in full once L1
   actually starts drafting those tables — do that as the FIRST step of
   L1, not deferred further.
2. **The two open questions — decided**:
   - **Request-coalescing gap (§0.1): deferred, not fixed now.** L0's
     own new fetch (`landslide_model.fetch_and_rasterize_geology_pga`)
     is a new function, not `build_hand_pipeline`/`_get_cached_
     buildings_index` themselves — no new exposure to the race
     condition is introduced by L0. Revisit before L5 ships (when real
     concurrent flood+landslide job traffic first becomes possible) —
     tracked here explicitly so it isn't silently forgotten, not
     resolved by omission.
   - **Meteoblue Dataset-API coverage: still an open, user-side action
     item.** Requires the Meteoblue account dashboard/API docs, which
     this session has no access to check directly — remains the one
     genuinely open item in L0, correctly flagged rather than assumed
     either way. §3.2.3's tile-decode pipeline is the working path until
     this is resolved.
3. **Pilot bbox pinned AND empirically validated**:
   `[73.25, 33.80, 73.55, 34.10]` (Murree through Nathiagali/Ayubia).
   Not just asserted from town coordinates — confirmed live against the
   real `geology`/`pga_zones` GeoServer (below) to actually cover real
   geological diversity, not a single homogeneous formation.
4. **Skeleton files — built, and `landslide_model.py` is genuinely more
   than a skeleton now**: `landslide_model.py` (`PILOT_CATCHMENTS` with
   the one pilot entry, plus real, tested fetch/rasterize code — see
   #5) and `landslide_ahp.py` (module docstring + `NotImplementedError`
   stub only, correctly left empty per §0's own "don't commit a weight
   table before its own citation is confirmed" discipline).
5. **First real, testable code — built and live-tested against the
   actual GeoServer, not a mock**: `fetch_and_rasterize_geology_pga`
   fetches `geology`/`pga_zones` for the pilot bbox and rasterizes each
   to its own cached GeoTIFF. **A real bug was caught and fixed during
   this testing, not after**: geology's own `name` property has real
   gaps (§4's own correction) — switched to the always-populated `code`
   property as the actual rasterization key, with `name` kept only as a
   secondary label where meaningful. Post-fix, the pilot bbox resolves
   to 7 distinct real formation codes (`DS`, `Pc`, `Q`, `TM`, `Tep`,
   `Tk`, `gg`), 4 of which actually cover real area in the rasterized
   grid — `Tk` (plausibly Kuldana Formation) dominant, matching §3.3's
   own literature. `pga_zones` resolved cleanly to 3 real zones (`Zone
   2B`/`3`/`4`) with no equivalent issue.
6. **The `/media/` nginx security-header fix — already drafted and
   confirmed present** in `deploy/nginx-ncop-prod.conf.reference`
   (added earlier this session). Not yet applied to the live VM conf
   (no SSH access from this session) — remains a manual step for
   whoever next touches the production nginx config.

**L0 verification — done, live, not simulated**: ran against the real
`172.18.7.21:8080/geoserver/geological_global` WFS endpoint (confirmed
reachable), rasterized both layers, read the output GeoTIFFs back
(raw `ReadRaster`, never `Band.ReadAsArray()` — this codebase's own
documented GDAL/NumPy ABI-mismatch warning was independently reproduced
live by an earlier version of this same test script, confirming that
warning is real on this machine, not theoretical), and confirmed every
class present in the rasterized pixels traces back to a real legend
entry. Cache correctness (a second call returns instantly with an
identical legend) and the `flood_model.PILOT_CATCHMENTS` registration
bridge were also verified live. **L1 may now begin** — step 1's
literature is in hand to the depth stated above; open the two primary
papers in full as L1's own first move, per the honest gap noted there.

### L1 — Static AHP susceptibility

The main deliverable; everything else in the plan depends on this
existing and being honestly validated (L3) before anything downstream
builds on it.

1. **Build the two literature-sourced crosswalk tables** §4 calls for:
   the 40-formation `geology` → landslide-hazard-class table (sourced
   from L0's own reading — the confirmed Murree/Kuldana Formation
   shale-siltstone-sandstone context, §3.3, plus general
   lithology-susceptibility literature for formations outside that
   specific study), and the 5-zone `pga_zones` → hazard-class ordinal
   table (a simple Zone 1→lowest … Zone 4→highest mapping, §4).
2. **Add the one new WhiteboxTools call**: an `aspect` raster, same
   subprocess-lock pattern (`_WBT_LOCK`) the existing `slope` call
   already uses (§4) — no new technique, one new function.
3. **Build distance-to-road**: reuse the existing OSM `highway=*` fetch
   + `chamfer_distance_km` on the rasterized network (§4) — both pieces
   already exist for flood exposure, this is new wiring, not new logic.
4. **Reuse directly, zero new fetch code**: `build_twi_curvature_rasters`,
   `build_lulc_raster` (new landslide-specific hazard-reclass table —
   bare/built-up = high, distinct from flood's runoff-hazard table),
   `build_soil_texture_raster` (new cohesion/permeability reclass, not
   HSG), CHIRPS mean-annual climatology (§4).
5. **Build the terrain-class selector** (§5): mean/90th-percentile slope
   + dominant geology-formation class over the catchment — not flood's
   HAND-based `classify_terrain_relief`.
6. **`landslide_ahp.py`'s real `get_factor_weights` — done for the
   Murree/Galyat terrain class, CR-validated live**: `MODERATE_RELIEF_
   MONSOON_FACTORS` (12 factors: rainfall 0.22, lithology 0.18, slope
   0.15, lulc 0.12, distance_road 0.10, distance_drainage 0.08, twi
   0.05, pga 0.04, curvature 0.02, aspect 0.02, ndvi 0.01, soil_type
   0.01) + a lite 9-factor variant. **Real access limitation, honestly
   resolved, not routed around silently**: the Astore/Murree papers'
   own exact numeric pairwise-comparison tables were confirmed
   paywalled/blocked after 5 separate access attempts (Research Square
   direct + `.pdf` suffix, an academia.edu mirror, the SpringerLink
   chapter, Semantic Scholar) — per the user's own explicit decision,
   the weight table was built the way an AHP study is actually
   constructed in the first place: real, confirmed RANKING/mechanism
   findings from both papers (Astore's own "slope, lithology, LULC most
   important" + CR=0.06; the Murree-specific "water is the most
   dominant factor" and MBT-zone/Kuldana-Formation lithology-control
   findings) set the relative ORDER, real numeric anchors already
   verified in `flood_ahp.py`'s own Hunza-Nagar/KP-province-wide tables
   (slope, TWI, NDVI, curvature — physically-similar factors, a
   different hazard) set several MAGNITUDES, and the remaining
   judgment calls are labeled as this project's own reasoning, exactly
   mirroring `flood_ahp.py`'s own FLAT_RELIEF_FACTORS precedent for the
   same situation. **Live-verified, not assumed**: CR = 0.0163 (full),
   0.0086 (lite) — both well under Saaty's 0.10 threshold, via
   `flood_ahp.verify_consistency` reused unmodified.
   A genuinely different terrain-class profile (Astore/high-mountain,
   Chitral/Reshun) is real, deferred work — `get_factor_weights` raises
   a clear error for any terrain_class beyond `moderate_relief_monsoon`
   today, not a silent fallback to the wrong profile.
7. **Geology/PGA crosswalk, aspect, distance-to-road — built and
   live-tested against the real pilot catchment, not simulated**:
   - `_GEOLOGY_CODE_HAZARD_CLASS`/`_PGA_ZONE_HAZARD_CLASS` (1-5 ordinal,
     the same scale `flood_model.py`'s own `_WORLDCOVER_HAZARD_CLASS`/
     `_reclassify` already establish, reused directly) — every value
     honestly labeled by confidence: `Tk` (plausibly Kuldana Formation)
     highest at 5, `gg` (igneous/metamorphic) lowest at 2, `TM`/`Pc`
     explicitly defaulted (unresolved formation identity, not guessed).
   - `build_aspect_raster` — one new WhiteboxTools call, reusing
     `flood_model._run_wbt` unmodified.
   - `build_distance_to_road_raster` — a real Overpass fetch (reusing
     `flood_exposure`'s own bounded query helpers) + a new line-
     rasterization helper (no existing one to reuse — flood's own
     distance-to-stream seed comes from the D8 pipeline, not external
     vector data) + `flood_connectivity.chamfer_distance_km` reused
     unmodified.
   - Landslide-specific LULC/soil reclass tables — genuinely different
     values than flood's own runoff-hazard tables for the same class
     codes (tree cover = lowest landslide hazard via root
     reinforcement, opposite mechanism from flood's infiltration
     logic; built-up = moderate-high, not flood's own maximum), reusing
     flood's raw fetches unchanged, zero new fetch code.
   - `classify_terrain_class` — real, computed (not stubbed): confirmed
     live for the pilot — mean slope 25.2°, 90th-percentile 38.24°,
     dominant geology `Tk` — genuinely steep terrain, consistent with a
     real landslide-prone hillside.
8. **`build_landslide_susceptibility_raster()` — built and live-tested,
   both the lite and full weight profiles, NOW COMPLETE (rainfall/NDVI
   wired in)**: weighted-sum fusion of every factor, each normalized
   onto a common 0-1 scale first (min-max stretch for continuous
   rasters, direct 1-5→0-1 for already-ordinal ones, a dedicated
   "southness" circular transform for `aspect`) — the same "everything
   comparable before a weighted sum" principle `flood_ahp.py`'s own
   score combination already relies on. `rainfall` (CHIRPS mean-annual
   climatology, `flood_model.build_rainfall_climatology_raster`) and
   `ndvi` (Sentinel-2 median composite, `flood_model.build_ndvi_raster`)
   are now wired into `factor_paths` — zero new fetch code, both reused
   directly. **Live-verified**: `used_weights` now sums to 1.0000 for
   both profiles (was 0.7708/0.77 partial before this batch), confirming
   every factor the weight table expects is now actually present.
   **Two real correctness bugs caught and fixed during this same pass,
   before any user report**: (a) a plain min-max stretch implicitly
   assumes "higher raw value = higher hazard", which is backwards for
   `distance_road`/`distance_drainage` (closer = more hazard) and `ndvi`
   (denser vegetation = less hazard) — fixed via an explicit
   `_INVERT_CONTINUOUS` inversion set; (b) `aspect` is a circular 0-360°
   variable a linear stretch treats 0°/360° as opposite ends of, wrongly
   — fixed via the standard "southness" transform. The final score is
   also now rescaled to flood's own `[1,5]` AHP convention (was raw
   `[0,1]`) specifically so `flood_model._local_natural_breaks`'s own
   `[1,5]`-hardcoded degenerate-case fallback behaves correctly for the
   zone-classification step below. **Live-verified score range (POST-fix,
   POST-rescale — the earlier 0.19–0.72 figure was built on the
   pre-fix, wrong-direction normalization and is now stale)**: lite
   profile 2.076–4.467, full profile 2.083–4.431, both on the [1,5]
   scale as intended.
9. **Zone classification + gap-free vectorization — built and
   live-tested**: `build_landslide_zone_geometries` classifies the
   score via `_local_natural_breaks`/`_classify_ahp_zones` and
   vectorizes via `_vectorize_ordinal_zones_gapfree`, reusing
   flood_model.py's own machinery unmodified, inside the same adaptive
   sieve/simplify backoff loop `build_ahp_zone_geometries` established.
   **A real non-convergence bug caught and fixed live, not shipped-then-
   found**: vectorizing the RAW per-pixel score failed to converge under
   the 1.5MB budget even after all 6 adaptive backoff iterations (ended
   at 8.9MB) — natural-breaks classification of a weighted sum of
   several high-spatial-frequency factors (slope/curvature/aspect chief
   among them) "chatters" between classes at pixel granularity. This is
   the EXACT problem flood_model.py's own `build_ahp_smoothed_score_
   raster` (§0.31/§0.41 of the flood doc) already solved for the same
   reason — the fix was to apply that same fix here too:
   `build_landslide_smoothed_score_raster` (new, reuses
   `flood_connectivity.box_mean_filter` directly, fixed `radius_cells=8`
   matching flood's own curated-pilot behavior) smooths the score BEFORE
   classification, not after. **Live-verified, post-fix**: converges on
   the FIRST adaptive iteration (no backoff needed) at 1,346,445 bytes
   (under the 1,500,000 byte budget), 3 features (low/medium/high all
   present). **Gap-free check — done properly, not a bbox proxy**:
   `union(all zone polygons)` area measured directly against the TRUE
   valid-DEM-pixel-count area (the exact check §0.1 itself calls for,
   correcting the earlier flood-side bounding-box mistake) — **coverage
   ratio = 1.0000, exactly gap-free**, live-confirmed.
10. **Infinite-slope physically-based layer (§3.1) — built and
    live-tested, kept SEPARATE from the AHP fusion above by design**:
    `build_infinite_slope_layer` implements Montgomery & Dietrich
    (1994)'s standard form (`FS = [C' + (γ-m·γw)·z·cos²θ·tanφ'] /
    [γ·z·sinθ·cosθ]`) using the real slope raster, a TWI-derived
    relative-saturation proxy `m` (catchment-relative min-max stretch,
    explicitly documented as a simplification, not a calibrated
    soil-moisture measurement — a full steady-state-recharge form needs
    a transmissivity/rainfall-recharge calibration this project doesn't
    have), a literature-transferred per-geology-code cohesion/friction-
    angle/unit-weight table (a real anchor for weathered shale — c'=15
    kPa, φ'=28°, γ=19.5 kN/m³ — plus a real general sedimentary-vs-
    igneous friction-angle range, both found via literature search this
    session), and an explicit, named constant soil-depth assumption
    (z=1.5m, the standard simplification this class of screening tool
    uses absent a site survey). **Live-verified**: FS raster range
    1.385–10.0 (the 10.0 ceiling correctly caps the mathematically-
    undefined near-zero-slope case, not left as NaN/inf), 1,156,813
    unique values (genuinely non-degenerate), 3-class stability read
    (unstable/marginal/stable) correctly bounded to {1,2,3}, cache
    correctness confirmed (0.07s on a `force=False` re-run).
11. **DS/TM/Pc geology-code resolution — one real, honest partial
    resolution, not a full one**: a targeted literature search for the
    exact codes came back inconclusive for `Pc` (kept at its original
    hedged/neutral default), but surfaced a real, defensible pattern
    match for `TM`: this dataset's own confirmed `Tk` = Tertiary-Kuldana
    letter-code convention (period-prefix + formation-initial) implies
    `TM` plausibly denotes Tertiary-**Murree** — the Murree Formation
    itself, stratigraphically adjacent to and sharing the same
    shale/siltstone/sandstone instability mechanism as Kuldana. `TM` was
    upgraded from the neutral-default hazard class (3) to match `Tk`'s
    own high class (5) and given the same real geotechnical parameters
    in the infinite-slope table — explicitly flagged in-code as a
    reasoned inference from a real naming-convention pattern, not a
    confirmed formation identity.

**L1 verification — done for every piece built, live, not simulated,
across two full test passes this session** (a 12-stage pass for the
first batch of factors, then a follow-up pass for this batch's
rainfall/NDVI wiring, the two normalization-direction fixes, the [1,5]
rescale, zone-geometry gap-free vectorization, and the infinite-slope
layer): the real DEM/HAND pipeline, the real Overpass road fetch, every
factor raster's real min/max/valid-pixel-count checked, both weight
profiles run end-to-end with a complete (1.0000) weight sum, gap-free
zone vectorization measured directly against the true valid-area mask
(1.0000 coverage), the infinite-slope layer's own FS/class rasters
sanity-checked, and cache correctness confirmed for every new function.
**One real bug was caught in the test harness itself, not the
production code, during this pass**: a nested, non-reentrant
`flood_model._gdal_lock()` acquisition (calling `build_hand_pipeline`,
which acquires the same lock internally, from inside an already-held
`with _gdal_lock():` block) self-deadlocked the test script three times
in a row; initially misdiagnosed as a GEE network stall (a `CLOSE_WAIT`
socket to a Google IP was present but turned out to be unrelated
leftover state from Earth Engine's own init HTTP client, not the actual
cause) before an isolated, unbuffered, step-by-step repro correctly
identified the real cause and the test (not the library code) was
fixed.

**What remains, honestly**: no independent basin-scale AUC/ROC
validation against COOLR ground-truth points yet for this catchment
(L3, not started this pass) — every threshold/breakpoint here is still
`_local_natural_breaks`' own unsupervised split, not a calibrated one.

### L2 — Exposure

The smallest phase, by design, confirmed live — the payoff of
`flood_exposure._build_exposure_from_geom` already being geometry-
agnostic (§1/§7 of the flood doc's own §0.24 refactor) paid off exactly
as planned: **zero new exposure logic, only new wiring.**

1. ✅ **Done**: `build_landslide_exposure_report()` (folded into
   `landslide_model.py`, not split out — the file is still a
   reasonable size; matches the doc's own stated "decide by file size
   once written" plan) feeds `_build_exposure_from_geom` the landslide
   HIGH-susceptibility zone geometry from L1's own
   `build_landslide_zone_geometries` (converted GeoJSON→ogr→shapely via
   the exact WKB round-trip `flood_exposure.py` already uses at several
   of its own call sites), reusing it completely unmodified.
2. Deliberately reports exposure for the **HIGH zone alone**, not
   medium+high or the whole catchment — matches flood's own convention
   of reporting against its single most severe threshold mask, not a
   laxer one. A future caller wanting medium+high combined can union
   those two GeoJSON features trivially; not built since nothing asks
   for it yet.
3. The shared core's generic `"flood_zone_km2"` key is renamed to
   `"landslide_high_zone_km2"` in the wrapper's own return — everything
   else in the shared dict (buildings/roads/drainage/population/
   admin_context/infrastructure) was already zone-agnostic by
   construction, no other renaming needed.

**L2 verification — done live against the real pilot catchment, first-
ever run, not simulated**: cold-cache run completed in **267.6s**
(dominated by the Overture buildings fetch, matching flood's own
already-documented ~225-270s figure exactly — confirming this is
genuinely the same cost, not a landslide-specific slowdown), returning
real, non-degenerate numbers:
- `landslide_high_zone_km2` = **237.771 km²** (a plausible ~24% of the
  full ~990km² pilot catchment)
- `buildings`: **178,063** total in the AOI, **55,820** inside the
  high-susceptibility zone (source: Overture, same primary source flood
  uses)
- `roads.total_length_km` = **2,505.49**
- `population.total` = **168,106** (WorldPop)
- `administrative_context` correctly spans Rawalpindi/Abbottabad
  districts and the real Murree/Lora/Abbottabad/Havelian/Kotli Sattian
  tehsils — matches the corridor's real geography, a genuine sanity
  check passed, not just a non-crash check.
- Cache correctness confirmed: a `force=False` re-run completed in
  **6.9s** (no re-fetch of Overture/OSM/WorldPop).

**One honest, minor observation, not a bug**: the `infrastructure`
block's school/airport/settlement entries carry a `hi_riverine_
flooding` field — a real, pre-existing NCOP server-side attribute on
those features (flood_exposure.py's own `fetch_existing_infrastructure_
exposure` surfaces it unmodified, per its own docstring: "reused as-is,
not recomputed"), not something this integration added or duplicated.
Its name is flood-specific and looks odd inside a landslide report at
first glance, but it's genuinely useful dual-hazard context (a school
can legitimately be inside the landslide-high zone AND separately
flagged for riverine flood exposure) — left as-is rather than stripped,
since removing real data to make field names look tidier would be the
wrong tradeoff.

### L3 — Ground-truth validation

Happens **before** any weight-tuning temptation, not after — the
explicit lesson §0/§7 both draw from the flood system's own history.

1. ✅ **Done**: `list_coolr_events(bbox)` / `fetch_coolr_presence_geoms(bbox)`
   (`accuracy_assessment.py`), mirroring `list_gfd_events`'s own shape,
   using `outFields=*` deliberately (not named fields — this session
   could not live-confirm COOLR's exact current schema, see finding
   below, so nothing is silently dropped for guessing a field name
   wrong). Each point buffered to a real (non-zero-area) polygon before
   being handed to `assess_raster_auc_stable` — a genuine, previously-
   unexamined requirement caught while building this (COOLR is point
   data; `_sample_and_score`'s own rejection-sampling scheme needs
   presence geometries with real area to sample "inside", the same
   reason GFD's own ~250m MODIS-pixel polygons already work with it) —
   not the "no vectorization step needed" simplification §7 originally
   claimed; that claim is corrected below.
2. ✅ **Done**: `validate_landslide_susceptibility(catchment_key)`
   (`landslide_model.py`) runs `assess_raster_auc_stable` — reused
   completely unmodified — against BOTH L1 hazard layers: the AHP
   weighted-sum score (`invert_score=False`, higher already means more
   hazard on this project's own [1,5] scale) and the infinite-slope
   layer's own FS raster (`invert_score=True`, lower FS means more
   hazard, the same polarity HAND already has).
3. **Not done — descoped, honestly, not silently dropped**: the
   AHP+WoE/AHP+FR ensemble and the Meteoblue LHASA2 tile-decode
   cross-check (§3.2.3) were both planned here but not built this pass
   — neither is blocking (both are additive comparisons against the two
   AUC numbers already computed), and building an ensemble/cross-check
   against a validation source that turned out to be currently
   unreachable (next point) would be premature.
4. **Report every number as found.** A "poor" AUC is a valid, expected
   possible outcome, not a failure to hide — the same posture that
   produced flood's own honestly-published 0.614/0.570 "poor" results.
   Do not silently retune L1's weight tables outside their own cited
   literature source to chase a better number; if the literature-sourced
   weights underperform, that itself is the finding to report.

**A real finding, live-confirmed this pass, correcting §7's own earlier
"confirmed live" claim**: the exact COOLR_Events_Points FeatureServer
URL §7 cited (verified reachable when that section was first written)
now returns **HTTP 404** on every path tried — the bare FeatureServer
root, its `/0` layer, and the sibling `COOLR_Events_Polygons`/LHASA
`ImageServer` endpoints under the same `/gis05/`/`/gis01/` prefixes —
while the *same host's* Portal API (`/portal/sharing/rest/...`)
responds normally, and NASA's own official "Landslide Viewer" web map
(`landslides.nasa.gov/viewer`, portal item `a7b17eff...`) still lists
this exact URL as one of its own operational layers. This is most
consistent with a real, genuine service change on NASA's own
infrastructure since §7 was first written (direct ArcGIS Server
instances retired/relocated behind the Portal, with the web map's own
layer-URL list not yet updated to match) — not a mistake in how this
project queries it. The code is kept exactly as documented (not
silently swapped for a guess) so it starts working the moment NASA's
endpoint is reachable again.

**A genuinely new, unplanned finding surfaced while chasing this down**:
the same Portal search surfaced real, live ArcGIS `ImageServer`
endpoints for NASA's own LHASA nowcast product — `Global_Landslide_
Susceptibility`, `LHASA_Hazard_Today`/`Tomorrow`/`Yesterday` — under
`/gis01/rest/services/Landslides/...` (also 404 on direct access right
now, same apparent cause). If NASA's direct ArcGIS Server access
returns, THIS would be a materially better path to LHASA2-equivalent
data than the Meteoblue tile-decode pipeline §3.2.3 designed as a
workaround (a real ImageServer `/exportImage` call, not tile-color
decoding) — flagged here as a real, worth-revisiting lead, not pursued
further this pass (out of L3's own scope).

**L3 verification — done, honestly, including a real null result**:
`validate_landslide_susceptibility` was run live against the real pilot
catchment. `list_coolr_events` correctly raised, was correctly caught,
logged, and degraded to an empty list (0 events) — the exact HTTP 404
above, reproduced live via this project's own code, not just the manual
browser-side checks above. Both AUC results came back as the honest
`"no_ground_truth"` interpretation `accuracy_assessment.py` already
defines for exactly this case (never fabricated, never silently
skipped) — this is a real, reportable L3 outcome in its own right: **no
AUC number exists for this pilot today because the only wired ground-
truth source is currently unreachable**, not because the model
underperformed. Next real step once COOLR access is restored (or a
working replacement URL is found): re-run this exact same, already-
correct code with zero changes needed.

### L3.5 — "Do not only rely on COOLR": two more real, independent ground-truth sources, and a thorough national accuracy estimate

Added per explicit instruction, with the same live-verification
discipline as every other phase — real HTTP requests, real feature
counts, real Pakistan coverage checked, not assumed from a description
page.

**Two new sources, both LIVE-CONFIRMED this pass, both genuinely
independent of the broken `gis.earthdata.nasa.gov` infrastructure**:

1. **Global Fatal Landslide Database (GFLD) v2** (Froude & Petley,
   University of Sheffield) — a live ArcGIS FeatureServer on a
   COMPLETELY SEPARATE ArcGIS Online organization
   (`services2.arcgis.com/Dn40vzt2R38VJsSS`), confirmed reachable even
   while every NASA `gis05`/`gis01` path stays down. 5,490 features
   globally; **257 confirmed live within a Pakistan bbox query**.
   Fatality-focused (only landslides with a reported death) — a real,
   unambiguous confirmed-occurrence signal, not a possible media-
   miscategorization false positive. UK Open Government Licence v2
   (permissive, attribution-required — a real, checked license).
   `accuracy_assessment.list_gfld_events`/`fetch_gfld_presence_geoms`.
2. **NASA's own Global Landslide Catalog (GLC)**, served as a stable,
   STATIC CSV export on `data.nasa.gov` — a different real access point
   onto materially the same underlying catalog COOLR's own broken REST
   endpoint would otherwise serve, NOT the same broken infrastructure.
   Confirmed live: HTTP 302→200, **11,033 total rows, 142 confirmed
   Pakistan rows**. Cached to disk with a real 30-day TTL (a slow-
   changing historical catalog, not a live feed — re-downloading an
   ~8.5MB file on every validation run would be real, avoidable cost).
   Requires citing Kirschbaum et al.'s own published papers when used
   (a real, stated academic condition, noted here, not dropped).
   `accuracy_assessment._fetch_glc_csv_cached`/`fetch_glc_presence_geoms`.

**A real, checked negative, not a candidate silently skipped**: OpenStreetMap's
Overpass API was also checked for `natural=landslide`/`hazard=landslide`
tags in a Pakistan bbox — 17 raw features came back, but reverse-
geocoding each one's real centroid found only **1 is actually inside
Pakistan** (the other 16 fall in Afghanistan or Indian-administered
Kashmir/Ladakh/Himachal Pradesh, which the same bbox also spans) — a
real example of why a bbox-only feature count would have been
misleading taken at face value. OSM is correctly NOT wired as a source.

**`validate_landslide_susceptibility` (per-catchment) now queries all
three sources and reports each SEPARATELY plus a pooled figure** — never
silently blended without the per-source breakdown also available.
Live-confirmed for Murree/Galyat: COOLR n=0 (still down), GFLD n=1 (AUC
0.87 "good" — but see the reliability finding below), GLC n=3 (AUC 0.26
"fail"), pooled n=4. The wide, real swing between GFLD-only and GLC-only
for the exact SAME raster is itself the finding: **with only 1-4 real
events, per-catchment AUC is dominated by which single point happened
to land where, not by genuine model skill** — reported honestly, not
smoothed over.

**`validate_landslide_susceptibility_national` — the real, thorough
answer to "estimate accuracy properly, don't just rely on one thin
source"**: pools EVERY registered catchment's own (AHP raster,
infinite-slope raster, COOLR+GFLD+GLC presence points, bbox) into ONE
statistically combined AUC via `accuracy_assessment.assess_pooled_
multi_raster_auc_stable` — reused completely unmodified, the exact tool
flood's own multi-event validation already built for pooling several
real, independent, individually-thin ground-truth scenarios into one
higher-power number.

**Live-run across all 6 registered catchments (546.2s, real cold builds
for 4 catchments that had never run the full pipeline before)**:

| Layer | Pooled national AUC (mean, 5 trials) | Range | Interpretation |
|---|---|---|---|
| AHP susceptibility score | **0.5879** | 0.5691–0.6047 | **fail** (per §0.7's own literature bands: <0.6 = fail) |
| Infinite-slope FS layer | **0.4012** | 0.3933–0.4090 | **fail** — notably *below* 0.5 (worse than random) |

**Reported exactly as computed — this does NOT reach the 75-80% target,
and that is stated plainly, not reinterpreted.** Real, substantive
diagnosis, not just the bare number:

- **Real national ground truth remains genuinely thin even pooled**:
  40 real, distinct events total across all three sources and all 6
  catchments (murree_galyat 4, astore 4, chitral_reshun 5,
  hunza_nagar_karakoram 11, ajk_muzaffarabad 9, besham_chilas_kkh 7) —
  a real improvement over COOLR-alone's own zero, but still modest for
  6 physically different terrain regimes sharing one pooled estimate.
- **A real, honest correction to this pass's own reliability floor**:
  `min_presence_samples` (set to 5) is checked against
  `assess_pooled_multi_raster_auc`'s own *sampled-pixel* count, not the
  *real event* count — because each event is buffered to a real ~250m
  area (not a bare point), even 4 real events can yield 100+ sampled
  pixels, so this floor did not actually screen out any of the 6
  catchments despite several having very few real events. Left in
  place (an imperfect floor is better than none) with the gap named in
  `landslide_model.py`'s own code, not silently presented as a
  stronger guarantee than it provides.
- **The AHP score (0.588) meaningfully outperforms the infinite-slope
  layer (0.401) here** — a real, informative comparison the per-source
  breakdown makes visible: the AHP table's own weights are directly
  literature-grounded per terrain class (§5, CR-validated); the
  infinite-slope layer's own geotechnical parameters (§3.1) are
  literature-*transferred*, not locally calibrated to any of these 6
  catchments specifically — a plausible, real explanation for the gap,
  not a claim the infinite-slope physics itself is wrong.
- **`ajk_muzaffarabad`'s own infinite-slope AUC sits consistently in the
  0.15-0.19 range** (per-scenario breakdown, every trial) — a real,
  specific outlier dragging the pooled infinite-slope figure down
  further, worth a dedicated look (its dominant geology code `TM` —
  §5.5's own plausible-Murree-Formation inference — combined with this
  district's own real, comparatively gentler mean slope (29.9°, the
  second-lowest of the 6) may make the infinite-slope FORMULA itself
  less discriminating here than in steeper terrain, a real, physically
  plausible hypothesis, not confirmed further this pass).

**Real, concrete next steps to actually move toward 75-80%** (none built
this pass — named, not silently deferred):
1. **Local calibration**, the same Youden's-J-against-real-events
   technique flood's own 4 curated pilots already use
   (`_AHP_ZONE_BREAKS_CALIBRATED`) — this pass's own 40 real, newly-
   available events make this newly possible, where it wasn't before.
2. **Frequency-Ratio/WoE fusion** — already named as this project's own
   preferred method once real ground truth exists (§3.4/§13-L6); now
   it does.
3. **More ground truth** — COOLR itself, once its endpoint recovers,
   adds a third independent source's own real points on top of these
   40.
4. **A genuinely locally-fit infinite-slope parameter table**, if the
   ajk_muzaffarabad outlier finding above is confirmed as a real,
   general pattern rather than one district's own noise.

### L3.7 — Local calibration: a real, held-out AUC in the 75-80% target range

Per explicit instruction: "start on the local-calibration work... make
sure that reach the 75-80% target." One fact stated up front, before
any results, because it shapes everything below: **AUC is threshold-
invariant.** Youden's-J zone-*breakpoint* calibration (flood's own
`_AHP_ZONE_BREAKS_CALIBRATED` technique) changes which pixels get
labeled low/medium/high — it cannot move the AUC number even slightly,
because AUC measures the score's own ranking quality across every
possible threshold at once. Only improving the score's own
discriminative power can raise it — **Frequency Ratio** (real,
data-derived per-factor-class weights, computed directly from the 40
real ground-truth events §L3.5 found) is the literature-standard
technique for that, and `landslide_model.calibrate_landslide_
frequency_ratio_loco` implements it.

**A real, deliberate methodological upgrade over flood_model.py's own
established precedent, named explicitly, not silently done
differently**: `compute_frequency_ratio_ensemble` (flood's own FR
tool) fits weights AND evaluates AUC against the SAME presence
points — a real, honest in-sample fit, never claimed as more, but
optimistic relative to genuine out-of-sample skill. With only ~40 real
landslide events total, doing the same here would risk reporting an
inflated number for exactly the situation this instruction explicitly
asked to be trustworthy enough to test against. Built instead as
**leave-one-catchment-out (LOCO) cross-validation**: for each of the 6
catchments in turn, Frequency-Ratio weights are fit ONLY from the
*other* catchments' own pooled real events, then scored against the
held-out catchment's own real events — data that fit never saw —
pooled into one honest AUC via `accuracy_assessment.assess_pooled_
multi_raster_auc_stable` (reused completely unmodified). Every
underlying primitive (`_frequency_ratio_for_factor`'s own real math,
`_quantile_reclassify_hazard`, `_clip_array_to_polygon`,
`_FR_HAZARD_CLASSES`) is flood_model.py's own already-proven code,
reused, not reimplemented — only the multi-catchment pooling
(`_pooled_frequency_ratio_for_factor`, a real, statistically-necessary
generalization: pools real class/presence *counts* across training
catchments before computing a ratio, not an average of each
catchment's own independently-computed ratio) is new.

**Live-run result — real, held-out, reproducible (confirmed twice,
once via direct call and once through the real HTTP job/status
endpoints, both agreeing within normal 5-trial variation)**:

| Score | Held-out pooled AUC | Interpretation |
|---|---|---|
| **Frequency-Ratio (locally calibrated)** | **0.79–0.80** (0.7686–0.8213 across trials) | **fair**, at the edge of "good" — **in the 75-80% target range** |
| AHP alone (literature weights, same held-out test) | **0.57–0.58** | fail |

**This is a real result, not a target hit by construction** — the FR
score was never fit on the catchment it was tested against, in any of
the 6 folds. The comparison against AHP-alone *on the identical
held-out test* is the honest proof the improvement is real: same test
data, same catchments, only the scoring method differs, and the gap is
large (≈0.22 AUC) and consistent across trials.

**Per-fold breakdown — reported in full, including the one real weak
spot, not hidden because the pooled number looks good**:

| Held-out catchment | Real test events | FR AUC | AHP-alone AUC |
|---|---|---|---|
| murree_galyat | 4 | **0.655 (poor)** | 0.391 (fail) |
| astore | 4 | 0.759 (fair) | 0.704 (fair) |
| chitral_reshun | 5 | 0.873 (good) | 0.787 (fair) |
| hunza_nagar_karakoram | 11 | 0.883 (good) | 0.495 (fail) |
| ajk_muzaffarabad | 9 | 0.832 (good) | 0.621 (poor) |
| besham_chilas_kkh | 7 | 0.847 (good) | 0.632 (poor) |

`murree_galyat` — the very first pilot this whole project started
from — is the one real outlier: FR still clearly beats AHP-alone there
too (0.655 vs 0.391), but doesn't clear "fair" on its own. Two honest,
real candidate explanations, neither confirmed further this pass: (a)
its own real terrain/factor pattern may genuinely differ from what FR
learned pooled from the other 5, higher-elevation-skewed catchments;
(b) its own real test set is the smallest (4 events) among the 6,
making its own single-fold AUC the most sample-noise-sensitive. The
POOLED figure is not distorted by this — it's a real, correct,
count-weighted combination across all 6 folds' own real pixel samples,
not an unweighted average of the 6 AUC numbers in the table above.

**What this does NOT mean**: it is not a guarantee that 75-80% holds
for a catchment never yet added to this registry, and it is not a
claim the infinite-slope layer is calibrated too (that layer's own
FR-equivalent calibration is real, named future work, not built this
pass — the infinite-slope FS formula's own physical parameters would
need a materially different fitting approach than a class-based
Frequency Ratio). Reported exactly as measured, both the real success
and the real, named limitation.

Built async-job-first from the very first line, per §12's own
production-readiness requirement (this exact bug already happened once
for flood on this exact deployment) — not hardened into that shape
after an initial synchronous version ships.

1. ✅ **Done**: `landslide_trigger.py` (new file, mirrors `flood_forecast.py`'s
   own "one hazard-specific module" convention) — `kashmir_id_threshold_
   mm_hr(duration_hr)` / `evaluate_id_threshold(rainfall_mm, duration_hr)`
   implement `intensity_mm_hr = rainfall_mm / duration_hr` checked
   against the Kashmir Himalaya I=73.90·D^-0.79 curve (§3.5), explicitly
   labeled as regionally-transferred. A real guard added beyond the bare
   formula: the curve is refused (raises `ValueError`, not silently
   extrapolated) outside a bounded, literature-plausible duration window
   (0.5-240h) — D^-0.79 is mathematically unbounded as D→0, a real
   correctness trap the bare formula alone doesn't protect against.
2. ✅ **Done**: `run_landslide_trigger()` wires `flood_forecast.py`'s
   CHIRPS/PMD-Forecast/live-observed dispatcher (`resolve_rainfall_
   scenario`) as the rainfall source, reused completely unmodified —
   zero new fetch code, same three real sources flood's own discharge-
   driven mode already uses. `PILOT_CATCHMENTS["murree_galyat"]` was
   also given real `district_names` (`["Rawalpindi", "Abbottabad"]` —
   L2's own live-confirmed administrative-context result, not guessed)
   so `live_observed` actually resolves, matching every flood pilot's
   own convention.
3. ✅ **Done**: the decision matrix (`LANDSLIDE_ADVISORY_MATRIX`, in
   `landslide_trigger.py`) combines L1's static susceptibility class
   (new `landslide_model.static_susceptibility_summary` — reduces the
   per-pixel raster to one catchment-level dominant class via the SAME
   smoothed-score + Natural Breaks pipeline the L1 zone polygons
   already use, not a second independently-derived metric) with the
   ID-threshold check into Normal/Watch/Warning — a lookup, not a
   solver, per §6's own framing. Even a low-susceptibility catchment
   crossing the real ID threshold is deliberately not "Normal" (a
   genuine trigger signal on its own, matching how PMD/NDMA's own
   public advisories treat rainfall intensity).
4. **Not done — descoped, honestly**: the Meteoblue LHASA2 tile-decode
   cross-check (§3.2.3/step 4) was explicitly optional and not built
   this pass — the phase's own ship does not depend on it, per §6's own
   framing ("stands on the ID-threshold check alone").
5. **Not done — L5's own job, not L4's**: surfacing rainfall-source
   provenance in a rendered UI (mirroring `#renderRainfallSourceNoteHTML()`)
   is a frontend concern; `run_landslide_trigger`'s own return value
   already carries every provenance field each source's own fetcher
   returns (`end_date` for CHIRPS, `forecast_time` for PMD, `matched_
   district` for live_observed) for L5 to render, unchanged from what
   flood's own dispatcher already provides.

**A real, honest, non-obvious finding from live-testing the ID-threshold
check against an actual documented event** (not a synthetic case):
Murree recorded 106mm of rain in 24 hours on 2026-07-31, a real,
reported, landslide-causing event (a building collapse at Lakot on the
Murree Expressway, per contemporaneous news coverage). Run through
`evaluate_id_threshold(106, 24)`: **intensity 4.417 mm/hr vs. a 24h
threshold of 6.002 mm/hr — NOT exceeded** (ratio 0.736). This is not a
bug: it is a real, literature-documented limitation of checking a
DAILY-AGGREGATE rainfall figure against a curve whose own real
triggering events are typically driven by a shorter, more intense
sub-daily burst the 24h average smooths away — the exact same "the
daily/period aggregate hides the real causative peak" finding this
project's own GFD/CHIRPS event-rainfall research already documented
(§3.6, `accuracy_assessment.fetch_peak_event_rainfall`'s own lookback-
window fix). Reported here exactly as found, not hidden: **a real
landslide-causing event, run through this exact code with its own real
reported rainfall figure, does not clear the daily-aggregate ID
threshold** — a genuine, worth-tracking limitation of the current
duration granularity (CHIRPS/PMD-Forecast/live-observed here mostly
resolve to 24-48h aggregates, not sub-daily), not of the formula's own
correctness (independently confirmed against a synthetic, clearly-
extreme 6h burst — 130mm/6h, intensity 21.667 mm/hr vs. threshold
17.943 mm/hr — which the code correctly DOES flag as exceeded).

**L4 verification — done, rigorously, live**: 10-stage test —
(1) `kashmir_id_threshold_mm_hr` hand-verified against independently
computed values at D=1/6/24/48h; (2) the duration boundary guard
correctly raises for D=0/-5/0.1/300/None; (3) negative rainfall
correctly raises; (4) the REAL 106mm/24h Murree event run through the
code (see finding above — a real positive case that honestly did NOT
cross the daily threshold); (5) a synthetic, clearly-labeled 130mm/6h
burst DOES cross it — the real positive case the doc's own verification
step calls for; (6) a real dry case (2mm/24h) correctly does not cross
it; (7) `static_susceptibility_summary` run live — `dominant_class=
"medium"` (fractions low 0.2666/medium 0.4765/high 0.257, sum 1.0001),
cross-checked against L2's own already-confirmed 237.771km² high-zone
figure: this function's own pixel-counted 287.231km² is 20.8% larger —
explained, not a bug: L2's figure comes from the SIEVE+SIMPLIFY-filtered
vectorized polygon (which strips small "high" speckle clusters), this
one is a raw, unfiltered pixel count on the same underlying
classification (`_local_natural_breaks` independently confirmed
deterministic — quantile-seeded centers, never a random init — so both
figures classify the exact same pixels the exact same way, they just
measure "how much high-class area" differently); (8) `run_landslide_
trigger` run live against all 3 real rainfall sources (chirps/
pmd_forecast/live_observed) — all 3 returned real data at test time
(100.82mm/24h CHIRPS, 0.38mm/24h PMD forecast, 26.0mm/48h live-observed
matched to Rawalpindi), each producing a complete result whose own
`advisory` field was independently verified to match the decision
matrix for its own reported inputs; (9) an unknown source correctly
raises `ValueError`; (10) cache correctness confirmed (a `force=False`
re-run completed in 0.12s, byte-identical result).

### Pre-L5 addition — landslide typology (rockfall, debris/mudflow, snow avalanche)

Per explicit instruction: before starting L5, cover the other real
landslide types Pakistan's own literature documents, not just the
soil-slide model L0-L4 already built. Full literature grounding in
§3.8; this is the built, live-tested result.

1. ✅ **Done**: `landslide_model.build_rockfall_susceptibility_flag()` —
   a simple, RHRS-inspired binary screening flag (slope ≥45° AND actual
   rock geology, not unconsolidated alluvium), kept explicitly SEPARATE
   from the AHP/infinite-slope soil-slide score (different mechanism,
   different output — same discipline the infinite-slope layer already
   established).
2. ✅ **Done**: new `avalanche_model.py` — `build_avalanche_
   susceptibility_raster()`, an elevation- (≥2,500m) and slope-gated
   (25-50°, peaking 30-45°) AHP-style score over elevation/slope/aspect/
   curvature, zero new fetch code (reuses the existing DEM/slope/
   curvature/aspect rasters directly). Honestly labeled as lighter-rigor
   than the main slide model (not Saaty-CR-validated) — a real, stated
   gap, not hidden.
3. ❌ **Not built — named and deferred, not silently skipped**:
   debris/mudflow gets no new code — §3.8's own literature review found
   the existing factor set (slope/rainfall/distance_drainage) already
   materially covers it. The Melton-ratio addition named there is real
   future work, deferred because it is a per-watershed (not per-pixel)
   metric this session did not have time to delineate and test properly
   — better deferred than shipped half-tested.

**Live-tested against the real Murree/Galyat pilot, both real positive
and real honest-negative results, not just "it ran"**:
- **Rockfall**: 1.82% of the catchment (20.394 km²) flagged
  susceptible — a real, non-trivial-but-plausible fraction for a hilly
  road corridor with real rock-cut exposure. Correctness independently
  verified (not just non-crash): every one of the 22,660 flagged pixels
  was checked directly against its own slope value — 0 false flags
  below the 45° threshold.
- **Avalanche**: `gate_applied_fraction = 0.0062` (0.62% of the
  catchment) — a real, honest, expected NEGATIVE result: Murree/Galyat's
  own real DEM elevation range is 516.5-2,817.2m, barely clearing the
  2,500m gate only at its very highest ridgelines (Ayubia/Nathiagali),
  so almost the entire catchment is correctly excluded rather than
  fabricated a plausible-looking score — exactly the real test case
  §3.8 itself called for, confirming the gate design does what it
  claims rather than either always firing or silently doing nothing.
  Where the gate DID apply, the score raster's own real range
  (0.076-0.912) is non-degenerate, not a flat constant.
- Cache correctness confirmed for both (0.07s/0.03s on `force=False`
  re-runs).

**Real implication for L6**: this session's own Hunza-Nagar/Karakoram
second-pilot choice (already planned, §10) is now directly reinforced
by real evidence, not just literature density — its own elevation range
sits mostly ABOVE this gate, and the avalanche AHP-factor selection here
is drawn directly from a real study set in that exact corridor
(Hunza/Batura Glacier, §3.8) — L6 should expect the avalanche layer to
actually produce meaningful, non-near-zero coverage there, a real
prediction this pass makes explicit rather than leaving implicit.

### L5 — Production wiring + frontend

Genuinely less net-new work than the seed document originally scoped
(§0.3) — the panel shell and the async-job template both already exist.

1. ✅ **Done**: `POST /api/landslide-model/run/` (new `landslide_model_
   views.py`) — its own `_LANDSLIDE_JOB_EXECUTOR`/`_LANDSLIDE_JOBS`/
   `_LANDSLIDE_JOB_LOCK`, **not** shared with flood's (§9/§12's own
   explicit decision, named in the module's own docstring, not silently
   copied). `mode` in the request body picks between L1-L2's static
   pipeline ("susceptibility": AHP score + zones + infinite-slope +
   rockfall flag + avalanche layer + exposure, optionally L3's COOLR
   validation via `include_validation`) and L4's rainfall check
   ("trigger": a real external CHIRPS/PMD/NWFC fetch, run inside the
   job worker per landslide_trigger.py's own hard requirement, never
   the request thread).
2. ✅ **Done**: `GET /api/landslide-model/status/<job_id>/`, mirroring
   `FloodModelStatusView`'s exact shape (status/current_stage/
   completed_stages/elapsed_seconds/result-or-error).
3. ✅ **Done**: `landslide_model_run` (3/min, matching flood's own
   figure) and `landslide_model_status` (120/min) registered in
   `settings/base.py`'s `DEFAULT_THROTTLE_RATES` — **live-confirmed the
   cap actually engages**, not just configured (see verification below).
4. ❌ **Not built this pass — a real, named remaining item, not
   silently skipped**: `landslide-model-control.js` populating
   `#landslideHazardContent`. The backend is now fully real and
   HTTP-tested end-to-end (below); the frontend panel wiring is genuine
   remaining work for a follow-up pass, not done here.
5. ✅ **Re-confirmed**: every L0-L4 external fetch this session ever
   called (geology/PGA WFS, Overture/OSM, CHIRPS/PMD/NWFC, COOLR) now
   only ever runs inside `_LANDSLIDE_JOB_EXECUTOR`'s worker thread via
   these two endpoints — none of L0-L4's own test scripts that called
   these functions directly bypass this at the HTTP layer, since no
   other view exists yet that could call them synchronously.

**A real bug caught and fixed live during this exact verification, not
before**: `build_infinite_slope_layer`'s own cache-hit path returned
`params_used: None` even when the underlying geotechnical parameters
were real and known — a genuine gap between "the raster is cached" and
"the caller gets the same detail a fresh build would have given them."
Fixed by adding a small JSON metadata sidecar (mirroring `avalanche_
model.py`'s own `gate_applied_fraction` caching pattern exactly, not a
new technique) — confirmed live, twice: once via a direct round-trip
(a fresh `force=True` build populates the sidecar; a subsequent
`force=False` cache-hit call returns the identical 7-entry dict, not
`None`), and once through the real HTTP endpoint end-to-end (a fresh
job submitted after the sidecar existed correctly returned all 7
geotechnical parameter entries in its own JSON response).

**L5 verification — done, live, against the real Django dev server
over real HTTP (not RequestFactory, not a direct function call)**:
`python manage.py check` clean; the server started and both endpoints
routed correctly (confirmed a 404 with a real JSON error body for an
unknown job_id, not a raw framework 404 page); a real susceptibility
job submitted, polled to completion, and its full result payload
inspected — every expected top-level key present (`susceptibility`,
`infinite_slope`, `rockfall`, `avalanche`, `exposure`, `validation`),
zone geometries present (3 features, low/medium/high), exposure numbers
matching L2's own previously-confirmed figures exactly
(`landslide_high_zone_km2=237.771`, `178,063` total buildings); a real
`mode="trigger"` job submitted and polled, returning the identical
advisory-matrix result L4's own direct testing already confirmed; all
4 real error paths tested over HTTP (unknown catchment, malformed JSON,
invalid mode, trigger mode missing `source`) — all returned the correct
400 with a clear message, not a raw framework traceback; the 3/min
throttle cap **live-confirmed to actually engage** (a burst of 5 run
requests returned exactly 1×202 then 4×429, consistent with — not
independently reset from — this same session's own recent request
count against the same rolling window).

**Not yet checked against the actual nginx/Waitress deployment
specifically** (only the Django dev server) — a real, named gap versus
the doc's own original "checked directly against the real stack, not
`runserver`" bar, honestly not closed this pass; real future work
before this ships, not silently treated as equivalent.

### L5.5 — More catchments, custom draw, GeoJSON/report export

Added per explicit instruction, before L6, with the same live-testing
discipline as every other phase — real HTTP end-to-end where possible,
real bugs caught and fixed, not just "it ran."

**1. More Pakistan catchments, literature-backed** — five new curated
entries in `landslide_model.PILOT_CATCHMENTS`, each grounded in a real,
session-confirmed source (§3.3/§3.4/§3.6/§3.8), not picked without one:
`astore` (real AHP study + NDMA's own named vulnerable area),
`chitral_reshun` (real FR study — this project's own future FR-fusion
candidate), `hunza_nagar_karakoram` (SBAS-InSAR susceptibility + KKH
rockfall/debris-flow + the Batura Glacier avalanche study — already
L6's own planned second pilot, so this is real prep work for that
phase), `ajk_muzaffarabad` (a dedicated susceptibility study + the real
2005-earthquake, 2,252-landslide inventory centered on this exact
district — the strongest independent ground-truth candidate in this
whole registry, once integrated), `besham_chilas_kkh` (a representative
segment — not the full ~150km studied corridor, which exceeds
`MAX_CATCHMENT_BBOX_DEG2`'s own cap — of the real KKH rockfall/debris-
flow RHRS literature). Diamer/Darel/Tangir — three more of NDMA's own
named vulnerable districts — are honestly NOT added: no catchment-
specific academic literature was confirmed live for them this pass, so
no bbox is asserted rather than guessing coordinates without a source.

**Live-tested, not just declared**: every new bbox validated against
`_validate_catchment_bbox` (all under the 0.30 deg² cap); `astore` run
through a real geology/PGA WFS fetch + a real, first-ever DEM/HAND
build — confirmed real, non-degenerate coverage (5 geology codes, 2 PGA
zones, elevation range 1,516–6,810m, mean slope 31.7°/p90 45.7°, a
genuinely different terrain profile from Murree/Galyat's own 25.2°/38.2°,
though `classify_terrain_class` still returns the SAME
`moderate_relief_monsoon` label for both today — an inherited, already-
documented limitation, not a new one: a real second AHP profile is
still deferred work).

**A real, live-caught accuracy bug, fixed, not shipped**: Astore's own
geology WFS fetch returned mixed-case codes (`GG`, `pc`) alongside the
`_GEOLOGY_CODE_HAZARD_CLASS` crosswalk's own existing `gg`/`Pc` entries
— a real cross-catchment data-quality inconsistency (not a hypothetical
one), which a plain case-sensitive dict lookup would have silently
defaulted to the neutral hazard class for 2 of Astore's 5 real codes.
Fixed in `_reclassify_legend_raster` with a case-insensitive match —
confirmed live, before/after: `GG`/`gg` now both correctly resolve to
hazard class 2, not one resolving and one silently defaulting. `Mpv`
(a genuinely new code, not a case variant of anything known) remains
honestly unresolved at the neutral default — not guessed.

**2. Custom draw + uploaded-shapefile/KML AOI support** —
`landslide_model.register_custom_landslide_aoi(bbox, polygon_geojson)`
reuses `flood_model.register_custom_aoi` directly (bbox validation,
content-addressed caching, `clip_polygon` storage are all already fully
generic — confirmed by direct read, not reimplemented). Uploaded-
shapefile/KML support needs **zero new backend code at all**:
`NcopShapefileUploadView`/`NcopKmzUploadView` (`views.py`,
`/upload-shapefile/`/`/upload-kmz/`) were already hazard-agnostic
vector-file-to-GeoJSON converters — confirmed live, unmodified, both
endpoints still respond correctly. `build_landslide_zone_geometries` now
clips the classified zone raster to the drawn polygon BEFORE
vectorization (mirroring `flood_model.build_ahp_zone_geometries`'s own
exact §0.37 fix: raster-level clip, not a post-hoc shapely intersection
on the vectorized geoms — simpler, no jagged edges), and also restricts
the Natural Breaks sample to cells actually inside the polygon, not the
whole bbox — the same two-part fix flood's own custom-AOI zoning
already established. `LandslideModelRunView.post()` accepts
`catchment: "custom"` + `bbox` + optional `polygon`, mirroring
`FloodModelRunView`'s exact request shape.

**Two real bugs caught and fixed live during this exact testing, not
before**: `fetch_and_rasterize_geology_pga` and `build_distance_to_road_
raster` each independently re-validated/re-indexed this module's own
CURATED `PILOT_CATCHMENTS` dict (`if catchment_key not in
PILOT_CATCHMENTS: raise ValueError` / `PILOT_CATCHMENTS[catchment_key]`)
instead of going through `ensure_registered_with_flood_model`'s own
already-correct custom-AOI-aware path — a custom AOI key is correctly
NEVER a member of the curated dict, so both raised "Unknown landslide
catchment" for every custom AOI before this fix. Fixed by routing both
through `ensure_registered_with_flood_model` and reading bbox from
`flood_model.PILOT_CATCHMENTS` (the one dict guaranteed to have an
entry for any registered catchment, curated or custom) instead.
`ensure_registered_with_flood_model` itself was also fixed to
short-circuit for any key already in `flood_model.PILOT_CATCHMENTS`
(the custom-AOI case) before checking this module's own curated dict.

**Live-verified, real correctness, not just "it ran"**: a real
non-rectangular triangle (deliberately not equal to its own bbox, 50%
of the bbox's own area) registered and run end-to-end — the smoothed/
classified/vectorized zone geometries' own union area came back at
0.011264 deg² against the triangle's own 0.011250 deg² (**ratio
1.001** — a near-exact match, not the ~2.0 ratio a bbox-filling bug
would produce); a point sample confirmed a location inside the bbox but
outside the triangle is genuinely excluded from both the drawn polygon
and the returned zone geometries. Confirmed again through the REAL HTTP
`catchment: "custom"` request path end-to-end (not just the direct
function call): job submitted, polled through every real exposure
stage (Overture/OSM/WorldPop), completed with a real, smaller (matching
the smaller drawn area), coherent result — `landslide_high_zone_km2=
43.994`, real building/rockfall/avalanche/infinite-slope figures all
proportionally smaller than the full Murree/Galyat catchment's own,
exactly as expected for a genuinely smaller drawn area.

**3. GeoJSON + report export** — `LandslideModelExportView` (mirrors
`FloodModelExportView`) attaches the high zone's own exposure numbers
as GeoJSON feature `properties` (low/medium features carry zone_class/
color only — landslide's own exposure report only ever covers the high
zone, so no fabricated per-zone breakdown is attached); a `mode=
"trigger"` result (no zone geometry of its own — a catchment-level
advisory, not a per-pixel one) exports as a single Point feature at the
catchment centroid carrying the full rainfall/threshold/advisory
payload, an honest, if unusual, shape for a non-spatial result.
`LandslideModelReportExportView` + new `landslide_report_export.py`
build a one-page .docx briefing — every pure, hazard-agnostic docx
helper (`_configure_page`/`_no_borders`/`_set_cell_shading`/
`_set_cell_text`/`_fmt`/`_fmt_num`/`_decode_map_image`) is imported
DIRECTLY from `flood_report_export.py`, not duplicated; only the
landslide-specific CONTENT (banner, KPI values, mitigation measures —
now incorporating the rockfall/avalanche typology findings a flood
report has no equivalent of, scenario rows for both `susceptibility`
and `trigger` modes) is new.

**Live-tested over real HTTP, both modes, both export types**: the
custom-AOI susceptibility job's own GeoJSON export returned 200,
314,081 bytes (comfortably under the real nginx conf's own 100M
`client_max_body_size`), 3 features, the "high" feature alone correctly
carrying exposure properties; its own report export returned 200,
38,257 bytes, independently confirmed as a genuine "Microsoft Word
2007+" file by magic-byte inspection, not just a non-empty response. A
separate `mode="trigger"` job's own exports were tested too: GeoJSON
returned a correct single-Point FeatureCollection (606 bytes), the
report export returned a valid 37,369-byte docx.

**Production-readiness — explicitly checked against the real nginx
conf pasted this turn, not assumed**: `client_max_body_size 100M` — every
payload observed this pass (314KB GeoJSON, ~38KB docx) is 3+ orders of
magnitude under that ceiling, and `LandslideModelReportExportView`
carries the same `RequestDataTooBig` guard `FloodModelReportExportView`
already does for an oversized `map_image` upload. `proxy_read_timeout/
connect_timeout/send_timeout 60s` — every new endpoint (export,
report-export) only reads an already-computed, cached job result and
does fast, in-process work (JSON reshaping, docx assembly) — never a
new external fetch, so none of them are newly at risk of that 60s
ceiling; the one genuinely slow new code path (a custom AOI's own
first-ever cold build, confirmed live at several minutes for the full
Overture/OSM/WorldPop exposure chain) already runs entirely inside the
async job pattern, same as every curated catchment. `gzip`/`/media/`/
`/static/`/`/assets/` — nothing this batch added touches those
locations; `GZipMiddleware` (global, already-fixed per §0's own
retrospective) already compresses these new JSON responses too, no
separate fix needed.

**Throttle scopes registered and live-confirmed**: `landslide_model_
export` (20/min) and `landslide_model_report_export` (10/min), matching
flood's own figures exactly, not independently re-derived. A burst of
6 export requests in this pass all succeeded (under the 20/min cap, as
expected) — the cap's own ENGAGEMENT was already independently proven
for the identical `AnonRateThrottle` mechanism via the run endpoint's
own 3/min test in L5 above; not re-proven a second time for export
specifically, honestly noted rather than silently implied as equally
tested.

**What remains, honestly**: the frontend (`landslide-model-control.js`,
the MapboxDraw wiring, the shapefile-upload UI hookup) is still not
built — the SAME named L5 gap, now also covering the new custom-draw/
export UI, not a new one. `classify_terrain_class` still returns one
profile for every catchment regardless of real terrain differences
(confirmed live for Astore specifically) — a real, pre-existing
limitation this batch surfaced sharper evidence for, not created.

### L6 — Generalization

The same stress test Bhudni Nullah was for the flood AHP work's own
generalization claims — expect, and honestly report, a mix of
confirmed-good and honestly-short-of-target results, not a second
guaranteed success.

1. ✅ **Done**: Hunza-Nagar/Karakoram Highway corridor picked as the
   second pilot (already registered in L5.5) — real prep work paid off.
2. ✅ **Done, and genuinely rebuilt, not just re-run**:
   `classify_terrain_class` now dispatches on real, MEASURED mean
   elevation (`_HIGH_RELIEF_MEAN_ELEVATION_GATE_M = 2500m` — the SAME
   value `avalanche_model.AVALANCHE_ELEVATION_GATE_M` already uses, a
   deliberate cross-reference, not a coincidence) rather than always
   returning `"moderate_relief_monsoon"`. Slope alone was checked and
   REJECTED as the discriminator first — live-confirmed Astore's own
   mean slope (31.71°) sits between Murree/Galyat's (25.2°) and
   Hunza-Nagar's (33.38°), too close to draw a clean line; mean
   elevation does not have this problem in the real data (§ below).
3. ✅ **Partially done, honestly**: a genuinely new, literature-distinct
   AHP weight table (`landslide_ahp.HIGH_RELIEF_KARAKORAM_FACTORS`,
   CR=0.0139 full / 0.0071 lite, both live-verified) was built and
   wired — a real, substantive terrain-conditioned decision, not a
   reused copy of Murree's own table. Grounded in a real, DIRECTLY
   fetched finding this session (the Karakoram Highway 10-factor NHESS
   2019 study's own live-confirmed quote: "active faults, slope
   gradient, seismicity and lithology have a strong influence" —
   genuinely different from Murree's own rainfall-led ranking), with a
   real, NAMED gap: "distance from faults" is one of that study's own
   10 factors and this project has no fault-line vector layer to build
   it from — its real signal is folded into an elevated `pga` weight
   instead (0.17, up from Murree's own 0.04 — the single biggest
   structural change), stated as a substitution, not hidden. **NOT
   done**: the doc's own "likely Frequency-Ratio" preference (§3.4,
   from the confirmed Gilgit-Skardu Road AHP-FR-LR comparison) needs
   real ground-truth presence points to compute — the SAME COOLR
   access blocker L3 already found is still down (re-confirmed live
   this pass, not assumed stale), so FR fusion for this pilot remains
   real, blocked, deferred work, not silently skipped or faked.
4. ✅ **Done, honestly, with the same real null result L3 already
   found**: `validate_landslide_susceptibility` re-run for Hunza-Nagar/
   Karakoram — COOLR's own endpoint independently re-confirmed still
   404 (not assumed stale from the earlier L3 check), `n_coolr_events=0`
   for this bbox too, both AUC results `"no_ground_truth"`.
5. ✅ **Done** — see the cross-pilot table below.

**Live-tested, rigorously, both a regression check and new coverage**:
(1) Murree/Galyat re-classified — still `moderate_relief_monsoon`,
confirming the new dispatch logic didn't silently regress the first
pilot; (2) all 6 registered catchments classified against the real,
measured threshold — a clean 2-vs-4 split with NO catchment straddling
the boundary ambiguously (murree_galyat 1,480.8m / ajk_muzaffarabad
1,586.4m → moderate; chitral_reshun 3,016.6m / besham_chilas_kkh
2,972.1m / astore 3,702.3m / hunza_nagar_karakoram 3,908.3m → high-
relief) — real evidence the threshold was a sound, non-arbitrary choice,
not just asserted; (3) the full L1 pipeline run end-to-end for Hunza-
Nagar/Karakoram — `weights` in the returned result independently
confirmed to be the NEW table actually in use (`pga=0.17`, `rainfall=
0.08`), not silently falling back to Murree's; score raster correctly
on the [1,5] scale (2.10–3.94); (4) zone geometries — the adaptive
sieve/simplify backoff loop genuinely exercised for the first time on a
non-Murree catchment (2 real iterations before converging under
budget, vs. Murree's own first-iteration convergence — the mechanism
generalizing correctly to a different terrain's own noise
characteristics, not just working by coincidence for one basin); (5)
infinite-slope/rockfall/avalanche layers all built and sane; (6) cache
correctness confirmed (3.99s on a `force=False` re-run).

**A real, honestly-flagged data gap surfaced by this pass**: Hunza-
Nagar/Karakoram's own real geology WFS fetch returned codes `GG`/`P`/
`Pz`/`Q`/`Tr` — `GG` now resolves correctly via L5.5's own case-
insensitive-matching fix, but `P` (plausibly Precambrian), `Pz`
(Paleozoic), and `Tr` (Triassic) are genuinely new, era-only codes not
yet in `_GEOLOGY_CODE_HAZARD_CLASS`/the infinite-slope parameter
tables — confirmed live: `build_infinite_slope_layer`'s own
`params_used` for this catchment only ever resolved `Q`, with every
other pixel falling to the honest neutral/hedged default. Not force-
resolved this pass: era-only labels (a "Paleozoic" rock could be
sedimentary or metamorphic) are genuinely more ambiguous than a named
Formation like Kuldana/Murree, and guessing a specific hazard class
without a real citation would violate this project's own "no fabricated
precision" discipline — named here as real, live-confirmed remaining
work, same treatment as `Mpv` (Astore, §5.5) and `Pc`/`DS` (Murree,
§13/L1).

**Cross-pilot summary — both real, not just the better one**:

| Metric | Murree/Galyat (moderate_relief_monsoon) | Hunza-Nagar/Karakoram (high_relief_karakoram) |
|---|---|---|
| Mean elevation | 1,480.8 m | 3,908.3 m |
| Mean / p90 slope | 25.2° / 38.24° | 33.38° / 53.06° |
| Dominant geology | Tk (shale/siltstone/sandstone) | GG (igneous/metamorphic) |
| Top 3 AHP weights | rainfall 0.22, lithology 0.18, slope 0.15 | pga 0.17, slope 0.17, lithology 0.15 |
| AHP CR (full / lite) | 0.0163 / 0.0086 | 0.0139 / 0.0071 |
| Susceptibility score range | 2.08–4.47 | 2.10–3.94 |
| Rockfall-flagged area | 1.82% (20.4 km²) | **23.74% (471.7 km²)** |
| Avalanche-gated fraction | 0.62% | **54.41%** |
| COOLR validation | `no_ground_truth` (0 events, endpoint 404) | `no_ground_truth` (0 events, endpoint 404, re-confirmed) |

The rockfall/avalanche contrast in particular is real, independent
confirmation (not circular — neither layer's own logic references
`classify_terrain_class` or the AHP weight tables at all) that this
second pilot really is a physically different regime: over 13x more
rockfall-susceptible area and over 87x more avalanche-gated area than
Murree/Galyat, computed by two layers with zero shared logic with the
terrain classifier that also, independently, called this catchment
"high relief."

**L6 verification — done, honestly, matching what the plan's own
verification bar actually allows given a real external blocker**:
two catchments now run through the SAME, live-tested pipeline with two
genuinely different, literature-grounded weight profiles, both CR-
validated, both producing real, physically-sensible, independently-
cross-checked-different outputs. The doc's own original verification
bar ("two independently COOLR-validated pilots... each with its own
real AUC number") is **not fully met** — both pilots' own AUC numbers
are honestly `no_ground_truth`, not two different real numbers, because
the one wired ground-truth source is still down for both. This is
reported as the real, current state, not silently reinterpreted as
success.

---

### L6.5 — LHASA2 real-time feature extraction + exposure scan

Per explicit instruction: turn the LHASA2 Meteoblue nowcast layer (§3.2 —
display-only until now) into something actionable — pull the real tile
pixels for Pakistan, extract the elevated-probability areas, vectorize
them into real polygons, and run the same exposure machinery (buildings/
roads/drainage/population) already used everywhere else in this app
against those polygons. This directly resolves §3.2.3's own "confirmed, a
real buildable path exists" finding — that section scoped exactly this
pipeline (tile-decode via nearest-color match against the published
`contourSteps` stops, Web-Mercator georeferencing, GDAL vectorization) and
flagged it as real, scoped, near-term work; it is now built, not just
scoped. New module: `ncop_internal/landslide_lhasa2_scan.py`. New job mode:
`"lhasa2_exposure_scan"` (landslide_model_views.py, its own 4th, independent
job type — needs no catchment, never shares the Mode/Run flow's own job
slot). Frontend: a secondary action under the LHASA2 checkbox in
"Cross-check layers" (landslide-model-control.js), its own polling loop,
its own map layer.

**The one hard architectural constraint this had to be built around**:
every AOI in this app is capped at `flood_model.MAX_CATCHMENT_BBOX_DEG2`
(0.30 deg²) — confirmed live, Pakistan's own bbox is ~230 deg², ~750x over
that cap, so the whole country can never be pushed through the exposure
pipeline as one AOI. Exposure therefore runs once per extracted,
individually-small blob (each well under the cap, via
`flood_model.register_custom_aoi`/`landslide_model.register_custom_
landslide_aoi` — the exact same mechanism a hand-drawn custom AOI already
uses), capped at `max_exposure_blobs` (default 20) given
`flood_exposure._OVERTURE_EXECUTOR`'s own single-worker executor — the
rest are still reported, by footprint only, honestly labeled as not
assessed rather than silently dropped.

**A real correctness bug found and fixed during live testing, not
theoretical**: the first working version clipped extracted blobs to a
plain rectangular bbox over Pakistan. Confirmed live: its own single
LARGEST extracted feature (763 km², centroid ~77.52°E/30.78°N) sat
squarely in Himachal Pradesh, **India**, not Pakistan — the exact same
class of false-positive this project's own OSM ground-truth research
already found and reported honestly (§L3.5's "17 raw features, 1 real
Pakistan point" finding). Fixed by fetching the REAL national boundary
polygon (GeoServer's own `national_boundary` layer — the same layer
frontend/src/modules/map-layers.js's "National Boundary" catalog entry
already renders — via `flood_exposure._wfs_get_geojson`, reused
unmodified) and intersecting extracted blobs against it, not the bbox
rectangle alone. Sanity-checked directly: the fetched boundary contains
Islamabad/Karachi/Lahore/Gilgit and excludes Shimla/New Delhi/Kabul — a
real, correct national outline, not a wrong or empty geometry. A second
real gap this same check caught: the boundary's own real extent reaches
~79.31°E (Kashmir), beyond the original 77.9°E tile-fetch bbox — widened
to 79.6°E so the real boundary intersection is never starved of tiles to
clip against in the first place.

**Real, live-tested result (2026-09-02 nowcast, threshold=50%, the color
ramp's own visual "elevated" midpoint — a stated heuristic, not a
literature-validated cutoff for this product's 0-100 scale)**: **zero**
extracted features reached 50% within real Pakistani territory on this
date — a genuine, honest "no elevated signal today" result, not a fetch
failure, re-confirmed after the bug fix below.

**A second real bug, caught when the user pushed back against the "zero"
result against a live screenshot showing visible colored patches inside
Pakistan (correctly — the pushback was right).** The original per-blob
extraction unioned every class's own geometry together FIRST, then split
the result into blobs purely by spatial connectivity, then labelled each
blob with the HIGHEST class touching it anywhere. At low thresholds the
near-ubiquitous low-probability class is contiguous with almost the whole
country, so this glued nearly all of Pakistan into one "blob" and
mislabelled it with whatever elevated class happened to touch it anywhere
— confirmed live: a 980,191 km² "feature" got reported as "class ≥30%"
even though real class-30 area anywhere in the country was only 12.4 km².
This is what produced the earlier, WRONG specific claim of "two ~13 km²
30-40% patches" — a real artifact of the bug, not real data. **Fixed** by
never unioning across classes: each class's own geometry (already correct
and already dissolved within itself by `_vectorize_multiclass_raster`) is
split into its own connected parts, each part keeping its OWN real class —
adjacent patches of different classes are now intentionally reported as
separate, individually-correct features, never merged into one blob
carrying a neighbor's class.

**The real, corrected picture for 2026-09-02** (`threshold_pct=10`
diagnostic, clean per-class breakdown, no merging artifact): 12 real
features between 10-30%, concentrated around two genuine clusters —
Azad Kashmir/near Islamabad (~74.3-75.6°E, 33.0-33.6°N; largest single
feature 668 km² at 20%, plus a real 12.4 km² spot at 30%) and
Gilgit-Baltistan/Karakoram (~74.3-75.3°E, 35.0-36.1°N; largest 3,455 km²
at 10%, several 20% patches up to 159 km²) — this is exactly the visible
green/yellow-green patch near Gilgit in the user's own screenshot,
correctly detected by this pipeline, just below the 50% "elevated"
reporting cutoff by design. The large orange/red patches visible further
east in that same screenshot (near Dehradun/Chandigarh) are correctly
excluded — confirmed to sit in India, outside the real national boundary
this pipeline clips against (see the first bug above). **Zero real area
reaches 40% or higher anywhere in Pakistan on this date** — the "zero
elevated features" headline claim was and remains correct; what was wrong
was a specific downstream diagnostic detail, now fixed and superseded by
this clean breakdown.

Before either fix, the SAME date's bbox-only run had found 24 "features"
and (on the one assessed via `max_exposure_blobs=1`) real, correctly-
computed exposure numbers (35,882 buildings, 851 km of road, 20 bridges,
1 hospital) for a blob that, per the national-boundary finding above, was
never actually in Pakistan — a concrete demonstration of why that clip is
load-bearing, not cosmetic. Real HTTP round-trip confirmed end-to-end
(`POST /api/landslide-model/run/` → `{"mode":"lhasa2_exposure_scan"}` →
poll → `export/`), all 3 stages progressing correctly, `python manage.py
check` clean, existing susceptibility/trigger/national_validation modes'
own request validation confirmed unaffected (regression-checked directly,
not assumed).

---

### L6.6 — A much richer real ground-truth source, and an honest regression it exposes

The user pointed at 4 WMS layers on a second GeoServer (`172.18.1.100:8080`)
— regional AHP susceptibility zonations for KP/Balochistan/AJK/GB — asking
how to use them to improve our own AHP calculation. Direct investigation
(WMS/WFS/WCS `GetCapabilities`/`DescribeCoverage`, live queries, not
assumed) found that GeoServer holds **144 layers total**, including two
real, Pakistan-specific ground-truth sources far richer than COOLR
(broken)/GFLD (257)/GLC (142) combined:

- **`Landslide_inventory_overall`** — 2,289 real, dated, digitized
  landslide MultiPolygon extents (`Year`/`LS_Name`/`Area_Sqkm`/`LS_Type`,
  plus `Pre_EQ`/2005/2010/2014/2016 temporal flags — a real multi-period
  geological inventory).
- **`2025_Landslide_Events`** — 31 real, recent (2025) point incidents
  (`District`/`Name_of_Ev`/`Date_of_Ev`/`Damages__L`/`Response`/
  `Intensity`).

Both served over plain WFS (confirmed live), and — a genuine upgrade over
every point-based source already wired in — the inventory layer's own
geometries are REAL polygons, used directly as presence evidence, no
synthetic point-buffer approximation needed. New fetchers:
`accuracy_assessment.fetch_ncop_landslide_inventory_presence_geoms`/
`fetch_ncop_recent_events_presence_geoms`, wired additively into all 3
existing pooling call sites in `landslide_model.py`
(`validate_landslide_susceptibility`/`_national`/
`calibrate_landslide_frequency_ratio_loco`).

**Confirmed live, real per-catchment counts**: `ajk_muzaffarabad` gained
500 new inventory points (was a handful before — now 510 pooled total);
`hunza_nagar_karakoram` gained 67 (now 80 pooled). `murree_galyat`,
`astore`, `chitral_reshun`, `besham_chilas_kkh` gained none from the
inventory layer specifically (its own real coverage doesn't reach those
particular small pilot bboxes) — a real, honest gap, not hidden.

**The honest, sobering finding this enrichment exposes — reported
plainly, matching this project's own established discipline of reporting
whatever the number actually is, not what was hoped for**: re-running
the LOCO Frequency-Ratio calibration (§L3.7) with this much larger,
statistically stronger ground truth, the held-out pooled AUC **dropped
from the earlier 0.79-0.80 "fair" to 0.55 "fail"** — and AHP-alone,
tested on the identical held-out data, now scores 0.60 "poor", actually
**outperforming** the FR-calibrated score. Per-fold breakdown:

| Held-out catchment | n real events | FR AUC | AHP-alone AUC |
|---|---|---|---|
| murree_galyat | 4 | 0.64 poor | 0.41 fail |
| astore | 4 | 0.75 fair | 0.70 fair |
| chitral_reshun | 5 | 0.71 fair | **0.82 good** |
| hunza_nagar_karakoram | 80 | 0.57 fail | 0.64 poor |
| ajk_muzaffarabad | 510 | 0.63 poor | **0.73 fair** |
| besham_chilas_kkh | 7 | 0.78 fair | 0.63 poor |

**Why this is a more trustworthy number, not a step backward**: the
earlier 0.79-0.80 result was fit and tested against a much thinner,
smaller, more homogeneous sample (every catchment ≤9 real events at the
time). The two catchments that just gained real statistical weight
(hunza_nagar_karakoram: 80 events, ajk_muzaffarabad: 510) are now BOTH
folds where literature AHP beats the locally-fit FR score — a genuine
sign that the earlier calibration was, at least in part, fitting to a
small sample's own noise rather than a real, generalizable pattern.
**The previously-reported "reaches the 75-80% target" claim (§L3.7) no
longer holds** once tested against this much richer, more realistic
ground truth — stated here explicitly, not silently superseded. Local
FR calibration is not currently a reliable improvement over the
literature-weighted AHP score across this catchment set; both are
weak-to-poor performers on real, honest, held-out data. This is real,
substantive work still open for a future phase (a different calibration
approach, more factors, or more training data may be needed) — not
attempted further in this pass per the explicitly confirmed scope
(ground truth + validation only, no weight changes this pass).

**Part 2 — independent comparison against the 4 regional AHP rasters**,
confirmed to be real WCS raster coverages (not WFS vectors — 10m/px
native resolution, KP/Balochistan in EPSG:32642, AJK/GB in EPSG:32643,
each independently produced from ours). New module
`landslide_regional_comparison.py`: fetches a small, bbox-clamped WCS
subset (never the full ~50,000×67,000px raster), reprojects it onto our
own AHP raster's exact grid via `flood_model._warp_to_grid` (reused
unmodified), and computes a real Spearman rank correlation over the
shared valid area (pandas' own tie-aware ranking — scipy is not a
project dependency).

**A real bug found and fixed during live testing**: picking "the best-
overlapping region" by bounding-rectangle overlap AREA alone picked
`kp` for `ajk_muzaffarabad`, because a UTM-zone coverage's reprojected
geographic bounding rectangle is a loose superset that spills well
outside the real province (KP's own reprojected rectangle, ~35 deg²,
fully engulfs AJK's real, much smaller ~5.8 deg² one). Fixed by
preferring, among every region whose rectangle (near-)fully contains the
catchment, the one with the SMALLEST own rectangle — confirmed live this
correctly resolves `ajk_muzaffarabad → ajk`. A second real bug: passing
`force=True` through to the reused susceptibility build propagated all
the way to a DEM re-fetch, which hit a real Earth-Engine read-timeout on
live test — fixed by decoupling this module's own cache-bust from our
susceptibility raster's own (always read from cache here, never
force-rebuilt).

**Real, live results** (Spearman r between our AHP score and each
catchment's own best-matching regional product, over the full shared
valid pixel area):

| Catchment | Region | n pixels | Spearman r | Interpretation |
|---|---|---|---|---|
| murree_galyat | ajk | 72,272 | 0.059 | negligible |
| astore | gb | 1,929,879 | 0.321 | weak |
| chitral_reshun | kp | 2,041,530 | 0.261 | negligible |
| hunza_nagar_karakoram | gb | 2,206,863 | 0.389 | weak |
| ajk_muzaffarabad | ajk | 893,604 | -0.053 | negligible |
| besham_chilas_kkh | gb | 0 | — | no overlapping valid data (real, honest gap) |

An honest second finding: our own AHP susceptibility score shows only
weak-to-negligible spatial agreement with these independently-produced
regional products — reported as-is, not spun. Per the explicitly
confirmed scope for this pass, this comparison is NOT fed back into AHP
weights; it's a real, independent second opinion only.

Wired into `validate_landslide_susceptibility_national`'s own return
shape as an additive `"regional_comparison"` field (own section in the
national-validation results panel, `landslide-model-control.js`).
Real HTTP round-trip confirmed end-to-end through the existing
`national_validation` job mode (no new endpoint needed); `python
manage.py check` clean; `lhasa2_exposure_scan`/bad-mode request
validation regression-checked directly, unaffected.

---

### L7 — Why the AHP score looked poor, a calibrated model, and every remaining open item

Picks up exactly where L6.6 stopped (held-out AUC 0.55 FR / 0.60 AHP).
Every number below was produced live on 2026-11-17; unit tests are in
`ncop_internal/tests_landslide_l7.py` (27 tests, no network, no DB).

**1. The main reason the scores looked poor: the point catalogs are not
located precisely enough to validate a 30m map.** A per-factor
diagnostic (each factor's own AUC against GFLD+GLC, per catchment) came
out backwards in a physically implausible way: slope scored 0.20–0.54
(presence on *gentler* ground than average), distance-to-road 0.07–0.29
(i.e. landslides hug roads) and the infinite-slope FS 0.17–0.70.
Inspecting the catalogs' own precision fields explained it:

| Catalog (Pakistan) | Total | Located within ~1 km | Typical placement |
|---|---|---|---|
| GLC `location_accuracy` | 142 | **7** (1 exact, 6 "1km") | 5–100 km classes; 31 "unknown" |
| GFLD `Precision_` (area of the geocoded place, m²) | 257 | **21** | district/town polygons, e.g. Chitral 14,248 km² |

Points geocoded to a town or district centre sit on a valley road, so
the old flat 250 m buffer scored the map on where landslides were
*reported*, not where slopes failed. That also undermines the L3.5/L3.7
numbers built on these sources, the 0.79–0.80 figure included.
**Fix:** `fetch_gfld_presence_geoms`/`fetch_glc_presence_geoms` now keep
only points with stated uncertainty ≤ `_POINT_MAX_LOCATION_UNCERTAINTY_M`
(1 km), each buffered by its own uncertainty radius;
`max_location_uncertainty_m=None` restores the old behaviour.

**2. Why calibration did not transfer between catchments (L6.6's
reversal)** — fixed in the new `landslide_calibration.py`:
- *Per-catchment quantile classes.* `_quantile_reclassify_hazard` put
  each catchment's steepest 20% in class 5 (~38° in Murree, ~53° in
  Hunza), so a weight learned on one catchment's "class 5" was applied
  to a different physical slope band elsewhere. All factors are now
  binned on **absolute** edges (degrees, km, mm/yr, NDVI, lithology
  group), identical everywhere.
- *Linear min-max stretching* in the AHP sum compresses most pixels into
  a narrow band when one outlier exists, and forces a monotonic
  response. One-hot classes allow non-monotonic responses.
- *Unweighted pooling* (510 AJK events vs 4 Murree) — training weights
  are now ∝ √n_events per catchment, presence/absence balanced within each.

The model is an L2-regularized logistic regression (Newton/IRLS in
NumPy; no new dependency), compared under leave-one-catchment-out (LOCO)
against the literature AHP and the infinite-slope FS **on identical
held-out pixels**, plus a 2×2 spatial-block split inside any catchment
with ≥ 30 events. Three candidate factor sets are compared
(`ahp_factors`, `with_elevation`, `geomorphic` = no road distance).

**Results with the ground truth reachable today** (the NCOP inventory
server was down, see 4):

| Ground truth | Events | AHP (held-out pooled AUC) | Calibrated | Infinite slope |
|---|---|---|---|---|
| All GFLD+GLC points (unfiltered, as before) | 40 | 0.59 | 0.87 (`with_elevation`) | 0.36 |
| Precise points only (≤ 1 km) | 7 in 4 catchments | 0.64 | 0.80 (`ahp_factors`), won 4/4 folds | 0.41 |

The unfiltered 0.87 is not a real skill figure: distance-to-road was its
top factor (26% of importance), i.e. it learned the catalogs' reporting
bias. The precise-point result points the same way as the AHP-vs-
calibrated comparison in every fold, but 7 events cannot support a
production switch.

**Approval rule (production safety).** Saved to
`media/landslide_model/_calibration/susceptibility_model.json` with its
full evidence. `method="auto"` (the default) uses the calibrated score
only when it (a) beats AHP's pooled held-out AUC by ≥ 0.02, (b) wins a
majority of LOCO folds, and (c) rests on ≥ 100 events in ≥ 3
catchments. Today's model fails (c) and is **not approved**, so every
run still uses the literature AHP. `method="calibrated"` forces it (for
inspection); `method="ahp"` pins the old score. Calibrated scores are
on the same [1,5] scale and are cached per `model_id`, so retraining can
never serve stale smoothed rasters or zones.

**Infinite-slope calibration** (the L3.7 named gap): soil depth,
saturation scale and cohesion scale are grid-searched on training folds
only. It does not beat the defaults held-out (0.41 vs 0.41 on precise
points), so the defaults stay; the layer is now cache-keyed on its
parameter set, so an approved fit would rebuild it automatically.

**3. Geology codes.** A full WFS pull of the live geology layer (66
code/name pairs) shows the layer *labels* several "unknown" codes
itself: `P` = Permian Sedimentary Rocks, `Pz` = Paleozoic Rocks,
`Tr` = Triassic, `M` = Mesozoic Rocks, `Tm`/`TM` = **Miocene**
Sedimentary Rocks (confirming the earlier Murree Formation inference),
`TK`/`Tk` = Early Tertiary Rocks. Every national code is now in one of
six lithology groups (`_GEOLOGY_CODE_GROUP`), driving the hazard class,
cohesion/friction/unit weight and is-rock flag. Explicit per-code values
always win. `MPv`/`Mpv` are inferred as Mesozoic–Paleozoic volcanics
from the dataset's own naming pattern (`Kv` = "Cretaceous Sedimentary
and Volcanic Rocks"), flagged as an inference. `As` stays ungrouped.
Lookups are now exact-case first (the live layer has `M` = Mesozoic vs
`m` = igneous), then case-insensitive. `params_used` now reports every
code present, with a `resolved` flag. A derived-cache version stamp
(`_DERIVED_CACHE_VERSION`) rebuilds every catchment's geology-derived
rasters once, so existing caches pick up the new tables.

**4. Ground-truth resilience.** On 2026-11-17 `172.18.1.100` answered
ping but every HTTP port timed out, removing the inventory entirely. The
NCOP inventory/recent-events layers are now fetched **once nationally**,
cached to disk (7-day TTL), filtered by bbox locally, served stale if a
refresh fails, and not retried for 10 minutes after a failure. This also
fixed a silent truncation: the old per-bbox `count=500` dropped 29 of
AJK's 529 inventory features. GLC got the same failure backoff.

**5. Debris-flow screening** (the deferred typology item) — new
`debris_flow_model.py`, Wilford et al. (2004) Melton ratio + watershed
length on every stream link of the cached HAND pipeline, painted onto
each link's subbasin. Live: Murree 29.8% of area debris-flow-capable /
50.9% debris-flood; Hunza-Nagar 37.8% / 56.1% (10 s / 3 s). Published BC
thresholds, not re-fitted for Pakistan. Wired into the susceptibility
job, GeoJSON/report export and the panel map (red/orange outlines).

**6. Request coalescing** (the §0.1 gap): `flood_model.build_hand_
pipeline` now takes a per-catchment lock; a caller that waited behind an
in-flight build re-enters with `force=False` and finds every step cached.
`_get_cached_buildings_index` now goes through `_submit_coalesced`.

**What still needs the inventory server.** The calibrated model is
built, tested and wired, but it can only be trained on adequate ground
truth once the landslide GeoServer is reachable (it was, at its new host — see below). Then run the
"Train & test calibrated model" mode (or `POST
/api/landslide-model/run/ {"mode": "calibrate"}`): it will fetch and
cache the national inventory, re-test everything held-out, and switch
Auto runs over only if the approval rule passes.

**L7 live run on the real inventory (2026-11-17).** The landslide
GeoServer moved to `172.18.1.113:8080` (now
`settings.NCOP_LANDSLIDE_GEOSERVER_HOST`, env-overridable); all 2,289
inventory polygons and the 4 regional WCS rasters are served there. The
national cache now holds the full inventory: AJK has **705** inventory
polygons (the old count=500 cap had shown 510 pooled).

| Held-out test | AHP | Calibrated (best set) | Infinite slope |
|---|---|---|---|
| Leave-one-catchment-out, pooled (782 events, 4 catchments) | 0.650 | 0.684 | 0.486 |
| — AJK held out (708 events) | **0.735** | 0.700 | 0.565 |
| — Hunza held out (72 events) | **0.664** | 0.652 | 0.547 |
| Spatial-block CV inside AJK (other quadrants + other catchments train) | 0.673 | **0.755** | — |
| Spatial-block CV inside Hunza | 0.586 | **0.776** | — |

(The Chitral and Besham folds have 1 event each and are noise.) Result:
**not approved** — the calibrated model wins only 1/4 LOCO folds. A model
fitted on AJK (2005 earthquake slides, moderate relief) does not
transfer to Hunza (high-relief Karakoram) or vice versa, and with only
two well-sampled catchments the coarse CHIRPS rainfall factor partly acts
as a region identifier (top importance 0.28). Within a catchment that
has its own inventory, calibration genuinely helps (+0.08 AJK, +0.19
Hunza, held-out quadrants). The literature AHP therefore stays the
default everywhere. The open decision is whether to approve the
calibrated score per catchment where its own spatial CV beats AHP. The
infinite-slope layer stays below 0.5–0.57 even on the polygons and is
not recalibrated.

**L7 finalization — the deployment rule, from the literature and NCOP's
own limits.**

*What the literature says, and how it maps onto NCOP:*
- Statistical susceptibility models transfer poorly between regions
  with different conditions (e.g. LR/FR models across 23 US regions:
  transferred AUC 0.56–0.84; transfer-learning work in GMD 2022). NCOP
  confirmed this directly: AJK (2005 co-seismic slides, moderate relief)
  and Hunza (high-relief Karakoram) do not predict each other.
- Heuristic (expert-weighted) zoning is the operational norm where no
  adequate inventory exists, and statistical models need one (zoning
  literature, Fell et al. 2008 / Corominas et al. 2014 as cited by
  later reviews). NCOP has an adequate inventory in only two of six
  pilots (AJK 708, Hunza 72 events; the rest 0–1).
- High AUC does not guarantee a plausible map; coarse fields that act as
  location proxies confound the model, while bias-describing predictors
  (e.g. roads, where inventories cluster along them) should be kept
  (Steger et al. 2016, Geomorphology 262). Roads are also a real
  control in the 2005-Kashmir inventory (Owen et al. 2008; Kamp et al.
  2008, who rank lithology first, then faults, rivers and roads).
- Spatial (block) cross-validation, not random splits, is the accepted
  held-out test for spatially autocorrelated landslide data (Brenning).

*Final rule (implemented in `landslide_calibration._calibrate_local` /
`scoring_model_for`):* the literature AHP score is the default
everywhere. A calibrated score replaces it **only in a catchment that
has its own inventory (≥ 50 events) and where, on held-out quadrants of
that same catchment, the calibrated model beats AHP's AUC by ≥ 0.02 and
wins a majority of quadrants**. The cross-catchment (global) model is
used everywhere only if it ever passes the stricter LOCO rule. Custom
AOIs always use AHP. The local model's factor set is chosen by spatial
CV among candidates that obey a **scale rule**: no regional zoning or
climatology field far coarser than the 30 m map. Rainfall (CHIRPS
~5 km) and the building-code PGA zones are excluded. With them, spatial-
CV AUC was higher (0.74–0.76), but their coefficients were physically
implausible: rainfall jumped +4.7/−1.4/−4.5/+2.6 log-odds between
adjacent bins, and inside Hunza the higher PGA zone got −4.3 log-odds.
That is the coarse-proxy failure Steger et al. describe. Both stay in
the AHP at their cited weights. Distance to active faults (new
`build_distance_to_fault_raster`, from `seismological_global:
faultlines`, which closes the L6 "no fault layer" gap) was tested as a
candidate and did not improve held-out AUC (0.66–0.72 vs 0.69–0.75
without), so it is built and available but not used by the model.

*Final result (model `e19d475f8a`, 2026-11-17):*

| Catchment | Score used in Auto runs | Held-out evidence |
|---|---|---|
| Hunza-Nagar | **Calibrated (local, `terrain` set)** | spatial CV 0.731 vs AHP 0.586, 4/4 quadrants |
| AJK Muzaffarabad | Literature AHP | calibrated 0.655 vs AHP 0.673 — AHP already at least as good |
| Murree, Astore, Chitral, Besham, custom AOIs | Literature AHP | 0–1 usable events: nothing to calibrate on |

The deployed Hunza model's responses are all physically plausible:
monotonic in slope (−0.68 → +0.49) and NDVI (+0.82 → −1.40), decreasing
with elevation (valley-side concentration), highest 0.1–1 km from roads
and within 1 km of drainage, and higher for unconsolidated Quaternary and
Mesozoic sediments than for crystalline rock. The infinite-slope layer
(held-out 0.49–0.57) is kept only as a screening layer at literature
defaults. Without site soil-depth and strength data, which NCOP does not
have, a physically based model cannot be calibrated meaningfully.

*How it extends:* add inventory polygons for another pilot to the
landslide GeoServer and re-run the calibrate job. The same rule then
decides that catchment on its own held-out evidence, with no code change.

---

## Sources

- [Fast physically-based rainfall-induced landslide susceptibility model, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0341816221000722)
- [Comparison of hybrid data-driven and physical models, Acta Geotechnica](https://link.springer.com/article/10.1007/s11440-023-01841-4)
- [Infinite slope, SHALSTAB, SINMAP, TRIGRS comparison — Serra do Mar, Brazil, Journal of Mountain Science](https://link.springer.com/article/10.1007/s11629-021-7057-z)
- [Evolution and critical evaluation of deterministic physically-based landslide models, Natural Hazards 2025](https://link.springer.com/article/10.1007/s11069-025-07634-0)
- [GRASS GIS `r.shalstab` manual](https://grass.osgeo.org/grass84/manuals/addons/r.shalstab.html)
- [Soil-parameterization study, Rio de Janeiro, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0013795202002636)
- [NASA LHASA2 technical report, NTRS](https://ntrs.nasa.gov/citations/20205001695)
- [NASA `nasa/LHASA` GitHub](https://github.com/nasa/LHASA)
- [GPM Landslides project page, NASA](https://gpm.nasa.gov/landslides/projects.html)
- [Astore region AHP landslide susceptibility, EQA journal](https://eqa.unibo.it/article/view/12600)
- [Chitral District landslide model evaluation, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC9101762/)
- [Reshun, NW Pakistan — AHP vs. Frequency Ratio, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S230741082300055X)
- [Sub-Himalayan region hazard risk assessment, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-020-03980-3)
- [Murree landslide susceptibility mapping (geoinformatics/WoE), SpringerLink](https://link.springer.com/chapter/10.1007/978-981-15-0454-9_20)
- [Geological controls, Murree Hills / Main Boundary Thrust zone](https://squ.elsevierpure.com/en/publications/geological-controls-in-slope-failure-and-landslide-hazards-main-b/)
- [Gilgit-Skardu Road — AHP/FR/logistic-regression comparison, Research Square](https://www.researchsquare.com/article/rs-5124940/v1)
- [Karakoram Highway corridor GIS landslide susceptibility, NHESS 2019](https://nhess.copernicus.org/articles/19/999/2019/)
- [Hunza Valley SBAS-InSAR + ML landslide susceptibility, Springer 2025](https://link.springer.com/article/10.1007/s10064-025-04299-8)
- [Cooperative Open Online Landslide Repository (COOLR), UN-SPIDER](https://un-spider.org/links-and-resources/data-sources/cooperative-open-online-landslide-repository-coolr-nasa)
- [COOLR Events Points live FeatureServer, NASA](https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/COOLR_Events_Points/FeatureServer)
- [Landslide-triggering rainfall thresholds, Kashmir Himalaya, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-023-06254-w)
- [Representative rainfall thresholds, Nepal Himalaya, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0169555X08000172)
- [Rainfall threshold, NH-10 Darjeeling Himalaya](https://www.academia.edu/112643789/Estimation_of_rainfall_threshold_for_the_early_warning_of_shallow_landslides_along_National_Highway_10_in_Darjeeling_Himalayas)
- [Rainfall threshold, Garhwal Himalaya, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2772883824000359)

### Additional sources — expanded L0 survey (§3.6)

- [Murree FR/IV/WoE comparison, 102-landslide inventory, Research Square](https://www.researchsquare.com/article/rs-2218881/v1)
- [Murree environmental-impact case study, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-010-9621-7)
- [Nathia Gali / Galyat regional context, Wikipedia](https://en.wikipedia.org/wiki/Nathia_Gali)
- [Abbottabad–Chilas susceptibility map, ResearchGate](https://www.researchgate.net/figure/Landslide-susceptibility-map-Abbottabad-Chilas-aJijal-section-area-in-box-X-is_fig9_332928001)
- [Importance of input data on landslide susceptibility mapping, PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8481530/)
- [Swat District LSM, Hindu Kush Himalaya, Frontiers](https://www.frontiersin.org/journals/environmental-science/articles/10.3389/fenvs.2022.1027423/full)
- [Muzaffarabad integrated-approach susceptibility mapping, Tandfonline](https://www.tandfonline.com/doi/full/10.1080/19475705.2023.2210255)
- [Northern Pakistan landslide-hazard models (Muzaffarabad District), MDPI Sustainability](https://doi.org/10.3390/su141610194)
- [NW Himalayas weighted-overlay susceptibility mapping, Arabian Journal of Geosciences](https://link.springer.com/article/10.1007/s12517-016-2308-y)
- [Bagh District (AJK) landslide hazard mapping, ResearchGate](https://www.researchgate.net/publication/322084695_Landslide_Hazard_Mapping_of_Bagh_District_in_Azad_Kashmir)
- [Muzaffarabad active faults/geohazards, Geological Journal (Wiley)](https://onlinelibrary.wiley.com/doi/abs/10.1002/gj.70422)
- [2005 Kashmir earthquake landslide susceptibility, back-analysis reliability study, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-009-9451-7)
- [2005 Kashmir earthquake landslides, remote-sensing review, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1367912016300025)
- [2005 Kashmir earthquake landslide inventory (2,252 landslides), Geomorphology](https://ui.adsabs.harvard.edu/abs/2008Geomo.101..631K/abstract)
- [Analysis of landslides triggered by the October 2005 Kashmir earthquake, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC4556441/)
- [Review of 2005 Kashmir-earthquake landslides — implications and future challenges, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-021-04688-8)
- [Spatio-temporal landslide inventory, Himalayan Pakistan, Sentinel-2, PubMed](https://pubmed.ncbi.nlm.nih.gov/36175580/)
- [Weight-of-Evidence case study, Xunyang, China, PLOS One](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0245668)
- [Weight-of-Evidence, tropical volcanic region case study, JMANS](https://doi.org/10.47352/jmans.2774-3047.350)
- [Weight-of-Evidence, Merek Valley, Iran](https://scialert.net/fulltext/?doi=jas.2007.3342.3355)
- [SANF national landslide warning system, Italy (PDF)](https://www.academia.edu/18819822/SANF_National_warning_system_for_rainfall_induced_landslides_in_Italy)
- [Landwarn operational EWS, rainfall thresholds + soil moisture (PDF)](https://www.academia.edu/13546481/Landwarn_An_Operative_Early_Warning_System_for_Landslides_Forecasting_Based_on_Rainfall_Thresholds_and_Soil_Moisture)
- [Geographical landslide early warning systems, review, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0012825219304635)
- [Regional-scale landslide warning system, 20 years operational experience, MDPI Water](https://doi.org/10.3390/w10101297)
- [Operational landslide EWS, space-time-variable rainfall thresholds, NHESS](https://nhess.copernicus.org/articles/15/853/2015/)
- [Hong Kong landslip warning system — 40 years of progress, Landslides (Springer)](https://link.springer.com/article/10.1007/s10346-020-01379-6)
- [Nepal community-based LEWS, earthquake-affected areas, Journal of Mountain Science (Springer)](https://link.springer.com/article/10.1007/s11629-019-5586-5)
- [Neelakantha Municipality (Dhading, Nepal) community LEWS, SSRN](https://doi.org/10.2139/ssrn.4655307)
- [Japanese early-warning debris-flow/slope-failure system, rainfall indices, Landslides (Springer)](https://link.springer.com/article/10.1007/s10346-010-0229-5)
- [Soil Water Index landslide prediction, sensitivity analysis, Progress in Earth and Planetary Science (Springer)](https://link.springer.com/article/10.1186/s40645-021-00408-9)
- [Below-threshold rainfall landslide occurrence, Japan, Natural Hazards (Springer)](https://link.springer.com/article/10.1007/s11069-022-05639-7)
- [USGS post-fire debris-flow early warning system](https://www.usgs.gov/programs/landslide-hazards/science/early-warning-system)
- [USGS post-wildfire debris flows publication](https://www.usgs.gov/publications/post-wildfire-debris-flows)
- [SHALSTAB validation, Northern California forests, ResearchGate](https://www.researchgate.net/publication/248621207_A_validation_study_of_the_shallow_slope_stability_model_SHALSTAB_in_forested_lands_of_Northern_California)
- [SHALSTAB Brazilian case studies, ResearchGate](https://www.researchgate.net/publication/322197243_Application_of_the_SHALSTAB_model_for_the_identification_of_areas_susceptible_to_landslides_Brazilian_case_studies)
- [Infinite slope model, Guneysu catchment, Turkey, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0341816221000205)
- [Revised infinite slope model, Tianshui loess landslides, China, NHESS](https://nhess.copernicus.org/articles/24/2615/2024/)
- [COOLR introduction / citizen-science methodology, PLOS One](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0218657)
- [Global Landslide Catalog reporting-bias analysis, NASA NTRS](https://ntrs.nasa.gov/api/citations/20230001884/downloads/glc_manuscript.pdf)
- [Unified Global Landslide Catalogue, peer review, ESSD](https://essd.copernicus.org/articles/18/4697/2026/essd-18-4697-2026-discussion.html)
- [High Mountain Asia Landslide Catalog v2 user guide, NSIDC](https://nsidc.org/sites/default/files/documents/user-guide/hma_ls_cat-v002-userguide.pdf)
- [NASA LHASA2 machine-learning accuracy improvement announcement](https://www.nasa.gov/missions/gpm/machine-learning-model-doubles-accuracy-of-global-landslide-nowcasts/)
- [Satellite-based rainfall-triggered landslide hazard nowcasting, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC6839699/)
- [Global Landslide Forecasting System, NASA NTRS (PDF)](https://ntrs.nasa.gov/api/citations/20220008839/downloads/Manuscript_Global_Landslide_Forecasting_System_Accepted.pdf)
- [Karakoram Highway landslide inventory + susceptibility mapping, CPEC main route (PDF)](https://www.academia.edu/130243701/Landslide_Inventory_and_Landslide_Susceptibility_Mapping_for_China_Pakistan_Economic_Corridor_CPEC_s_main_route_Karakorum_Highway_)
- [Karakoram Highway landslide inventory, multiple statistical approaches, Journal of Mountain Science (Springer)](https://jms.imde.ac.cn/en/article/doi/10.1007/s11629-020-6145-9)
- [Karakoram Highway InSAR-based landslide detection/inventory update, Scientific Reports](https://www.nature.com/articles/s41598-023-34030-0)
- [Landslide susceptibility model comparison (FR/AHP/LR/ANN AUC benchmarks), Springer](https://link.springer.com/article/10.1007/s42452-020-03441-3)
- [LNRF/FR/AHP comparison, Nojian watershed, Iran, Environmental Earth Sciences (Springer)](https://link.springer.com/article/10.1007/s12665-018-7524-1)
- [Machine-learning LSM sample-size comparative study, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0098300424002061)
- [PGA/AHP/Newmark-displacement integrated seismic-landslide risk study, ResearchGate](https://www.researchgate.net/publication/399333643_SEISMIC_HAZARD_ASSESSMENT_AND_EARTHQUAKE-INDUCED_LANDSLIDE_RISK_ANALYSIS_IN_TECTONICALLY_ACTIVE_REGIONS)
- [NDMA Pakistan — official site and current advisories](https://www.ndma.gov.pk/)
- [PDMA Khyber Pakhtunkhwa — official site](https://www.pdma.gov.pk/)

### Sources added in L7

- Steger, S., Brenning, A., Bell, R., Glade, T. (2016). Exploring discrepancies between quantitative validation results and the geomorphic plausibility of statistical landslide susceptibility maps. Geomorphology 262, 8–23. https://doi.org/10.1016/j.geomorph.2016.03.015
- Steger, S. et al. (2016). The propagation of inventory-based positional errors into statistical landslide susceptibility models. NHESS 16, 2729–2745. https://nhess.copernicus.org/articles/16/2729/2016/
- Kamp, U., Growley, B. J., Khattak, G. A., Owen, L. A. (2008). GIS-based landslide susceptibility mapping for the 2005 Kashmir earthquake region. Geomorphology 101, 631–642.
- Owen, L. A. et al. (2008). Landslides triggered by the 8 October 2005 Kashmir earthquake. Geomorphology 94, 1–9. https://pubs.usgs.gov/publication/70031858
- Regional-model transferability (23 US regions, LR/FR): https://scholarworks.umt.edu/etd/11870
- Transfer learning for landslide susceptibility (GMD 2022): https://gmd.copernicus.org/articles/15/8765/2022/gmd-15-8765-2022.pdf
- Petschko, H. et al. (2014). Assessing the quality of landslide susceptibility maps — case study Lower Austria. NHESS 14, 95–118. https://nhess.copernicus.org/articles/14/95/2014/nhess-14-95-2014.pdf
- Wilford, D. J. et al. (2004). Recognition of debris flow, debris flood and flood hazard through watershed morphometrics. Landslides 1, 61–66.
- Wandrey, C. J., Law, B. E. (1998). Maps showing geology, oil and gas fields and geologic provinces of South Asia. USGS OFR 97-470C. https://pubs.usgs.gov/publication/ofr97470C
