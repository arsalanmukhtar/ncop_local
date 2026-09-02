# Landslide Early Warning & Susceptibility — Integration Methodology

Status: **Proposal / phased plan — not yet implemented.** No code changes
were made producing this document; per the explicit instruction this
turn, it is research + planning only. Every reuse claim below was
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

### 3.6 No competing operational system found

A live search for a documented, technical NDMA/PMD landslide
early-warning methodology found only ad-hoc public *alerts* (monsoon
advisories, NEOC bulletins), no published operational ID-threshold or
susceptibility methodology. This is a genuine, confirmed gap — the NCOP
integration would not be duplicating an existing government EWS, it
would be filling a real absence. **TO VERIFY LIVE** if NDMA/PMD have an
internal, non-public system; nothing publicly documented was found.

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
| Geology / lithology | NCOP's `geology` layer — **confirmed live**: GeoServer `geological_global:geology`, polygon, **40 real formation names** keyed by a `name` property (e.g. "Alluvium", "Bedrock", …) | Small — WFS fetch + rasterize (same pattern as flood's own admin-context WFS calls) + a **40-formation → landslide-hazard-class crosswalk**, literature-sourced (candidate source: the confirmed Murree Formation/Kuldana Formation shale-siltstone-sandstone context from §3.3), not invented |
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

## §7. Ground truth — COOLR, confirmed live and directly fetchable

**Confirmed this session, not assumed**: NASA's Cooperative Open Online
Landslide Repository (COOLR) is real, public, and fetchable via standard
ArcGIS REST endpoints — `COOLR_Events_Points`/`COOLR_Reports_Points`
FeatureServer/MapServer layers on `gis.earthdata.nasa.gov` and
`maps.nccs.nasa.gov`. [UN-SPIDER knowledge-portal entry](https://un-spider.org/links-and-resources/data-sources/cooperative-open-online-landslide-repository-coolr-nasa);
[live FeatureServer
endpoint](https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/COOLR_Events_Points/FeatureServer).
Point-based (not raster, unlike GFD) — simplifies
`accuracy_assessment.py`'s own sampling logic rather than complicating
it, since presence points are just the catalog's own coordinates, no
vectorization step needed.

Every existing `accuracy_assessment.py` function
(`compute_auc`/`assess_raster_auc_stable`/
`assess_pooled_multi_raster_auc_stable`/`calibrate_hierarchical_thresholds`)
is confirmed, hazard-agnostic — landslide validation is a matter of
writing a `list_coolr_events`-shaped fetcher mirroring `list_gfd_events`,
not extending the math.

**Same honesty commitment as flood's own AUC work** (which reported
0.614 "poor" and 0.570 "poor" results honestly rather than only
publishing favorable pilots): whatever the real COOLR-validated AUC
turns out to be for the Murree/Galyat pilot, it gets reported as-is.

Pakistan-specific sources (PDMA/NDMA post-disaster reports, the 2010
Attabad/2005 Kashmir-earthquake landslide inventories) remain a real,
likely richer but likely-manual (non-API) secondary source — same
integration-cost expectation the flood work found for UNOSAT/CEMS, not a
live-query one.

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

### L0 — Foundation (Day 1)

Deliberately narrow: everything below is either a decision, a read, or
one small, low-risk, independently-verifiable fetch — no fusion logic,
no AHP weights committed, no endpoint wired yet.

1. **Read the three primary sources in full**, not abstracts — the
   Murree WoE paper, the Astore AHP paper, and the Kashmir Himalaya
   ID-threshold paper (§3.3/§3.5) — to pull their real numeric
   factor-weight/threshold tables before any code assumes a specific
   number. Gates every weight table in L1 below.
2. **Decide the two open Phase L0 questions explicitly, in writing** (a
   one-line note right here is enough — don't leave either implicit):
   - Fix the Overture-style request-coalescing gap in
     `build_hand_pipeline`/`_get_cached_buildings_index` now (§0.1) —
     yes/no, and if yes, before or alongside L1.
   - Check Meteoblue's own account dashboard/API docs for Dataset-API
     coverage under the existing `METEOBLUE_TOKEN` (§3.2.3) — 15
     minutes, not a project; the answer decides which path L4/L1.5's
     Meteoblue work takes.
3. **Pin the pilot catchment's exact bbox** (Murree/Galyat corridor) —
   mirror how each entry in `flood_model.PILOT_CATCHMENTS` is defined
   (bbox + label + flood_type), same shape.
4. **Stand up the skeleton files**, structure only, no logic:
   `landslide_model.py` (mirrors `flood_model.py`) with a
   `PILOT_CATCHMENTS`-equivalent dict holding just the one pilot entry;
   `landslide_ahp.py` (mirrors `flood_ahp.py`) with a module docstring
   and an empty `get_factor_weights` stub only.
5. **First real, testable code**: fetch and rasterize the `geology` and
   `pga_zones` WFS layers for the pilot bbox, for the first time ever —
   the same WFS-fetch pattern `fetch_existing_infrastructure_exposure`
   already uses (§4).
6. **Apply the `/media/` nginx security-header fix** (§12) — decoupled
   from any landslide code, benefits flood's own already-live output
   too, no reason to wait.

**L0 verification**: the geology/PGA rasters visibly carry the real 40
formation names / 5 PGA zones when eyeballed — confirm before moving on,
don't chain L1 onto an unverified fetch. **Stop here until step 1's
numbers are actually in hand** — starting L1 before the literature is
read risks committing a weight table before its own citation is
confirmed, the exact mistake §0 exists to avoid repeating.

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
6. **Write `landslide_ahp.py`'s real `get_factor_weights`** using L0's
   own literature numbers: the Murree-region profile (informed by the
   confirmed WoE factor list, since no Murree-specific AHP table exists
   — §3.3/§3.4), the Astore/high-mountain profile, and a
   Chitral/Reshun-conditioned profile — Saaty CR-validate every profile
   before it ships, the same non-negotiable `flood_ahp.py` already
   enforces.
7. **Build the infinite-slope-with-TWI physically-based layer** (§3.1)
   from the already-computed TWI/curvature output, using the L0
   geology crosswalk to key literature-transferred cohesion/friction-
   angle defaults per formation class — labeled transferred-not-measured
   in whatever surfaces this layer's own provenance, matching the
   rainfall-source-provenance convention (§6) rather than presenting it
   as a precise per-cell measurement.
8. **Combine into `build_landslide_susceptibility_raster()`**
   (`landslide_model.py`) via the AHP weights from step 6.
9. **Classify + vectorize** via `_local_natural_breaks` (adaptive, not a
   single hardcoded breakpoint table — §0.1's MAUP lesson) then
   `_vectorize_ordinal_zones_gapfree` directly (§0.1/§1) — no
   gap-closing iteration expected, unlike flood's own three-round path.

**L1 verification**: run every step above against the pilot catchment's
own real rasters, not a synthetic stand-in (§0.1's testing-discipline
lesson, restated because it's the single most repeated mistake in the
flood build's own history). Confirm zone geometries are gap-free by
comparing `union(all classes)` directly against the true valid-area mask
— never the flawed bounding-box-envelope check §0.1 already caught once.
Visually sane low/medium/high bands following real slope/geology terrain
is a real, if informal, first check before L3's own formal AUC pass.

### L2 — Exposure

Expected to be the smallest phase, by design — the payoff of
`flood_exposure._build_exposure_from_geom` already being geometry-
agnostic (§1/§7 of the flood doc's own §0.24 refactor).

1. Wire `_build_exposure_from_geom` against the landslide
   High-susceptibility zone geometry from L1.
2. Write a thin `build_landslide_exposure_report()` wrapper
   (`landslide_exposure.py` or folded into `landslide_model.py` —
   decide by file size once written, mirroring how flood split
   `flood_exposure.py` out from `flood_model.py` once it grew, not
   before), same shape as `build_exposure_report`.

**L2 verification**: spot-check a handful of the returned
buildings/roads/population numbers against the pilot AOI's known
density by eye — a sanity check, not a formal validation (L3 is where
formal validation happens).

### L3 — Ground-truth validation

Happens **before** any weight-tuning temptation, not after — the
explicit lesson §0/§7 both draw from the flood system's own history.

1. Write `list_coolr_events(bbox)`, mirroring `list_gfd_events`'s own
   shape (§7) — a real fetch against the confirmed live COOLR
   FeatureServer endpoint.
2. Run `assess_raster_auc_stable` for: AHP alone, the AHP+WoE (or
   AHP+FR) ensemble, and the L1 infinite-slope layer, each against the
   pilot catchment's own COOLR points.
3. If L0's Meteoblue Dataset-API check (or the §3.2.3 tile-decode
   pipeline) was built, run the same AUC check against it too, purely
   as a cross-check comparison — not as ground truth (§3.2's own
   standing caveat: LHASA2 is a model, never a substitute for the COOLR
   inventory itself).
4. **Report every number as found.** A "poor" AUC is a valid, expected
   possible outcome, not a failure to hide — the same posture that
   produced flood's own honestly-published 0.614/0.570 "poor" results.
   Do not silently retune L1's weight tables outside their own cited
   literature source to chase a better number; if the literature-sourced
   weights underperform, that itself is the finding to report.

**L3 verification**: a real AUC number, computed against real COOLR
points, on record — this phase's entire output *is* its own
verification.

### L4 — Rainfall-triggered dynamic mode

Built async-job-first from the very first line, per §12's own
production-readiness requirement (this exact bug already happened once
for flood on this exact deployment) — not hardened into that shape
after an initial synchronous version ships.

1. Write `landslide_trigger.py`: `intensity_mm_hr = rainfall_mm /
   duration_hr`, checked against the Kashmir Himalaya
   I=73.90·D^-0.79 curve (§3.5), explicitly labeled as a
   regionally-transferred default.
2. Wire `flood_forecast.py`'s CHIRPS/PMD-Forecast/live-observed
   dispatcher as the rainfall source — inside the job runner, never the
   request handler (§6/§12).
3. Build the decision matrix on the two machine inputs: L1's static
   susceptibility class + the ID-threshold check (§6) — a lookup, not a
   solver.
4. **Optional, does not block this phase's own ship**: if L0's Meteoblue
   check favored it, build `landslide_meteoblue.py` (§3.2.3) and wire
   its output either as a displayed cross-check tile or, if the
   Dataset-API path panned out, as a genuine third input to step 3's
   matrix.
5. Surface rainfall-source provenance in whatever renders this result,
   mirroring `#renderRainfallSourceNoteHTML()` (§6) — never present a
   fetched value as an unambiguous live reading.

**L4 verification**: test against a known historic heavy-rainfall date
for the pilot region and confirm the trigger fires; test against a known
dry period and confirm it correctly does not — a real positive and a
real negative case, not just "it ran without crashing."

### L5 — Production wiring + frontend

Genuinely less net-new work than the seed document originally scoped
(§0.3) — the panel shell and the async-job template both already exist.

1. `POST /api/landslide-model/run/` — its own view, its own
   `_LANDSLIDE_JOB_EXECUTOR` and `_JOBS`-equivalent registry, **not**
   shared with flood's (§9/§12's own explicit decision).
2. Its own status-poll endpoint, mirroring `FloodModelStatusView`.
3. Register its own throttle scopes (`landslide_model_run`,
   `landslide_model_status`, …), sized to each endpoint's real cost the
   same deliberate way flood's own scopes were (§12).
4. `landslide-model-control.js`, populating the already-existing
   `#landslideHazardContent` container — copy `flood-model-control.js`'s
   own async-poll/checklist/accent-color pattern, don't reinvent it
   (§0.3/§9).
5. Re-confirm every item in §12 explicitly at this point: own executor
   in place, every L1-L4 external fetch actually runs inside the job
   pattern (not just L4's rainfall fetch — the L0 geology/PGA fetch and
   L3's COOLR fetch too, if either was ever called synchronously during
   earlier-phase testing), throttle scopes registered.

**L5 verification**: one real, end-to-end run through the *actual*
nginx/Waitress deployment (not just `runserver`) — submit a job, confirm
status polling updates correctly within the 60s-timeout-safe async
pattern, confirm the result renders on the map. This is the first point
in the plan where "does it work in production" is checked directly
against the real stack, not assumed from unit-level testing.

### L6 — Generalization

The same stress test Bhudni Nullah was for the flood AHP work's own
generalization claims — expect, and honestly report, a mix of
confirmed-good and honestly-short-of-target results, not a second
guaranteed success.

1. Pick the second pilot — Hunza-Nagar/Karakoram Highway corridor,
   already the stronger-than-average second-pilot literature base per
   §3.3.
2. Re-run L1's terrain-class selector against this genuinely different
   terrain and confirm it correctly classifies it as a distinct profile
   from Murree/Galyat's.
3. Decide the fusion method for this pilot via §3.4's own
   terrain-conditioned selection logic (likely Frequency-Ratio here,
   per the confirmed Gilgit-Skardu Road AHP-FR study) rather than
   defaulting to whatever Murree used.
4. Re-run L3's full COOLR AUC validation for this second pilot.
5. Publish a combined, honest cross-pilot summary — both numbers, not
   just the better one.

**L6 verification**: two independently COOLR-validated pilots on
record, each with its own real AUC number, reported together.

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
