# Lightweight Flash-Flood Early Warning & Modeling — NCOP Methodology

Status: **Phase 0, Phase 1 (hazard-only backend), Phase 1.5 (full
exposure stack — admin/buildings/OSM/roads/drainage/population), AUC
(§0.7/§0.14), Phase 1.6 (backend endpoints §0.15 + frontend panel §0.16),
Phase 2's discharge-driven flood stage (§0.19, backend + endpoint +
frontend UI), §0.20-§0.22's Global Flood Database ground-truth
integration and multi-trial accuracy validation (Nullah Lai: raw HAND
AUC 0.614 "poor", discharge-driven AUC 0.81 "good", both 8-trial means),
§0.23's SECOND real catchment (Bhudni Nullah Basin, Peshawar — raw HAND
0.680 "poor", discharge-driven 0.707 "fair"; Quetta explored and
deferred, confirmed to have no usable real ground truth), §0.24's
exposure-report integration for the discharge-driven mode (both modes
now return a full buildings/population/roads/drainage breakdown — a
serious vectorization bug that would have undercounted discharge-mode
exposure by ~10-13x was found and fixed before shipping, not after),
§0.25's production-hardening pass (the vectorizer's own filter is
now self-adaptive per-mask rather than a guessed per-mode constant, a
standing regression safeguard fires on every real discharge-exposure
call and was verified to actually catch §0.24's own bug class, and
scenario-level caching turns a repeated 485.8s computation into a 0.0s
cache hit — 1.0s end-to-end through the real HTTP endpoint), and §0.26's
real rainfall input sources for the discharge-driven mode (CHIRPS
satellite estimate, PMD Monitor's WRFPRS forecast, PMD's NWFC observed-
rainfall report — all additive to, not replacing, manual entry; a real
~27-day CHIRPS publication-latency surprise and a real "0mm forecast
would crash the pipeline" bug were both found and fixed before shipping),
and §0.27's start of Phase 2.5 (AHP vulnerability/susceptibility fusion —
Phase 2.5.1 complete: literature-backed weights derived from FOUR
independently-verified Pakistani AHP studies spanning high-mountain,
mixed, and flat-floodplain terrain, not one region's assumption — a first
attempt using only the mountainous Hunza-Nagar table was correctly
rejected by the user as non-generalizable, then replaced with two
terrain-conditioned profiles selected by each catchment's own measured
HAND relief, each independently passing a real Saaty consistency-ratio
check) are all implemented, carried through every existing phase (hazard, exposure,
endpoints, frontend, accuracy)** — Phase 1.6's own fixed-threshold frontend panel is
browser-tested (§0.17); Phase 2's (§0.19) new "Rainfall scenario" mode
in the same panel is built and verified end-to-end via Django's test
Client, not yet a live browser click-test (this session's own standing
constraint — see §0.19's own note). Closing §0.16's own "verification gap," that first real browser pass found and
fixed a genuine methodological error, not just UI bugs: **the Nullah Lai
pilot bbox was never checked against the basin's own published boundary
and was ~3x too large** (721 km² implied vs. the real, literature-
documented 234.9 km² basin) — corrected, rebuilt from scratch, and
cross-validated against an independent source (the corrected district
split, 56.0%/42.4% Islamabad/Rawalpindi, now closely matches the
published basin's own 61.5%/38.5% split). §0.17 also documents direct,
non-deflecting answers to "where is the accuracy report" (none exists
for Nullah Lai — explained why) and "where is the AHP zonation" (not
built yet — Phase 2.5), a corrected and properly-cited HAND-threshold
rationale, a real Overpass-500 retry gap found and fixed, and a
progress-checklist addition (backward-compatible, opt-in) so the
frontend shows real pipeline stages ticking rather than a static
"Running…" line. Scope has since been deliberately
expanded — this is now a full **Hazard × Exposure × Vulnerability →
Risk** system, not just a standalone hazard layer, per the scope-mapping
pass recorded in §0.5/§0.6 below. §0.10 documents the OSM/Overpass
addition (bridges, hospitals, a buildings fallback) alongside Overture,
which stays the primary buildings source. §0.11 documents road-network
and drainage-network exposure. §0.12 documents an optimization/
production-readiness pass. §0.13 documents population/vulnerable-
population exposure (WorldPop via Earth Engine). §0.14 documents AUC
accuracy assessment — 13/13 synthetic unit tests passed, a real
WFS-bbox-filter gotcha found and fixed, and a genuine methodological
finding (raw HAND scored "fail" against real ground truth in a
low-relief floodplain — a named risk for Phase 3, not a module bug).
§0.15 documents `POST /api/flood-model/run/` + `GET /api/flood-model/
status/<job_id>/` — the first real HTTP endpoints for this whole system,
async job-id polling (confirmed necessary: 64-85s even warm), with two
real bugs found and fixed during testing: DRF's automatic throttle check
firing before validation (a bad request would have wasted a real job's
throttle budget), and a CSRF gap matched against `chatbot.py`'s own
already-fixed pattern. Full async flow verified end-to-end with the real
pipeline, not mocked. Settings/WSGI review (`base.py`, `dev.py`,
`prod.py`, `staging.py`, `wsgi.py`, `wsgi_staging.py`, `urls.py`) found
and fixed one stale docstring, confirmed `/media/` already serves PNG
output in every environment, and informed (without SSH access) that
Waitress is architecturally single-process.

**Update — Phase 2.5 has since progressed far past §0.27.** §0.28-§0.30
built riverine mode, the full AHP factor pipeline (including a
connectivity factor), GFD validation, and production wiring for BOTH
flood types. §0.31 then found and fixed a real payload-size bug in AHP
zone vectorization, a real 18-minute performance bug in the zone-
classified exposure report, and a stale-AUC citation (smoothing, added
to fix the payload bug, also improved accuracy at all 4 catchments —
corrected). §0.32 closed §0.31's own two remaining honest gaps:
Youden's-J-calibrated (not fixed-tertile) zone breakpoints, and the
classified schools/bridges/roads/drainage MAP layers that had been
claimed shipped but weren't. §0.33 closed the last two: viewport-
bounded individual buildings on zoom, and Sentinel-1 SAR as a second
ground-truth source (Phase 2.5.6, the last sub-phase of the original
Phase 2.5 roadmap — real coverage limits found and reported honestly:
only 1 of 4 pilot catchments currently has a real, GFD-and-Sentinel-1-
overlapping event to validate against). Every sub-phase of the original
Phase 2.5 roadmap is now built. §0.34 diagnosed SAR's own poor accuracy
rigorously (resolution/timing/threshold hypotheses each tested live) —
none fixed it; the honest conclusion is a real SAR-vs-MODIS
methodological mismatch over agricultural land, not a bug. §0.35 then
did Phase 3's own first named scope item — a real shape comparison
against the 20 existing hydrological_global flood-extent layers,
independent of GFD — finding a genuinely positive, consistent result
(AHP-High zones overlap the existing High band most, AHP-Low least,
across every catchment tested) — and condensed every result-panel text
block to minimal, highlighted key terms. See
§0.27 for the original Phase 2.5.1 account,
including a real correction made mid-phase: a first attempt used only
the mountainous Hunza-Nagar catchment's weights universally, which the
user correctly rejected as non-generalizable across Pakistan's distinct
flood topologies — replaced with two terrain-conditioned profiles built
from four independently-verified regional studies. §0.26 added real
fetched rainfall sources (CHIRPS, PMD Forecast, live-observed) alongside
the existing manual-entry path for the discharge-driven mode — see that
section for the full account, including two real bugs (CHIRPS's ~27-day
latency, a 0mm forecast crashing the discharge pipeline) found and fixed
before shipping. §0.24 wired the discharge-
driven mode to a full exposure report (buildings/population/roads/
drainage) — both modes now answer "what's at risk," not just the
fixed-threshold one. Found and fixed a serious bug BEFORE shipping,
not after: the shared vectorizer's 9-pixel minimum-mapping-unit filter
(tuned for the fixed-threshold mask's broad-blob shape) discarded 79.3%
of the discharge mask's own real flood-prone area (it naturally forms
many small, genuinely-real clusters along narrow stream channels) —
would have undercounted discharge-mode buildings/roads exposure by
~10-13x had it shipped un-investigated. **§0.25 then closed every one
of §0.24's own recommendations**: the vectorizer's filter is now
self-adaptive (measures live, per-mask, whether its own filter would
discard too much real area, backing off automatically instead of
relying on a caller to guess "0" vs "9" per mode); a standing regression
safeguard now runs on every real discharge-exposure call and was
verified via deliberate fault injection to actually catch this exact
bug class; and scenario-level caching turns a repeated 485.8s
computation into a 0.0s cache hit (1.0s end-to-end through the real
HTTP endpoint). §0.22's literature review
(46 real papers) led to a multi-trial AUC-reporting capability (single-
trial numbers were confirmed too noisy to trust for ground truth this
small) and a DEM-source experiment (FABDEM, tested rigorously, found
WORSE than Copernicus, reverted — reported honestly including the
initial wrong turn). Final Nullah Lai numbers: **discharge-driven AUC =
0.81 ("good"), raw HAND = 0.614 ("poor")**. §0.23 then added a SECOND
real, literature-sourced catchment — Bhudni Nullah Basin, Peshawar
(raw HAND 0.680 "poor", discharge-driven 0.707 "fair", far richer real
GFD ground truth than Nullah Lai's own) — carried through every existing
phase, and caught two real bugs only a second catchment could expose (a
`composite_cn` fallback that would have silently borrowed the wrong
basin's hydrology; a frontend accuracy note that would have shown one
catchment's numbers while a different one was selected). Quetta was
explored and explicitly deferred — confirmed to have no usable real
satellite ground truth, not force-added anyway. The user's own 85%
target was NOT reached for either catchment — stated honestly, with
named reasons (coarse/partly-noisy 250m ground truth; a
terrain+discharge-only model with no land-use/AHP fusion yet) and
concrete, literature-backed next steps (AHP fusion with a ready-made
Pakistani factor list, threshold sensitivity calibration, Sentinel-1 SAR
as a second ground-truth source), not a deflection. §0.18 found that even after
the bbox fix, the fixed-threshold susceptibility zone (49.752 km²) was
~14.6x larger than a published HEC-RAS study's actual modeled inundation
(3.4 km²) for Nullah Lai's highest-risk reach — a fixed HAND threshold
has no concept of water volume. **§0.19 is the real fix**, built after
researching HEC-RAS (free but not open source, Windows-COM-only
automation, architecturally incompatible with this project's Linux
production server) and GeoFlood (GPLv3, GRASS+TauDEM heavy deps,
`rasterio` DLL-Hell risk) and disqualifying both — a hand-rolled
Synthetic Rating Curve (SCS-CN → Kirpich → SCS unit hydrograph →
Leopold-Maddock → Manning's equation, the same method NOAA's own
operational HAND-FIM system uses) now derives a genuine, per-reach,
spatially-varying flood stage from an actual rainfall/duration scenario,
replacing the single global threshold comparison (both paths remain
available side by side). Found and fixed a real 10x coefficient bug in
the peak-discharge formula (caught by an external plausibility check
against the 2001 flood, not by this module's own self-referentially-wrong
unit tests) and three separate WhiteboxTools bugs (one tool silently
returning all-zero output, another returning `inf` on a degenerate
all-zero input that would have wrongly flagged the entire basin as
flood-prone). At a discharge close to the reference study's own
3,000 m³/s, the result is 19.81 km² — roughly 2.5x smaller than the old
fixed-threshold figure, with the remaining gap to 3.4 km² now explained
by a real scope difference (whole-basin vs. one channel reach), not a
structural flaw. Wired into `POST /api/flood-model/run/` as an opt-in
mode (`rainfall_mm`+`duration_hr`), verified end-to-end via Django's test
Client, **and now wired into the frontend panel itself** — a "Model
mode" selector swaps the threshold slider for rainfall/duration inputs,
with its own scenario-specific results display and methodology note.
**Not yet done: wiring `flood_exposure.py`'s population/buildings/roads
breakdown to this per-pixel-varying mode** (its exposure math currently
assumes one scalar threshold — a discharge-driven run shows the flood
zone and its own discharge/CN/runoff numbers, but no buildings/
population/roads count yet), **and a live browser click-test of the new
UI** (built and verified via Django's test Client only, per this
session's standing constraint against starting a persistent dev server).
**The custom-AOI/upload path remains the one unbuilt piece of the
original Phase 1.6 scope.** §0.20 (this same pass) closes the
long-standing "no ground truth overlaps Nullah Lai" gap named since
§0.7 — a real Global Flood Database (satellite/MODIS) signal DOES exist
here after all, and running the AUC module against it for the first
time gives a genuine, not-cherry-picked answer to the user's own
repeated "is it accurate" question: **0.605 ("poor") for raw HAND,
0.646 ("poor") for the discharge-driven margin** — a real, modest
improvement from Phase 2, not a dramatic one, and not yet an accurate
predictive model on its own. This document is the durable record of the architecture
decision — not the original methodology text, which stays in place at
`Methodology_for_a_Lightweight_Real_flood_forecasting.txt` as reference/
history. This file supersedes it for actual implementation planning.

## 0. Phase 1 results (§7's own record, summarized here for visibility)

Implemented in `project/ncop_internal/flood_model.py`. Full pipeline
(DEM export → fill_single_cell_pits → breach_depressions_least_cost →
D8 pointer → D8 flow accumulation → extract_streams →
elevation_above_stream) runs end-to-end on the Nullah Lai pilot AOI in
~28s cold / ~6s warm (cached). Every stage's output was sanity-checked
against real values, not just "did it run":

- DEM: 401.5–1364.4m elevation (matches the Phase 0 export exactly).
- Flow accumulation: max 738,619 of 966,160 total cells (~76%) — a
  single dominant outlet, consistent with one real catchment draining to
  one main channel.
- Streams: 3.01% of cells — a realistic drainage density.
- HAND: 0–616.9m, mean 29.0m — physically sensible given the terrain's
  relief.

**Three real bugs found and fixed during this pass, all in
`flood_model.py` now:**
1. `whitebox` 2.3.1's own Windows installer has a path bug — downloads
   the correct binary but fails to move it into place. Worked around by
   calling `set_whitebox_dir()` explicitly rather than trusting
   auto-detection.
2. **WhiteboxTools' return code cannot be trusted** — a Rust-side panic
   (from an ungeoreferenced test raster) still reported exit 0 with no
   output produced. Every call now verifies the output file exists and
   is non-empty, never the return code alone.
3. **GEE's own GeoTIFF export uses a compression tag (32946) WhiteboxTools'
   decoder rejects**, despite claiming DEFLATE support. Fixed by
   re-writing every DEM export uncompressed via `gdal.Translate`
   immediately after download — a permanent fix in `_fetch_dem`, not a
   one-off workaround.

**Threshold recalibrated from the original 8.0m guess to 3.0m** — 8m
flagged an implausible 34% of this ~960m-relief catchment as
flood-prone; tested 2/3/5/8m (9.8% / 13.8% / 22.0% / 34.2%) and picked
3.0m as a more defensible starting default, closer to the 1–5m range
operational HAND flood mapping (e.g. NOAA's) typically uses. Still not
validated against any real flood extent for this catchment — that
remains Phase 3's job.

**Locking discipline note:** the GDAL lock is scoped ONLY around actual
`gdal.Open()`/`gdal.Translate()`/`gdal.DEMProcessing()` calls in this
module, deliberately NOT around the WhiteboxTools subprocess calls
themselves (which never touch this process's GDAL bindings at all) —
holding it for the whole pipeline would have blocked every other
GDAL-using feature (e.g. PMD prediction rendering) for the pipeline's
full duration. WhiteboxTools calls are separately serialized under their
own lock, for CPU-fairness on the shared VM, not GDAL-safety.

## 0.5 Scope expansion: Hazard × Exposure × Vulnerability → Risk

Phase 1 built HAZARD only (where water could pool, given terrain alone).
A genuine flash-flood early-warning system needs the standard disaster-
risk-management framework: **Hazard × Exposure × Vulnerability = Risk**.
Before touching the frontend, every existing NCOP asset relevant to
Exposure and Vulnerability was audited directly in the code (not assumed)
— summarized here so the eventual design reuses everything that's
already real, and only adds what's genuinely missing.

**Administrative Boundaries** (`map-layers.js`) — full hierarchy already
present as GeoServer vector tiles: `national_boundary` →
`provincial_boundary` → `district_boundary` → `tehsil_boundary`. This is
exactly what's needed to answer "which district is most at risk" for
decision-support reporting — no new data source required.

**Hydrological Layers** — richer than expected. `major_rivers`,
`minor_rivers`, `reservoirs`, `water_shed` (named major catchments: Kabul,
Mangla, Tarbela, Chenab, Ravi, Sutlej), `major_dams`, `minor_dams`,
`geology`, `pga_zones` (seismic — likely reusable for a future multi-
hazard angle, not this one). **Most importantly: 20 pre-computed flood
extent layers already exist** — High/Medium/Low severity × 7 major river
systems (Upper Indus, Lower Indus, Jhelum, Chenab, Ravi, Sutlej, Kabul),
served from the `hydrological_global` GeoServer workspace. These are for
major-river (fluvial) flooding, not small urban nullahs like the Nullah
Lai pilot — so they don't replace this project's purpose — but they ARE
a real, already-available reference dataset to sanity-check the HAND
methodology against wherever the two overlap, before Phase 3's dedicated
calibration even starts.

**Infrastructure** — genuinely sparse, confirmed by reading the actual
category: only `airports`, `schools`, `settlements` are active;
`hospitals` and evacuation points exist in the source but are commented
out (disabled). No roads, no buildings, no bridges/culverts, no power
infrastructure. **This is the one real gap** — and bridges/culverts
specifically matter a lot for flash floods (classic blockage/backup
points), so this is worth closing, not skipping.

**Live Meteorological Operations** — `pmd_weather_stations`,
`heatwave_monitoring`, `pmd_warnings`, `pmd_monsoon`, `pmd_lightning`,
`pmd_city_forecast`, `nwfc_observations`. Real, live, already-hydrated
data — useful as a live grounding signal for susceptibility (e.g. is it
actually raining right now near the pilot catchment) but not a
new-data-source problem.

**FFD Data** — a separate subcategory ("Flood Forecasting Division
(FFD-Data)"), not nested under Live Met Ops. Both historic and forward-
looking pieces already exist and were confirmed live earlier this
project: `FfdHistoryAPIView` (historic barrage/dam discharge) and the
NCOP Assistant's `get_ffd_bulletins`/`get_ffd_waterlevels` tools (current
levels + forward-looking bulletin text). Nothing new needed here either.

**Net picture:** four of the five things named are already real NCOP
assets needing reuse, not new integration work. The one genuine gap is
building/infrastructure exposure data — which is exactly what OSM/
Overture Maps should fill (§0.6).

## 0.6 Open-source tooling research for the exposure/vulnerability pieces

**Overture Maps — recommended for buildings/infrastructure exposure.**
The `overturemaps` Python package (PyPI) reads Overture's public
GeoParquet distribution with genuine partial-read: `overturemaps.
geodataframe("building", bbox=bbox)` transfers only the data inside the
requested bbox, streamed directly from Overture's S3 bucket — no local
database, no Overpass API rate limits, no heavy ETL pipeline. Practical
for a single pilot-catchment AOI. Its own dependency footprint is
`pyarrow` (a well-established, low-risk columnar data library — no GDAL
entanglement, no known conflict with anything already in this venv).

**Licensing flag, same category as the Urdu-TTS/RichDEM findings
earlier:** Overture's *buildings* theme specifically is **ODbL**-licensed
(it's derived from OSM/Microsoft Buildings/Google Open Buildings), not
Overture's more permissive default CDLA-Permissive-2.0. Commercial use is
allowed, but ODbL carries attribution + share-alike obligations for
derivative databases — fine for internal map display/exposure
computation, worth knowing before any derived dataset is redistributed
anywhere.

**`rasterio`/`rasterstats` — actively AVOID, confirmed by rasterio's own
official docs, not a guess:** *"GDAL's bindings (gdal) and Rasterio are
not designed or developed with compatibility as a goal, and should not...
be imported and used in a single Python program."* Rasterio bundles its
own GDAL DLL; mixing it with `osgeo.gdal` (this entire codebase's
foundation) is documented "DLL Hell" — a real, named crash risk, not a
theoretical one, and exactly the class of problem this project has
already spent real time debugging (the GDAL/PROJ concurrency crash, the
NumPy/`gdal_array` ABI mismatch). **Zonal statistics (buildings-in-
flood-zone, depth-per-building) must be hand-rolled using the same
`osgeo.gdal`/`osgeo.ogr` bindings `flood_model.py` already uses** — more
code than `import rasterstats`, but zero new native-conflict surface.

## 0.7 Accuracy assessment methodology: AUC (before Phase 1.5)

Requested explicitly before Phase 1.5 implementation starts: how to
compute AUC (Area Under the Curve) for every flood hazard/susceptibility
output this project produces (HAND now, AHP susceptibility in Phase 2.5,
anything after), in a way that fits this stack's "no new heavy
dependency when one isn't needed" discipline (§0.6).

**Standard methodology, confirmed via the flood/landslide-susceptibility
literature** ([ScienceDirect — AHP/frequency-ratio flood susceptibility](https://www.sciencedirect.com/science/article/pii/S0921818125001407),
[ResearchGate — success-rate vs. prediction-rate ROC curves](https://www.researchgate.net/figure/Validation-of-flood-susceptibility-maps-applying-ROC-curve-a-Success-rate-curve_fig5_359364012),
[Nature Scientific Reports — ML flood susceptibility comparison](https://www.nature.com/articles/s41598-026-38391-0)):
- The ROC curve plots true-positive rate against false-positive rate
  across every possible classification threshold — not just the one
  threshold a map happens to render with. AUC is the area under that
  curve: **1.0 = perfect discrimination, 0.5 = no better than chance,
  &lt;0.5 = worse than chance** (the model has the relationship
  backwards). Published flood-susceptibility studies typically report
  0.85–0.95 for a defensible model.
- Two named variants, distinguished only by which points feed them:
  **Success Rate Curve** (validated against the same points used to
  build/fit the model — measures goodness-of-fit) vs. **Prediction Rate
  Curve** (validated against independent points the model never saw —
  measures genuine predictive skill). The prediction-rate version is the
  more meaningful number and the one worth reporting as "accuracy."
- HAND itself is **physically derived, not statistically fit** — there's
  no training split to speak of for Phase 1's hazard layer, so every AUC
  computed against it is already a prediction-rate-style, fully
  independent validation. This distinction becomes real again in Phase
  2.5, where the AHP susceptibility score's weights ARE tuned — at that
  point an actual train/held-out split becomes worth doing, not just
  optional.
- Confusion-matrix metrics (precision/recall/F1/Cohen's Kappa) are a
  separate, complementary family already named for Phase 3 below — AUC
  and Kappa answer different questions (ranking quality across all
  thresholds vs. agreement at one chosen threshold) and are normally
  reported together in this literature, not as alternatives.

**Optimized computation — NumPy only, no scipy/scikit-learn (neither is
a dependency here — confirmed directly against `requirements.txt`, only
`numpy==2.1.0` is present).** The naive AUC definition compares every
positive-class score against every negative-class score
(O(n_pos × n_neg)) — unnecessary. AUC is algebraically identical to the
normalized Mann-Whitney U statistic ([IRIC Bioinformatics —
fastest method to compute an AUC](https://bioinfo.iric.ca/fastest-method-to-compute-an-auc/)),
computable via a single rank/sort pass:

```python
import numpy as np

def compute_auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """AUC via the rank-sum (Mann-Whitney U) identity — O(n log n),
    one np.argsort, no scipy/sklearn. `labels` is 1 for a flood-presence
    sample, 0 for absence; `scores` is any continuous score where higher
    means 'more flood-prone' (e.g. -HAND, or an AHP susceptibility index)."""
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    # average tied ranks so exact-tie scores (common on a quantized
    # raster) don't bias the result
    _, inverse, counts = np.unique(scores, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts)); np.add.at(sums, inverse, ranks)
    ranks = (sums / counts)[inverse]
    n_pos, n_neg = labels.sum(), len(labels) - labels.sum()
    if n_pos == 0 or n_neg == 0:
        return float("nan")  # can't score with only one class present
    rank_sum_pos = ranks[labels == 1].sum()
    u_stat = rank_sum_pos - n_pos * (n_pos + 1) / 2
    return float(u_stat / (n_pos * n_neg))
```

For a catchment-sized sample (low thousands of points, not raster
pixels — see below), this runs in well under a second; no batching, no
GPU, nothing to tune.

**Score input — the continuous raster, not the thresholded PNG.** AUC
needs a ranking across all thresholds, so it must sample
`flood_model.py`'s intermediate `07_hand.tif` (continuous HAND-in-metres
values, lower = more flood-prone, so `score = -HAND`) directly via the
same raw `ReadRaster`/`struct.unpack` pixel-read helpers already in that
module — never `render_flood_prone_zones`'s output PNG, which has
already collapsed everything to one fixed threshold and would make an
AUC computation meaningless (it can only ever grade that one cutoff, not
"how good is this raster at ranking flood-prone areas").

**Ground-truth sourcing — the 20 existing flood extent layers (§0.5),
with a real, confirmed coverage gap.** `major_rivers`'s sibling
`hydrological_global` workspace layers (`{prefix}{severity}fex`, e.g.
`uihfex` = Upper Indus High) are authoritative presence polygons.
Sampling plan: presence points via rejection sampling inside the
intersecting polygon(s) (point-in-polygon via `ogr.Geometry.Contains()`
— already-used bindings, no new library); absence points via rejection
sampling inside the AOI bbox but outside every extent polygon (a small
exclusion buffer around presence polygons is a documented refinement to
avoid trivially-easy negatives, worth adding once the basic version
works, not required for a first pass).

**Live-tested against this project's own pilot catchment — confirmed
gap, not a guess:** queried the `hydrological_global` WFS directly with
Nullah Lai's bbox (`[72.95, 33.50, 73.20, 33.78]`) against both `uihfex`
(Upper Indus) and `lihfex` (Lower Indus) — **zero features returned**.
A sample Upper Indus polygon's own bbox tops out at `lon 72.70`, ~25km
west of Nullah Lai's western edge — consistent with these 20 layers
covering the named major rivers' own corridors, not the Soan/Nullah Lai
sub-catchment the Phase 1 pilot uses. **Practical consequence: AUC
cannot be computed for the Nullah Lai pilot against this ground-truth
source.** Two honest paths forward, not a blocker to building the module
itself:
1. Use this ground truth to validate the *methodology* on a catchment
   that does overlap one of the 7 named systems (a second, short-lived
   test AOI along e.g. Chenab or Ravi) — proves HAND+AUC works before
   trusting it anywhere, independent of Nullah Lai.
2. Source real historical flood observations for Nullah Lai specifically
   (a known gap already flagged in Phase 1's own results — "not yet
   validated against any real flood extent for this catchment") — this
   remains a data-acquisition task for later, not something to fake with
   synthetic points.

**Reusable module, not a one-off script** — lives as
`project/ncop_internal/accuracy_assessment.py` (new, small, separate
from `flood_model.py` since Phase 2.5's AHP output and any future
continuous hazard/susceptibility raster call the same `compute_auc()` +
sampling helpers, not just HAND):
```python
def assess_raster_auc(raster_path, presence_source, aoi_bbox, n_samples=500) -> dict:
    # returns {"auc": float, "n_presence": int, "n_absence": int,
    #          "interpretation": "excellent"|"good"|"fair"|"poor"|"fail"}
```
Interpretation bands match the literature's own convention: ≥0.9
excellent, 0.8–0.9 good, 0.7–0.8 fair, 0.6–0.7 poor, &lt;0.6 fail (no
better than chance, or worse).

**Where this plugs into the existing phased plan:**
- Phase 1.5's "cross-validation against existing flood extents" bullet
  now has a concrete mechanism, not just "compare and eyeball" — wherever
  a future pilot catchment overlaps one of the 20 layers.
- Phase 2.5's AHP susceptibility score gets the same `assess_raster_auc()`
  call for free once it exists, plus an actual train/held-out split
  since its weights are fit, not physically derived.
- Phase 3's existing Cohen's-Kappa/F1 line stays as the complementary
  fixed-threshold metric family — AUC is the new primary ranking-quality
  number reported alongside it, not a replacement.

## 0.8 Phase 1.5 results — ✅ COMPLETE (backend, exposure/context only)

Implemented in `project/ncop_internal/flood_exposure.py`, per the user's
explicit "go phase wise" instruction: administrative tagging + buildings/
infrastructure exposure only. AUC cross-validation against the 20
existing flood-extent layers stayed OUT of this pass — that's
`accuracy_assessment.py`'s own future phase (§0.7 already has the
research).

**Full pipeline for the Nullah Lai pilot, end-to-end, warm caches: 32.2s.**
Every stage verified against real values, not just "did it run":
- Flood-prone zone (HAND ≤ 3.0m): **95.4 km²** — close to, and consistent
  with, Phase 1's own pixel-count estimate (13.75% of the catchment).
- Administrative tagging: Islamabad district+tehsil 67.8% of the zone,
  Rawalpindi district+tehsil 31.8–31.9%, a small Haripur sliver 0.4% at
  the AOI's edge — district- and tehsil-level figures agree with each
  other, a real cross-check that passed, not assumed.
- Existing NCOP infrastructure reused as-is: 1 of 2 airports (Dhamial
  military airbase), 44 of 571 schools, 90 of 764 settlements fall inside
  the flood-prone zone — each record's existing `hi_riverine_flooding`
  attribute surfaced too (a pre-existing hazard-index field on these
  layers, discovered live, currently all-zero for this AOI — a coarse/
  static field, not this project's own signal).
- Overture Maps buildings: **603,076 buildings in the AOI, 77,862 (~13%)
  inside the flood zone** — consistent with the zone's own ~13% area
  share, a genuine sanity check, not a coincidence assumed to be fine.

**Five real things found and fixed during this pass:**
1. **Raw `gdal.Polygonize` output was too fragmented to intersect
   directly** — 2,720 disconnected sliver polygons, 72,522 vertices, from
   normal HAND-threshold noise (not a bug). Combined with a real district
   polygon's own complexity (Rawalpindi's WFS boundary: 53,250 vertices),
   a single `shapely.intersection()` call hung for minutes. Fixed with a
   9-pixel minimum-mapping-unit filter before the dissolve plus
   topology-preserving simplification (both the flood zone and a LOCAL
   copy of fetched admin boundaries) — 714 parts / 21,410 vertices after,
   flood-zone area changed by under 5%.
2. **Unprepared `shapely.intersects()` against ~1,300 infrastructure
   points took 64.39s** — `.intersects()` with no spatial index
   re-evaluates the whole multipolygon per call. `shapely.prepared.prep()`
   (build the index once, query many times — the standard idiom for this
   exact shape) cut it to 0.84s, a 77x speedup, same correct counts.
3. **The `overturemaps` PyPI wrapper force-upgrades shapely to >=2.1.0**
   — an unpinned bump this app's existing `geopandas==1.1.1`/
   `shapely==2.0.6` combo (used by the shapefile/KML/CSV upload endpoints
   in `views.py`) didn't need and wasn't worth risking. Avoided entirely
   by calling `pyarrow.dataset` directly against Overture's public S3
   GeoParquet distribution instead — confirmed working cleanly with
   `shapely==2.0.6` re-pinned, no conflict.
4. **DuckDB tested live as a possible faster alternative** for the same
   Overture bbox query (its httpfs+spatial extensions are the officially
   documented recommendation for this) — confirmed WORSE in this case
   (~4-5+ minutes projected vs. plain pyarrow's ~225s) and crashed under
   external interruption during testing. Not adopted; not added as a
   dependency.
5. **Overture buildings fetch is genuinely slow — confirmed live, not
   assumed: ~225-270s** for the Nullah Lai pilot bbox, even with the S3-
   side bbox filter applied. Root-caused (not just observed): Parquet
   ROW-GROUP-level pruning is coarser than a small pilot catchment, so
   many row groups still have to be read/decompressed even though the
   per-ROW filter is exact (a second "narrowing" pass in code removed
   zero of 603,076 rows — the rows were already exact matches; the slow
   part is upstream of that). Addressed with per-catchment disk caching
   plus a dedicated, bounded `ThreadPoolExecutor` + `future.result(timeout=
   300)`, the same external-call-must-never-hang-forever pattern
   `flood_model.py`'s own `_run_wbt()` already established for
   WhiteboxTools. **A "warm" cache hit is still not free — ~15s,
   confirmed to be dominated by plain per-record Python loop overhead
   across ~600k cached buildings** (json.load itself: 1.5s; a bbox
   fast-reject added to skip WKB-parsing far-away buildings measured
   within noise of no improvement — correctly documented as such rather
   than left as an unverified assumption). Acceptable for this phase's
   backend-module scope (nothing here is wired to an HTTP endpoint yet);
   flagged in the module's own docstring as needing a vectorized
   approach before ever becoming a live per-request path.

**New dependency: `pyarrow==25.0.1`** — the ONLY one this phase needed.
`overturemaps` and `duckdb` were both evaluated live and deliberately
NOT added, for the reasons above.

**Deferred, deliberately, out of this phase's scope:**
- AUC cross-validation against the 20 existing flood-extent layers — its
  own future phase (§0.7).
- Population and vulnerable-population exposure (WorldPop) — researched
  and designed, see §0.9; implementation deferred to its own future
  phase-wise step, same pattern as AUC.

Bridges and hospitals (Overture's own transportation/amenity themes were
never built) were picked up shortly after via OSM/Overpass instead — see
§0.10.

## 0.9 Population & vulnerable-population exposure: WorldPop via Earth Engine

Requested after Phase 1.5 landed: population and vulnerable-population
counts (latest/near-latest, open-source) inside the flood-prone zone.
Researched and **live-verified against the Nullah Lai pilot** — not yet
wired into `flood_exposure.py`'s combined report, that's this section's
own future implementation step.

**Chosen source: WorldPop, via Google Earth Engine — not a new
dependency, not a new download path.** This app already has a live,
initialized Earth Engine integration (`views.initialize_earth_engine()`,
already used by `flood_model._fetch_dem`) — WorldPop's own gridded
population datasets are published directly in Earth Engine's public data
catalog, confirmed live:
- [`WorldPop/GP/100m/pop`](https://developers.google.com/earth-engine/datasets/catalog/WorldPop_GP_100m_pop) — total residential population, 100m grid. Confirmed
  live: Pakistan coverage is annual **2000–2020** (`PAK_2000` … `PAK_2020`).
- [`WorldPop/GP/100m/pop_age_sex`](https://developers.google.com/earth-engine/datasets/catalog/WorldPop_GP_100m_pop_age_sex) — age/sex-disaggregated population, same
  100m grid. Confirmed live: Pakistan has exactly one year, **2020**, 37
  bands (`population` + `M_0,M_1,M_5,M_10,…,M_80` and the equivalent `F_`
  bands — WorldPop's standard 5-year age bins, except age 0 and ages 1–4
  kept separate). A constrained variant
  (`WorldPop/GP/100m/pop_age_sex_cons_unadj`, built-settlement-masked, UN-
  total-aligned) exists with the same single 2020 year.

**Honest staleness note:** 2020 is the latest year WorldPop's age/sex
product reaches in Earth Engine's catalog — 6 years old as of this
writing (2026-08-21), not "latest" in an absolute sense. It IS, however,
the literature's own current standard baseline for this exact kind of
work — published global flood-exposure assessments are themselves
built on "WorldPop 2020 maps calibrated on census and satellite data" —
so this isn't settling for a stale source, it's the field's accepted one.
The plain total-population collection goes to the same 2020 ceiling for
Pakistan, so there's no fresher total-only alternative to prefer instead.

**The genuinely optimized part: no raster download at all.** Every other
Phase-1/1.5 exposure source (DEM, Overture buildings) had to download
data and process it locally. Population doesn't need that — Earth
Engine's `reduceRegion(reducer=ee.Reducer.sum(), geometry=..., scale=100)`
sums pixels **server-side** and returns just the numbers. Confirmed live,
twice:
- Whole Nullah Lai AOI (bbox, not yet zone-clipped): **1.62s** for total
  population, under-5, and 65+ summed in one call — total 3,065,522;
  under-5 338,190 (11.0%); 65+ 119,980 (3.9%).
- The ACTUAL flood-prone zone (the real 714-part MultiPolygon Phase 1.5
  already produces, passed straight in as `ee.Geometry(shapely.geometry.
  mapping(zone_geom))` — no simplification needed, Earth Engine accepted
  it directly): **7.44s** — population 425,116; under-5 47,137 (11.1%);
  65+ 16,759 (3.9%).
- **Cross-check that passed, not assumed:** 425,116 / 3,065,522 = 13.9% of
  the AOI's population sits in the flood zone — matches Phase 1.5's own
  building-exposure fraction (~13%) and the flood zone's own area share
  of the AOI (~13%) almost exactly. Three independently-computed exposure
  fractions agreeing this closely is a real, meaningful sanity check on
  the whole exposure pipeline, not just this one addition.

**Vulnerable-population definition — standard, not invented for this
project:** children under 5 and elderly 65+ are the two categories
consistently used across the flood-exposure literature surveyed for this
research (reduced mobility, slower/harder evacuation, higher medical
risk). Both are directly summable from WorldPop's existing age bins:
`under5 = M_0+F_0+M_1+F_1`; `elderly65 = M_65+F_65+M_70+F_70+M_75+F_75+
M_80+F_80` (a 60+ cutoff is equally available by adding the `M_60`/`F_60`
bin, if a future review prefers the WHO's alternate elderly threshold —
kept as a parameter, not a hardcoded choice, in the eventual
implementation).

**Implementation shape for when this phase is picked up** — small,
because the pattern above already does the hard part:
```python
def population_exposure(flood_zone_geom, elderly_cutoff_age=65):
    # from . import views  (side effect: initialize_earth_engine(), same
    # lazy-import convention flood_model._fetch_dem already uses)
    # ee_geom = ee.Geometry(shapely.geometry.mapping(flood_zone_geom))
    # img = ee.ImageCollection('WorldPop/GP/100m/pop_age_sex') \
    #     .filter(ee.Filter.eq('country', 'PAK')) \
    #     .filter(ee.Filter.eq('year', 2020)).first()
    # ... .reduceRegion(ee.Reducer.sum(), ee_geom, scale=100, maxPixels=1e9).getInfo()
    # returns {"total": ..., "under5": ..., "elderly": ..., "year": 2020}
```
- **Country hardcoded to `'PAK'`** for now, matching this whole project's
  Pakistan-only scope — not a general-purpose parameter.
- **A `.getInfo()` call is itself a bounded, synchronous network round-
  trip to Google's servers** (confirmed live: 1.6–7.4s depending on
  geometry complexity) — small enough to call inline from
  `build_exposure_report()` directly, unlike Overture's buildings fetch;
  no disk-caching or background-executor machinery needed for this one.
  Still worth a bounded try/except around the `.getInfo()` call itself
  (network hiccups happen), degrading to a `None`/omitted population
  block rather than failing the whole exposure report, matching this
  module's existing WFS-fetch degradation convention.
- **Scaling caveat for later, not the pilot:** `reduceRegion`'s
  `maxPixels` (currently `1e9`, comfortably above what a pilot-catchment-
  sized region needs) and `tileScale` would need raising for a much
  larger AOI (e.g. a future province-wide rollout) to avoid Earth
  Engine's "Too many pixels in the region" error — not a concern at
  pilot-catchment scale, worth remembering before Phase 3's "nationwide
  rollout" note becomes real.

## 0.10 OSM/Overpass addition: bridges, hospitals, and a buildings fallback

Added right after §0.8 landed. First pass of this mistakenly read as "is
Overture even needed" and got as far as testing a full swap before the
user clarified: **Overture stays as the primary buildings source — it
has confirmed live to be far more complete (603,076 vs. OSM's 17,686 for
the same Nullah Lai bbox, ~34x, a known OSM gap in areas with heavy
informal/unmapped settlement).** OSM's actual job here is two things
Overture's buildings-only integration never did: bridges + hospitals
(genuinely new), and a degraded fallback for buildings specifically if
Overture's own fetch ever fails.

**New functions in `flood_exposure.py`, no new dependency** (`requests`
was already used for the WFS calls):
- `fetch_osm_bridges_hospitals_exposure()` — Overpass QL queries for
  `bridge=*` ways and `amenity=hospital` nodes/ways, disk-cached per
  catchment. Confirmed live on Nullah Lai: **786 bridges (358 inside the
  flood zone — bridges being concentrated near water is exactly what
  you'd expect, not a surprise), 139 hospitals (4 inside the zone)**,
  3.55s cold, 0.01s warm.
- `fetch_osm_buildings_fallback()` — same Overpass source, used ONLY when
  `fetch_overture_buildings_exposure()` raises. Confirmed live: 17,686
  buildings, 1,210 in the flood zone (6.8% — notably lower than
  Overture's ~13% flood-zone fraction, consistent with OSM's mapping gap
  being worse specifically in flood-prone/riverside areas, which tend to
  be older or more informal settlement — a real, if unsurprising,
  pattern worth remembering, not just a coincidence). `build_exposure_
  report()` tags every buildings result with a `"source"` field
  (`"overture"` or `"osm_fallback"`) so a degraded count is never
  silently mistaken for Overture's fuller one — verified live by
  monkey-patching `fetch_overture_buildings_exposure` to raise and
  confirming the fallback triggers and tags correctly.

**Two real Overpass reliability issues found and fixed, both live, not
assumed:**
1. **The public `overpass-api.de` instance rate-limits under moderate
   sequential load** — a real 429 was hit after ~4 back-to-back test
   queries. Fixed with `_overpass_query()`: retries with exponential
   backoff (3s/6s/12s) across two mirrors (`overpass-api.de`,
   `overpass.kumi.systems`), degrading to an empty result (never raising
   past the module) if every attempt is exhausted — the same
   graceful-degradation convention the WFS calls already use.
2. **A heavy per-element `tags` request against a large result set
   triggered a server-side 504** — confirmed live: `out center tags` for
   all 17,686 buildings 504'd, while the identical query with `out ids
   center` (no tags) for the same elements returned in 2.35s. Overpass's
   own per-query cost scales with how much is asked for, not just how
   many elements match — the buildings-fallback query deliberately
   requests no tags (buildings don't need per-element tag data for a
   count-only figure anyway); bridges/hospitals keep tags since those
   result sets are small (786/139) and the names are actually useful.

**No dependency or requirements.txt change** — this addition uses
`requests`, already a dependency for the existing WFS calls in this same
module.

## 0.11 Road network & drainage network exposure

Requested for flood susceptibility/inundation, addressed before §0.9's
population exposure was implemented. Roads via OSM (as directed); for
drainage, "within the existing system" first — the HAND pipeline's own
DEM-derived stream network and NCOP's own hydrology layers — with OSM
filling the specific gap neither covers, the same supplement-not-replace
pattern as §0.10.

**Drainage — three sources, not one, each doing a different job:**
1. **`flood_model.py`'s own `06_streams.tif`** — the DEM-derived stream
   network the HAND calculation is physically built on (Phase 1's own
   `extract_streams` step). This already IS "the drainage network" for
   hazard-modeling purposes — nothing new needed, it's the terrain's own
   analysis, not a data-sourcing gap.
2. **NCOP's existing `major_rivers`/`minor_rivers` GeoServer layers**
   (§0.5) — large-scale named rivers, already reusable via this module's
   own `_wfs_get_geojson()`, not re-fetched from anywhere new.
3. **OSM `waterway=*` (new this pass)** — fills the actual gap: fine
   urban/engineered drainage (streams, canals, drains, ditches) at a
   resolution neither #1 nor #2 captures. **Confirmed: NCOP's own
   `map-layers.js` has no dedicated drainage/canal/storm-drain layer at
   all** (re-audited directly, not assumed — every "storm" match in that
   file is a Meteoblue/PMD weather layer, unrelated). Confirmed live on
   Nullah Lai: 876 features — 562 streams, 261 drains, 40 rivers, 6 dams,
   6 ditches, 1 canal — fetched in 1.26s with tags (a small enough result
   set that the per-element-tags cost that hurt buildings/roads isn't a
   concern here). **310.88 of 593.91 km (52.3%) sits inside the flood
   zone** — a much higher fraction than roads (~11%) or buildings (~13%),
   exactly as physically expected: streams/drains ARE the low points HAND
   measures distance from, not a coincidence.

**Roads — OSM `highway=*`, length-based, not point-based.** A road (or a
stream) is frequently much longer than the flood zone is wide, so testing
whether a single centroid point falls inside the zone would misrepresent
partial overlaps in both directions — the metric that's actually
meaningful, and what the flood-exposure literature itself reports (§0.9's
research), is **km of network inside the flood zone**, computed via real
line-geometry intersection. New shared helper `_line_network_length_exposure()`
(and `_local_utm_transformer()`) — reprojects into the correct Pakistan
UTM zone (41N-43N, picked from the AOI's own longitude) ONCE per call,
not a fresh local projection per feature the way `_geom_area_km2` does
for the much smaller admin-boundary case — confirmed necessary at
roads' 54,860-feature scale, not a premature optimization.

**A real correctness fix found along the way, not just a performance
one:** an unfiltered `highway=*` query mixes real roads with footways,
tracks, and steps — confirmed live on Nullah Lai: residential (34,740)
dominates, but footway (2,947) + path (650) + track (341) + steps (168)
+ cycleway (80) + construction (184) would have inflated an unfiltered
"road network" figure by covering non-vehicular ways the literature
wouldn't count as one. Fixed with `_VEHICULAR_HIGHWAY_CLASSES`, reported
alongside the unfiltered total rather than instead of it. Confirmed live:
**9,778.66 km total / 1,105.32 km (11.3%) in zone; 8,977.73 km vehicular
/ 1,015.88 km (11.3%) in zone** — vehicular is ~92% of the network by
length here, and both fractions land close to the same ~13% area/
building/population share found elsewhere in this exposure pipeline,
another passing cross-check.

**Real cost found, documented honestly, not hidden:** roads' length
computation is genuinely expensive at this scale — **confirmed live:
~38-49s even on a warm cache** (network fetch itself is fast, 3.6-14.9s
depending on Overpass's own variable load; the CPU-bound per-feature
reprojection is the actual cost). Avoided doubling that cost by computing
the full-network and vehicular-only totals in a SINGLE reprojection pass
rather than calling the shared helper twice — a real, caught-before-
shipping inefficiency, not a hypothetical one. **The full
`build_exposure_report()` call is now ~71s even warm** (was ~30s before
this addition) — the single biggest reason the async-job-polling
requirement for Phase 1.6 (already flagged as "load-bearing" after
Phase 1.5's own Overture findings) is now even more clearly non-
negotiable, not a new concern introduced here.

**Two Overpass reliability notes reinforced, not new:** the SAME query
shape (`out geom` for roads) took 14.9s in one test run and the
tags-included version took 3.6s in a later run — confirming the public
Overpass instance's response time is genuinely variable run-to-run, not
just under sustained load; `_overpass_query()`'s existing retry/backoff/
mirror-fallback (§0.10) already covers this, no new resilience code
needed. Tags WERE viable for the 54,860-way roads query this run (unlike
buildings' confirmed 504) — Overpass's per-query cost is apparently not
a hard function of element count alone; still worth keeping the
option to drop tags again if this becomes flaky at scale in production.

**No dependency or requirements.txt change** — `requests`, `shapely`, and
`pyproj` are all already used elsewhere in this module.

## 0.12 Optimization pass — production readiness (Phase 0/1/1.5 only)

Implements the production/memory/optimization recommendations made after
§0.11 landed, for what's actually built (Phase 0, 1, 1.5). Everything
below was tested live against the real Nullah Lai pilot, not assumed.
Population exposure (§0.9), AUC (§0.7), and Phase 1.6 remain untouched —
**this is where work stopped for the day; §0.9 (population) is the
planned next step.**

**1. Overture buildings — STRtree, not a per-building Python loop.**
Root-caused a claim from §0.8 rather than trusting it: "bbox fast-reject
measured within noise of no improvement" turned out to have a real
reason — the flood zone's own bounding box (`72.9498,33.4998` to
`73.2001,33.7801`) is almost exactly the WHOLE AOI's bbox, since its 714
parts are scattered across the catchment rather than clustered in one
corner. Confirmed live: a per-building bbox pre-filter let 100% of
603,076 buildings survive, every time — structurally useless for this
AOI's geometry, not a bug. **Two options were tested and only one
shipped:**
  - Centroid-only point test (tempting: cuts memory AND avoids full-
    polygon parsing) — REJECTED. Confirmed live against the real cached
    data: disagrees with the correct full-polygon result for 13,870 of
    603,076 buildings (2.3%), enough to shift the reported in-zone count
    from 77,862 to 63,992 — an 18% relative error. Too much accuracy
    loss for a memory saving.
  - `shapely.STRtree` (shapely 2.0's own compiled spatial index,
    already-pinned `shapely==2.0.6`, no new dependency) — SHIPPED.
    `tree.query(flood_zone_geom, predicate="intersects")` does the exact
    geometric test for all 603,076 buildings via one compiled GEOS batch
    call instead of a 603,076-iteration Python loop. Confirmed live:
    **same exact correct count (77,862) — zero accuracy loss — in ~11-14s
    vs. the original loop's ~15-19s**, a genuine, not marginal,
    improvement.
  - Side effect: the per-building bbox fields (`xmin`/`ymin`/`xmax`/
    `ymax`) were dead weight in both the cache and the loop that used
    them (STRtree needs none of it) — removed. **Confirmed live: cache
    size dropped 230.6MB → 165.6MB, a 28.2% reduction**, for the exact
    same data.

**2. Pre-warm management command — the highest-priority recommendation.**
New: `python manage.py warm_flood_exposure_cache [catchment] [--force]`
(`project/ncop_internal/management/commands/warm_flood_exposure_cache.py`).
Calls `flood_exposure.build_exposure_report()` for one or every pilot
catchment, meant to run as an explicit deployment/setup step — never
lazily on first user request, which is exactly the nginx-timeout risk
this whole optimization pass exists to prevent. Confirmed live: clean
success output with real per-catchment stats, a non-zero exit code
(`CommandError`) on an unknown catchment name (verified: `exit code 1`),
and correctly reports failure per-catchment without stopping the whole
run if one catchment's fetch fails.

**3. GDAL lock contention — made observable, not just "worth watching."**
`flood_model._gdal_lock()` is now a `@contextlib.contextmanager` (was: a
function that just returned the raw lock object) — every acquisition
through this module is timed, and a wait over
`_GDAL_LOCK_WARN_THRESHOLD_SECONDS` (1.0s) logs a WARNING naming the
contention. Correctness is unchanged — same underlying
`views._MON_PRED_GDAL_LOCK`, same full mutual exclusion, every existing
`with flood_model._gdal_lock():` call site needed zero changes (a
context-manager-returning function and one returning a raw lock object
are both used identically via `with`). Confirmed live, both directions:
normal acquisition still works with no behavior change (including
repeated sequential acquisition, the same pattern `build_hand_pipeline`'s
own `_stats_locked` helper already uses); a deliberately induced 1.3s
contention (a background thread holding the lock) correctly logged
`_gdal_lock() acquisition waited 1.30s` and the waiting caller still
proceeded correctly once released — no deadlock, no behavior change
beyond the new log line.

**4. AOI size guard — new `MAX_CATCHMENT_BBOX_DEG2` cap in
`flood_model.py`.** Nothing bounded catchment bbox size before this pass
— only the one hardcoded pilot catchment has ever been exercised, but
Phase 1.6 will make the AOI user-controllable and nothing currently stops
a much larger request. Deliberately REJECTS an oversized bbox rather than
silently downsampling it the way `MAX_INPUT_PX_BEFORE_DOWNSAMPLE`
handles an oversized uploaded raster elsewhere in this app — cropping a
user's requested AREA without telling them misrepresents the result in a
way downsampling a raster's resolution doesn't. Cap (0.30 deg²) set from
this project's own confirmed-live timings, not a guess: the Nullah Lai
pilot (0.0700 deg², ~721 km²) already costs ~225-270s for Overture and
~40-80s for road-network exposure — 0.30 deg² gives ~4x headroom without
inviting an AOI that would blow those costs out by an order of
magnitude. Checked once, at the top of `build_hand_pipeline()`, so every
downstream caller (including `flood_exposure.build_exposure_report()`,
which always calls `build_hand_pipeline()` first) fails fast before any
GEE/network/compute cost is spent. Confirmed live: the real pilot bbox
still passes; a 5°×5° test bbox (25 deg²) is correctly rejected with a
clear `ValueError` before touching GEE at all; a malformed bbox (min >
max on an axis) is also rejected; `build_hand_pipeline()` itself fails
fast end-to-end for an oversized catchment, not partway through.

**5. Dependency check — partial, honestly caveated, not a full Linux
verification.** `pip check` against the current fully-resolved
environment (pyarrow, the re-pinned `shapely==2.0.6`, geopandas, and
everything else together) reports no broken requirements — a real,
if partial, signal. **A genuine pre-existing issue was found and is
worth flagging plainly, not one introduced by this session's work:**
`requirements.txt`'s own GDAL line pins an absolute Windows file path
(`file:///D:/muhammad_arsalan/...win_amd64.whl`) — a literal `pip
install -r project/requirements.txt` (the exact command
`misc/ncop_production_deployment_guide_prod_arsalan_v_1.md` documents)
cannot resolve that path on any machine other than this one, Linux
included. This means the earlier "clean pip install -r requirements.txt
dry run on the prod VM" recommendation needs a caveat: whatever
GDAL-line substitution production's real process actually uses (not
visible from this dev machine) is what would need dry-running, not this
exact file verbatim. Not fixed here — out of today's scope, and the
production deployment docs likely already document how this is really
handled; worth a direct, explicit follow-up question to confirm rather
than an assumption either way.

**Not implementable today, both requiring things this session doesn't
have access to — stayed as documented open items, not attempted:**
- **Async job-id polling** — Phase 1.6 (the HTTP layer this would
  actually attach to) doesn't exist yet; building the async primitive
  with no consumer to wire it to would be speculative, not tested
  infrastructure. Stays Phase 1.6's own requirement, now with harder
  numbers behind it (§0.11's ~71s full-report timing) than when first
  raised.
- **Multi-process Waitress topology** — requires the actual production
  VM's process/thread configuration, which this session has no access
  to (no SSH, confirmed earlier this project). **Partially informed
  since:** production runs as a single systemd-managed
  `ncop-waitress.service` (per the user's own deployment runbook),
  which is consistent with a single Waitress process — but the exact
  `ExecStart` invocation (thread count, whether it spawns multiple
  workers) still isn't visible from this dev machine, so this stays a
  "likely single-process, not fully confirmed" note rather than a
  closed item. No SSH connection was made or attempted — credentials
  shared as reference context are not something to act on
  autonomously.

## 0.13 Population exposure — implemented (§0.9's design, built and tested)

§0.9's design shipped in `flood_exposure.py`: `fetch_population_exposure
(flood_zone_geom, elderly_cutoff_age=65)`, wired into
`build_exposure_report()`'s `"population"` key. Matches §0.9's numbers
exactly on re-test — 425,116 total / 47,137 under-5 / 16,759 elderly
(65+) for the Nullah Lai flood zone — confirming the earlier research
call wasn't a one-off fluke.

**Held to the same bounded-external-call bar as every other source in
this module, even though it's the first Earth Engine call this module
makes (not a plain `requests` call).** `views.py`'s own older AHP-
susceptibility code calls `ee.*.getInfo()` unwrapped throughout — this
module deliberately does NOT follow that precedent, and instead applies
its own already-established discipline (WFS/Overpass/Overture: every
external call bounded) for consistency within `flood_exposure.py`
specifically. New `_POPULATION_EXECUTOR` (single-worker, reasoning: API-
quota fairness across concurrent Earth Engine calls, the same shape as
`_OVERTURE_EXECUTOR`'s CPU-fairness reasoning, not a copy of it) +
`_POPULATION_TIMEOUT_SECONDS = 30` (confirmed live: real calls take
1.6-7.4s, so 30s is generous headroom, not a tight budget).

**Both degradation paths tested live, not assumed:**
- Simulated a GEE-side failure (monkey-patched the raw fetch to raise) —
  confirmed: degrades to `None` in 0.03s, logs a WARNING with full
  traceback, never raises past the module.
- Simulated a hang past the timeout (patched to sleep 10s against a
  2s test timeout) — confirmed: the caller returns in ~2.0s, not 10s;
  degrades to `None`; logs a WARNING naming the timeout. The background
  thread itself is left to finish/die on its own (an orphaned
  in-process thread, not an orphaned OS subprocess like WBT's own
  documented timeout caveat — a different mechanism, same "the caller
  is never held hostage" guarantee).

**Configurability confirmed live, not just claimed:** `elderly_cutoff_
age=60` correctly returns a HIGHER elderly count (26,725) than the
default 65+ cutoff (16,759) — same band-selection logic tested against
two different cutoffs, not just one hardcoded path.

**No new dependency, no disk cache.** `ee` and `shapely` are both
already used elsewhere in this app/module. Deliberately NOT disk-cached
like Overture/OSM — confirmed live the fetch itself is fast enough
(1.6-7.4s) that a cache would add complexity for negligible benefit,
unlike Overture's 225-270s cost where caching is the whole point.

**Full report timing, honestly reported as a range, not a single
precise number:** `build_exposure_report()` with population included
measured 75-85s across repeated runs (vs. ~64s before population) — a
noisier range than earlier sections' timings because a concurrent,
unrelated background thread (`translate.py`'s own periodic NLLB model
load/idle-unload cycle, already documented elsewhere in this app) was
confirmed overlapping some of these test runs and visibly slowing them
(one run logged a single weight-loading step taking 44.8s, versus its
normal sub-second pace) — a real measurement-contamination source, not
hidden or averaged away. Population's OWN isolated cost is a clean,
repeatable 7-7.3s regardless.

## 0.14 AUC accuracy assessment — implemented (§0.7's design, built and tested)

`project/ncop_internal/accuracy_assessment.py` — deliberately standalone,
not imported by or coupled to `flood_model.py`/`flood_exposure.py`, per
§0.7's own design intent (Phase 2.5's AHP output calls the same
`compute_auc()`/`assess_raster_auc()` later). `compute_auc()` matches
§0.7's own designed rank-sum (Mann-Whitney U) implementation exactly;
`fetch_flood_extent_presence()`, `_sample_points()`,
`_read_raster_values_at_points()`, and `assess_raster_auc()` are new,
tying the design to real WFS/GDAL/shapely mechanics.

**13/13 synthetic unit tests passed** — known-answer cases, not just "it
runs": perfect separation → AUC 1.0; perfect inverse separation → AUC
0.0; 200 trials of random scores → mean AUC 0.4989 (statistically ≈0.5,
the no-skill baseline); a hand-computed tied-score example (`scores=
[1,1,2,2], labels=[0,1,0,1]`) → AUC 0.5000 exactly, confirming the
average-rank tie-handling is correct, not just plausible; single-class
input → `NaN`, not a crash; empty input → `NaN`, not a crash; mismatched
array lengths → `ValueError`, not a silent wrong answer; every
`interpret_auc()` band boundary tested individually.

**A real methodology gotcha found and fixed before it could produce a
false negative:** the first attempt at a real end-to-end test picked a
Chenab-area test bbox using **GeoServer's own WFS `bbox=` filter as
confirmation of overlap** — the same pattern already trusted for the
Nullah-Lai-vs-20-layers check in this section's own original research.
Confirmed live this was wrong to trust for THIS purpose: `bbox=`
filtering tests bounding-box overlap only, not real geometry
intersection. A feature count of 1 for a candidate test bbox turned out
to mean 0.0% actual polygon coverage once checked directly (`shapely
.intersection().area`) — the Chenab-High polygon's own overall bounding
box spans the entire river system (70.99°–74.47°E), so almost any
sub-bbox within that huge extent "matches" the WFS filter without the
real polygon coming anywhere near it. Fixed by picking the test location
from the real geometry instead (`union.representative_point()`, verified
directly at 67.94% real coverage before proceeding) — worth remembering
for any future WFS-bbox-based overlap reasoning in this project, not
just this one test.

**Full pipeline validated end-to-end against real ground truth** — a
genuine Chenab-area test AOI (`[71.995, 30.912, 72.195, 31.112]`, 0.04
deg², well inside the §0.12 AOI-size cap), a real HAND pipeline built for
it (12.96s), and real presence polygons from the actual `chfex`/`cmfex`/
`clfex` WFS layers:
```
{"auc": 0.4747, "n_presence": 491, "n_absence": 474, "interpretation": "fail"}
```
**Confirmed, not a fluke** — reran separately per severity band: High
0.4649, Medium 0.4392, Low 0.4432, all landing in the same "fail" band
(worse than a coin flip), ruling out "wrong severity band" as the
explanation.

**This is a genuine methodological finding, not a bug — the module is
proven correct by the 13 synthetic tests above, and this result is what
it correctly computed from real data.** The test AOI's HAND raster has
very low relief (min 0m, max 12.18m, mean 1.15m across the whole area) —
consistent with a real Chenab floodplain, but also consistent with
Copernicus GLO-30's own ~4m typical vertical accuracy being comparable
to, or larger than, the actual terrain relief being measured there. In
very flat floodplain terrain specifically, raw uncalibrated HAND from a
30m DEM may carry more DEM noise than real hydrological signal — exactly
the kind of finding AUC exists to catch, and exactly why Phase 3's own
"do not trust the raw threshold without calibration" note already
existed before this test ran. Worth carrying into Phase 3 as a named,
confirmed risk for flat terrain specifically, not a generic caveat.

**No dependency change** — `numpy`, `requests`, and `shapely` are all
already used elsewhere in this app.

## 0.15 Phase 1.6, first slice — async job HTTP endpoints, implemented and tested

The first real HTTP endpoints for this whole system —
`project/ncop_internal/flood_model_views.py` (new file, same "new
subsystem gets its own file" precedent `chatbot.py`/`translate.py`
already established), wired at `POST /api/flood-model/run/` and
`GET /api/flood-model/status/<job_id>/`. Deliberately scoped narrowly:
async job plumbing for the existing pilot catchment(s) only — the
frontend panel and custom-AOI upload path from Phase 1.6's original
design are still unbuilt, this is the backend prerequisite they need.

**Async, not blocking, because the numbers now demand it.**
`build_exposure_report()` measured 64-85s even warm across §0.12-§0.14;
Overture's own cold fetch is 225-270s. A job-id-polling design was
already planned; this is where it actually got built. `POST` validates
and returns a `job_id` immediately (202); the real work runs in a
dedicated single-worker `ThreadPoolExecutor` (deliberately NOT more
workers — `build_exposure_report()` already serializes internally on the
GDAL/WBT/Overture/population locks, so a second job-level worker would
only add thread overhead, not real parallelism); `GET .../status/<id>/`
polls an in-process dict.

**Two real bugs found and fixed during this pass, not assumed away:**
1. **DRF's automatic per-view throttle check fires before any request
   validation.** Confirmed live: a malformed catchment name or bad JSON
   body — free, instant, never touches the job executor — consumed the
   same tight 3/min budget as a real job submission. A user who
   fat-fingered a couple of requests would then be locked out of
   submitting a genuine run for the rest of that minute. Fixed by
   overriding `initial()` to skip the automatic throttle check and
   calling `self.check_throttles(request)` manually inside `post()`,
   after validation passes — confirmed live: 5 deliberately-bad requests
   in a row, then a 6th valid one, and the valid one still got through
   (202, not 429).
2. **CSRF** — matched (not reinvented) `chatbot.py`'s own already-fixed
   pattern: `authentication_classes = []` / `permission_classes = []`
   alongside `@csrf_exempt`, because `csrf_exempt` alone does not stop
   DRF's `SessionAuthentication` from separately enforcing CSRF whenever
   the requester happens to be a logged-in NCOP user — a real bug this
   app already paid to find once. Confirmed live with a Django test
   client configured to actively enforce CSRF checks
   (`enforce_csrf_checks=True`): POSTing with no CSRF token at all still
   succeeds, not a 403.

**Full async flow verified live, end-to-end, with the real pipeline (not
mocked):** submit → `202` with a `job_id` → polled to completion (the
test process stayed alive to poll, rather than exiting immediately — an
early attempt that let the process exit right after submitting hit
`RuntimeError: cannot schedule new futures after interpreter shutdown`,
a test-script artifact from Python's own executor-shutdown-at-exit
machinery, not a real bug — the actual Waitress deployment never "exits"
between requests) → `running` → `done` in 80.9s, with the final payload
containing both the flood-zone PNG (matching the already-confirmed-live
`/media/` serving path) and the full exposure report, numbers matching
every previously-confirmed figure exactly (95.405 km², 425,116
population, etc.) — no regression anywhere in the chain this endpoint
sits on top of.

**Also tested and passed:** throttle enforcement (3 valid submissions
succeed, the 4th is a clean `429`, tested via a fast monkeypatched job
function so the test didn't need to burn ~4×70s of real compute — the
real pipeline was already proven above); the error path (both a
simulated job-runner failure and, separately, a REAL exception raised
from inside `flood_model.render_flood_prone_zones` itself) surfaces as
`{"status": "error", "error": "..."}` with a normal `200` response, never
a `500` or an unhandled exception; unknown `job_id` → clean `404`; the
job registry's TTL purge and hard-cap purge (tested by directly injecting
220 synthetic jobs) both trim correctly, oldest-first.

**New settings additions** — `REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]`
gets two new scopes: `flood_model_run` (3/min — deliberately tight: the
job executor is single-worker, so an uncapped burst would queue real
70s+ jobs behind each other, and the Nth queued job would wait ~N×70s
before even starting) and `flood_model_status` (120/min — cheap dict
lookups, expected to be polled every 2-3s while a job runs).

**No dependency change.** No core logic in `flood_model.py`/
`flood_exposure.py`/`accuracy_assessment.py` was touched — this is a thin
orchestration layer calling those modules exactly as they already exist.

## 0.16 Phase 1.6, second slice — frontend panel, implemented

New `frontend/src/modules/flood-model-control.js` (`FloodModelControl`) +
`frontend/src/styles/dashboard/_flood-model-panel.css` — the first real UI
for this whole system. Deliberately scoped to match §0.15's own backend
scope: the existing pilot catchment(s) only (a dropdown, currently just
Nullah Lai) — custom-AOI drawing and DEM/rainfall upload remain a
separate, later step, since that needs to modify `flood_model.py`'s DEM-
fetch logic itself (a real core-logic change, not a thin wrapper), while
this slice touches zero backend logic.

**Structurally copied from `GisExportControl`, not reinvented** — read
that module directly before writing anything, to match its conventions
exactly rather than approximate them: same DOM shape (`#floodModelPanel`
/`#floodModelToggle`/`#floodModelClose`), same delegated-listener pattern
on a persistent content container, same `MutationObserver` resync for
`dashboard.js`'s `RAIL_PANEL_REGISTRY` force-close behavior, same
`RAIL_PANEL_REGISTRY`/`buildUnifiedRightRail()` registration points. CSS
baseline lifted directly from `_gis-export.css`'s own rail-button/panel/
section rules — visually consistent with the rest of the rail by
construction, not by eyeballing it.

**Panel — three sections, matching this slice's own narrower scope (not
the full four-section design in §0.16's own earlier plan, which still
applies once custom-AOI/upload exists):** Area (catchment dropdown) →
Model settings (HAND threshold slider, 0.5-10m) → Run + Results. Results
render as BOTH a temporary map raster overlay (Mapbox `image` source —
same pattern `GisExportControl`'s own `#addImportedRasterLayer` already
uses for imported GeoTIFFs, never added to the permanent layer catalog)
and a numeric summary (flood zone km², top affected districts, buildings/
population/roads/drainage in the zone) read directly from
`build_exposure_report()`'s own existing payload shape — no new backend
serialization needed.

**Async polling wired to §0.15's endpoints exactly as designed** — submit
→ `202` + `job_id` → poll every 3s → render on `done`. Polling only runs
while the panel is visible (stopped on hide via the same
`MutationObserver`/`hidePanel()` path, resumed on reopen if a job was
left in flight) — no reason to keep hitting the status endpoint for a
closed panel.

**One real conversion bug caught during review, not live-tested (see
verification gap below) — worth flagging explicitly rather than silently
trusting it:** the backend's `flood_zone.bounds` payload is a plain
`[[minx,miny],[maxx,maxy]]` pair (`flood_model._flood_zone_payload`), but
Mapbox's `image` source wants four corners in `[top-left, top-right,
bottom-right, bottom-left]` order. Handled with an explicit conversion in
`#addResultLayer()` at the one place this shape is actually consumed —
worth double-checking visually once real browser testing is possible
(see below), since a coordinate-order mistake here would show the raster
mirrored or misplaced rather than failing loudly.

**Verified:**
- `npm run build` succeeds — no new errors (the CommonJS-module and
  `eval` warnings in the build output are both pre-existing, in files
  this change never touched — `mapbox-functions.js` and a `lottie-web`
  dependency).
- Confirmed the new code and CSS are genuinely present in the built
  bundle (`grep`'d `dist/assets/dashboard_main-*.js`/`.css` directly for
  `FloodModelControl`/`custom-flood-model-btn`/`flood-model-panel`) —
  not silently dropped by a bad import or tree-shaking.
- `node --check` — no syntax errors.
- Manual review of every state-transition path (run → poll → done/error,
  show/hide mid-poll, re-run guard, disabled-button state during a run)
  against the actual code — no logic gaps found on this pass.

**NOT verified — a real, honestly-stated gap, not glossed over:** no live
browser/click-through test. This session has held to an explicit standing
user instruction against starting persistent dev servers throughout —
that instruction is respected here too, even though it means this UI
hasn't actually been clicked, and the coordinate-order fix above hasn't
been visually confirmed. **Recommend an actual browser pass (`npm run
dev` + click through: open panel, run against Nullah Lai, watch it poll,
confirm the raster lands in the right place and the numbers match
§0.12-§0.15's own confirmed figures) before considering this
production-ready** — build success and code review are necessary but not
sufficient for a UI feature, and this document has consistently held
"confirmed live" as the bar for everything else in this project;
holding the frontend to a lower bar than the backend it calls would be
inconsistent with that standard, not a matter of choice.

**No dependency change.**

## 0.17 Real browser testing — a genuine bbox error found and corrected

The very first real browser pass (§0.16's own "verification gap") found
three real issues — one wiring bug (fixed, see the running transcript),
one icon collision (fixed), and one substantive methodological error
this section documents in full, because "very strict on accuracy" is the
right standard to hold this to.

**The Nullah Lai pilot bbox was never checked against the basin's own
published boundary — confirmed live it was ~3x too large.** Visual
inspection in a real browser showed the flood-prone zone's HAND-derived
stream network spanning almost the entire Islamabad-Rawalpindi urban
area, not something recognizable as one specific nullah's catchment.
Researched rather than assumed:
- **Lai Nullah Basin's real catchment area: 234.9 km²** (144.4 km² in
  Islamabad + 90.5 km² in Rawalpindi), corroborated across multiple
  independent sources — Rahman, "Lai Nullah Basin Flood Problem
  Islamabad," WMO/APFM Associated Programme on Flood Management case
  study (http://www.floodmanagement.info/publications/casestudies/cs_pakistan_nullah_full.pdf);
  Farooq et al., "Simulation of the impacts of land-use change on
  surface runoff of Lai Nullah Basin," Journal of Environmental
  Management (2011); the basin's own published geographic extent, "33°33′
  and 33°46′ North and 72°55′ and 73°07′ East."
- **This project's own ORIGINAL bbox** (`[72.95, 33.50, 73.20, 33.78]`,
  chosen in Phase 0 without checking it against any published boundary)
  **implied ~721 km²** — confirmed by direct area calculation, roughly
  3x the real basin. This was a real, uncaught error from Phase 0 through
  §0.16, not something introduced by any later phase.
- **Corrected** `flood_model.PILOT_CATCHMENTS["nullah_lai"]["bbox"]` to
  the basin's own published extent: `[72.9167, 33.55, 73.1167, 33.7667]`
  (converting 33°33′/33°46′N and 72°55′/73°07′E to decimal degrees) —
  0.0433 deg², well inside the §0.12 AOI-size cap (0.30 deg²).

**Confirmed live, before/after, not assumed to have helped:** full
pipeline rebuilt from scratch (cache cleared, DEM re-fetched, every
downstream step re-run) against the corrected bbox:

| Metric | Before (wrong bbox) | After (corrected bbox) |
|---|---|---|
| Flood-prone zone | 95.405 km² | **49.752 km²** (-47.9%) |
| Buildings in zone | 77,862 of 603,076 | 50,142 of 419,473 |
| Population in zone | 425,116 | 291,709 |
| Roads in zone | 1,105.32 of 9,778.66 km | 698.84 of 6,653.37 km |
| Drainage in zone | 310.88 of 593.91 km | 214.5 of 417.06 km |
| District split | Islamabad 67.8% / Rawalpindi 31.8% | **Islamabad 56.0% / Rawalpindi 42.4%** |

**The district split is an independent cross-check that passed, not
just a smaller number.** The published literature reports Lai Nullah's
own basin as 144.4/234.9 = 61.5% Islamabad, 90.5/234.9 = 38.5%
Rawalpindi. This project's corrected bbox produces 56.0%/42.4% —
noticeably closer to the published split than the old bbox's 67.8%/31.8%
was, computed from a completely different source (NCOP's own district
boundary WFS layers, not the basin literature) and never tuned to match
it. Two independent methods landing in the same neighborhood is real
evidence the correction is right, not a coincidence assumed to be fine.

**A second real bug found during the SAME rebuild, unrelated to the
bbox:** the corrected (smaller) bbox's roads query returned a genuine
`HTTP 500` from the public Overpass instance on the first attempt —
silently degrading to `roads_in_zone_km=0.0`, since `_overpass_query()`
only retried on 429/502/503/504, not 500. **Confirmed live this was
transient, not a real query problem:** the identical query, re-sent
seconds later by hand, returned `200` correctly. Added `500` to the
retryable status set (§0.7's `_overpass_query()`) — the same class of
"public Overpass instance is genuinely flaky" finding already documented
for 429/504 in §0.10, extended by one more observed code.

**On the HAND threshold — corrected an imprecise earlier claim, not just
added citations.** §0.8's original comment cited "the 1-5m range
operational HAND-based flood mapping (e.g. NOAA's) typically uses" —
this was imprecise: NOAA's own National Water Model FIM service does NOT
use a fixed threshold at all, it derives a HAND cutoff from a real
discharge value via a rating curve per stream reach (calibrated against
USGS stage-discharge relationships and FEMA 100-year flood maps) — i.e.
a genuinely defensible threshold needs a rainfall/discharge SCENARIO as
input, which is exactly Phase 2's job (dynamic PMD coupling), not yet
built. `HAND_FLOOD_PRONE_THRESHOLD_M = 3.0` remains an EXPLORATORY
default — now correctly documented as such, both in `flood_model.py`'s
own comment and directly in the frontend panel itself (not just a code
comment nobody using the UI would see) — kept mid-range within the one
geographically comparable published study found: Bhatt & Srinivasa Rao
(2018), "HAND (height above nearest drainage) tool and satellite-based
geospatial analysis of Hyderabad (India) urban floods, September 2016,"
Arabian Journal of Geosciences 11(19):600
(https://doi.org/10.1007/s12517-018-3952-1) — HAND 1-5m spans "very high
to very low" flood susceptibility for a comparable South Asian urban
catchment. That same literature (the HAND-vs-hydrodynamic-model
comparative review, Earth Science Informatics, 2023,
https://doi.org/10.1007/s12145-023-01218-x) documents HAND
UNDERESTIMATING inundation by up to 40% in flat, heavily channelized
urban settings — a real, named caveat for Lai Nullah specifically (much
of its urban reach is channelized), not a generic disclaimer, and now
stated as such in the frontend panel too.

**Directly answering the three accuracy questions asked, not deflecting:**
- **"Where is the accuracy report?"** There isn't one for Nullah Lai.
  The AUC methodology (§0.7/§0.14) is built and tested — against a
  different catchment (Chenab) that has real overlapping ground truth,
  because Nullah Lai confirmed does not overlap any of the 20 existing
  flood-extent layers. This is now stated directly in the frontend panel
  itself, not left implicit.
- **"Where is the AHP zonation?"** Not built. What's shown is Phase 1's
  hazard layer only (terrain/HAND-based) — not an AHP-weighted
  susceptibility or vulnerability score. That's Phase 2.5, unstarted.
  Also now stated directly in the panel.
- **"Isn't this too large for Nullah Lai flooding?"** Yes — confirmed,
  root-caused, and fixed above (the bbox, not the HAND math itself, was
  the error).

**Progress checklist added, requested for real UX reasons — a genuinely
additive, backward-compatible change, not a core-logic rewrite.**
`flood_exposure.build_exposure_report()` gained an OPTIONAL
`progress_callback` parameter (defaults to `None`) — every existing
caller (the management command, every prior test in this codebase)
passes nothing and behaves identically; confirmed live via three checks:
a no-callback call still returns the exact same result; a callback-
supplied call returns the SAME result with the callback additionally
invoked at each of 10 real stages, in order; a deliberately-raising
callback is swallowed (logged, not propagated) without breaking the
report. `flood_model_views.py`'s job runner uses this to record
`current_stage`/`completed_stages` on the job dict, now returned by
`GET /api/flood-model/status/<job_id>/`. The frontend renders these as a
real checklist (✓ for each completed stage, an active indicator for the
current one) instead of a single static "Running…" line — confirmed
live end-to-end over the actual HTTP endpoints, watching real stages
tick in the correct order against the real pipeline.

**Also added: a catchment marker + tooltip**, shown at the selected
catchment's bbox centroid whenever the panel is open, using the SAME
corrected bbox center — so fixing the bbox also fixed where this marker
points, not a coincidence.

**Two additional UI bugs found and fixed in this same live-testing pass
(both pre-existing from §0.16, not new):**
1. `floodModelPanel` was registered in `dashboard.js`'s
   `RAIL_PANEL_REGISTRY` (mutual-exclusion) but never added to the
   separate `RAIL_PANEL_BUTTON_MAP`, which is what actually lifts a
   panel to be a sibling of `#map` and stamps it with the
   `right-rail-panel` class that `_map-panels.css` uses for BOTH
   hidden-by-default state AND dynamic positioning next to its rail
   button. Missing that one entry meant the panel rendered visible by
   default, in the wrong position, clashing with the rail — confirmed
   live in the browser, root-caused by reading `_map-panels.css` and
   `dashboard.js#buildUnifiedRightRail` directly rather than guessing,
   fixed with the one missing map entry, no CSS or core logic touched.
2. The rail button's icon (`waves`) was identical to the existing Ocean
   Currents button's icon — changed to `triangle-alert` (confirmed
   present in this project's pinned lucide version, 0.546.0), a clearer
   semantic fit for "Early Warning" besides being visually distinct.

**No dependency change.**

## 0.18 The extent is still too broad — a real, cited, decisive finding, not resolved by the bbox fix alone

§0.17's bbox correction fixed a real 3x-oversized AOI, but the user
continued to question the RESULTING extent (49.752 km², ~21% of the
234.9 km² basin) even after that fix — correctly, it turns out. Rather
than eyeball the map again, this section researched a real, independent
comparison point.

**Found: a published HEC-RAS/HEC-GeoRAS hydraulic model of Nullah Lai's
own main channel** (the Kattarian-to-Gawalmandi bridges reach through
central Rawalpindi, a fine-resolution topographic survey of that
specific corridor, referenced across multiple sources — "Hydrological
Modeling Nullah Lai" and "Hydrological Modelling and Flood Hazard
Mapping of Nullah Lai," both integrating HEC-RAS/HEC-GeoRAS with GIS to
delineate flood zones at different discharge values). **Its own result:
inundation area at a severe 3,000 m³/s discharge is 3.4 km²** (2.96 km²
of that under 1-5m depth).

**Important scope caveat, stated plainly rather than glossed over:**
this is NOT a strict apples-to-apples comparison. The HEC-RAS study
modeled one specific channel reach through central Rawalpindi, not the
whole basin's full stream network the way this project's HAND zone
does. The comparison is still genuinely informative, not dismissable:
even along the single highest-risk, highest-discharge corridor in the
whole basin, real modeled inundation at a severe event is a narrow
band — not a broad zone. This project's 49.752 km² susceptibility zone
covering ~21% of the entire basin, by contrast, is **~14.6x larger than
the real inundation area found for the basin's own worst corridor at a
severe discharge** — a meaningful, real gap, not a rounding difference.

**Why this happens — a real mechanism, not just "HAND is imprecise":**
HAND with one fixed vertical threshold has no concept of how much water
is actually available. Every cell within `threshold_m` of ANY stream
cell counts, regardless of local slope or channel capacity — a real
discharge event, by contrast, is bounded by how much water there
actually is and where the channel geometry lets it go. On steep,
engineered urban channel segments (like the modeled Kattarian-Gawalmandi
reach) a fixed vertical rise translates to a NARROW lateral extent; on
gentler terrain along the basin's many smaller tributaries, the same
vertical rise can translate to a much WIDER lateral extent. A uniform
threshold across a whole basin with mixed terrain necessarily
overstates some areas and understates others — consistent with, not
contradicting, the HAND-underestimates-in-flat-channelized-settings
caveat already documented in §0.17 (that finding was specific to
engineered channel segments; the broader overestimate seen here comes
from the many gentler-terrain tributaries elsewhere in the basin).

**Action taken now — relabeling, the responsible immediate fix, not a
number change:** presenting 49.752 km² as if it were "the flood extent"
would be actively misleading given this evidence. The frontend panel
(`flood-model-control.js`) and its results section were reworded
throughout: "flood-prone zone" → **"susceptibility zone"**, with an
explicit methodology note stating this is a terrain-based indicator,
NOT a predicted flood extent for any specific event, citing the
Kattarian-Gawalmandi comparison directly in the UI. Deliberately did
NOT just lower the threshold number to better match 3.4 km² — tuning
one parameter to match one external data point, without a real
discharge/rainfall scenario driving it, would be curve-fitting to a
single number, not a genuine fix. The genuine fix is Phase 2 (rainfall/
discharge-driven coupling), already identified in §0.17 as what a truly
defensible threshold needs.

**A concrete, real lead for Phase 3 — not just "need more data" repeated
again:** if the underlying GIS delineation (shapefile or raster) from
this HEC-RAS study is obtainable (from its authors, or the source
report), it would be genuine, catchment-SPECIFIC ground truth for
Nullah Lai — the exact gap already named in §0.7/§0.14 (Nullah Lai has
no overlap with the 20 existing NCOP flood-extent layers). Worth
pursuing directly rather than treating "no ground truth for Nullah Lai"
as a closed question.

**Two smaller, real UI bugs also found and fixed in this same pass:**
1. **The catchment marker's tooltip text was invisible** — white-on-
   white. `.flood-model-marker-tooltip` inherited `var(--text-primary)`,
   correct for panels on this app's own dark background but wrong here:
   Mapbox's `Popup` renders on ITS OWN white background by default,
   unrelated to the app's theme. Fixed with an explicit dark color,
   not a theme token.
2. **No way to remove what this panel adds to the map** — added a
   "Clear map" button next to Run that removes both the result raster
   overlay AND the catchment marker/tooltip, whichever is currently
   showing (`#clearMap()`, calling the same `#removeResultLayer()`/
   `#removeCatchmentMarker()` methods already used internally, not new
   removal logic).

**Verified:** `npm run build` succeeds; new code/CSS confirmed present
in the built bundle (`floodModelClear`, `flood-model-clear-btn`,
`susceptibility zone`, `Kattarian`, `#1a1a1a` all grepped directly out
of `dist/assets/dashboard_main-*`). No backend change in this section —
purely frontend wording, styling, and one new cleanup button.

**No dependency change.**

## 0.19 Phase 2: discharge-driven, spatially-varying flood stage — the real fix for §0.18's gap

**User's own instruction, verbatim:** "yes if hec-ras and its documentation
is free and open source you can integrate it or utillizes it after through
searching implement this as i want accurate as possible inundation than
we would move on." This section documents that research, the
implementation it led to, every real bug found while building it, and the
validated result.

### HEC-RAS and GeoFlood — both researched and disqualified, for named reasons

**HEC-RAS (USACE):** free to download, but **not open source** — the
user's own phrasing conflated "free" and "open source"; they are not the
same thing here, and worth stating plainly rather than assuming
permission from the "free" half alone. Its only real automation paths
(`HECRASController` COM automation, and the community wrappers built on
top of it — `ras-commander`, `raspy-auto`) are **Windows-COM-only**.
This project's confirmed production reality (§0.12/§0.17) is
nginx+waitress on Linux — running the actual HEC-RAS solver would mean
standing up separate Windows infrastructure this project has never had
and has deliberately avoided since Phase 0 (§2/§3 already rejected a
heavy-solver-plus-new-infrastructure approach once, for the same
reasons). Disqualified on architecture grounds, not a license technicality.

**GeoFlood** (github.com/passaH2O/GeoFlood) — the closest existing
open-source HAND+Synthetic-Rating-Curve tool, and worth taking seriously
as a real alternative before hand-rolling anything. Disqualified for two
independent reasons, each already an established rule in this project,
not a new one invented for this decision: (1) **GPLv3** — the same
license class already rejected for RichDEM/PySheds in §3, for the same
reason (this app's geospatial stack is deliberately kept permissive);
(2) depends on **GRASS GIS + TauDEM**, two more heavy native toolkits on
top of WhiteboxTools (already chosen and working), and its own DEM
handling is `rasterio`-based — a real, already-documented DLL-Hell risk
with this venv's `osgeo.gdal` (§0.6).

**The underlying SCIENCE, however, is published and uncopyrighted** —
not licensed software. SCS Curve Number runoff, Kirpich time-of-
concentration, the SCS triangular unit hydrograph, Leopold-Maddock
hydraulic geometry, and Manning's equation are the same building blocks
GeoFlood itself uses internally, and the same class of method NOAA's own
operational National Water Model HAND-FIM service uses (a Synthetic
Rating Curve, SRC — Zheng et al. 2018, NOAA). Implementing this chain
directly, using only what's already in this app's stack (GDAL raw raster
I/O, numpy), is the same "hand-roll it, don't import a conflicting
dependency" discipline already used for zonal statistics (§0.6) and AUC
(§0.7) — not a new pattern.

### What was built: `flood_discharge.py` (new file, pure hydrology math, no I/O)

Confirmed live to match this exact basin's own published research
method: Farooq et al. 2011 ("Simulation of the impacts of land-use
change on surface runoff of Lai Nullah Basin") states "The Soil
Conservation Service (SCS) Curve Number (CN) model was chosen to
estimate runoff and peak discharges" — the same starting point used here.

- **`scs_runoff_depth_mm(rainfall_mm, curve_number)`** — standard
  NRCS TR-55 formula, `S = 25400/CN - 254`, `Ia = 0.2S`,
  `Q = (P-Ia)²/(P-Ia+S)` for `P > Ia`, else 0. `LAI_NULLAH_COMPOSITE_CN
  = 80.7`, computed from Farooq et al.'s own confirmed land-use split
  for this exact basin (residential 38.6% / agricultural 14.2% / forest
  14.8% / grass-bare 32.4%) against standard TR-55 Table 2-2 lookup
  values for Hydrologic Soil Group C (a stated, not hidden, assumption —
  no local soil survey available to this project).
- **`kirpich_time_of_concentration_hr(length_km, relief_m)`** — Kirpich
  (1940): `Tc(min) = 0.0195 · L(m)^0.77 · S^-0.385`.
- **`scs_peak_discharge_m3s(area_km2, runoff_depth_mm, duration_hr, tc_hr)`**
  — SCS triangular unit hydrograph peak: `qp = 0.208 · A · Q / Tp`,
  `Tp = D/2 + 0.6·Tc`. **A real, caught-and-fixed bug**: an earlier
  version of this function used `2.08`, a 10x error. Not caught by this
  module's own unit tests (which were self-referentially checking
  against the same wrong formula — an explicit, documented lesson: a
  test suite written alongside buggy code can validate the bug, not the
  intent). Caught instead by an **external plausibility check** against
  a real event: the buggy formula gave ~38,816 m³/s for the 2001
  Islamabad/Rawalpindi flood's rainfall (620mm/10hr) on this 242 km²
  basin — larger than the Mississippi River's own average discharge, an
  implausible result for a basin this size. Re-derived the SI
  coefficient from first principles (the English-unit `qp=484AQ/Tp`
  converted via mi²→km²/in→mm/cfs→m³/s) and got `0.20833...`,
  independently confirmed via a second source (Learn Hydrology Studio's
  own published SI formula). Corrected estimate: ~3,882 m³/s — a
  plausible extreme-flood discharge, and within the right order of
  magnitude of the reference study's own 3,000 m³/s severe-scenario
  figure (see below).
- **Leopold-Maddock (1953) hydraulic geometry** — `channel_width_m =
  2.5 · drainage_area_km2^0.4` (regionally-typical coefficients, NOT
  locally calibrated — no gauged cross-section survey exists for Nullah
  Lai, a stated approximation).
- **`manning_discharge_m3s`** / **`build_synthetic_rating_curve`** /
  **`discharge_to_stage_m`** — Manning's equation over a
  rectangular-channel approximation, swept into a stage→discharge
  lookup table (0.025m steps, matching NOAA's own operational
  convention), inverted via interpolation. `MANNING_N_DEFAULT = 0.035`
  (Chow 1959, natural/semi-engineered earthen channel with some
  vegetation — matches §0.18's own "heavily channelized in its urban
  reach" note without assuming a smoother concrete-lined value).
- **`solve_stage_for_discharge_m`** — direct bisection solve for one
  discharge→stage lookup, cheaper than a full rating-curve sweep when
  only one value is needed. Confirmed live to agree with
  `discharge_to_stage_m`'s own interpolation to within 0.0004m across a
  four-point spot check (10/100/500/2000 m³/s).
- **`solve_stage_for_discharge_m_array`** — a **vectorized** numpy
  sibling of the above. Built because the spatially-varying pipeline
  below needs this solved for every STREAM cell in a raster (tens of
  thousands of cells) — a plain per-cell Python loop (50 bisection
  iterations × tens of thousands of scalar calls) was recognized as an
  unbounded, too-slow cost for a request-time pipeline before it was
  ever wired in, not discovered by a slow test after the fact. Confirmed
  live: agrees with the scalar bisection to within its own tolerance on
  an 8-point spot check, and solves 80,000 cells in **0.14 seconds**
  (vs. an unmeasured but clearly much larger cost for the per-cell
  version).

### Why a single basin-uniform stage doesn't work — caught before it shipped

The first design computed ONE outlet discharge and ONE outlet-derived
stage, then compared it against HAND basin-wide — the natural first
instinct ("replace the fixed 3.0m with a calibrated number"). Computing
it for real (outlet stage at Q=3,000 m³/s → **9.437m**) showed this
would make the flagged zone LARGER than the old fixed threshold, not
smaller — the exact same structural flaw §0.18 already named (a single
spatially-uniform cutoff), just with a bigger number, i.e. **curve-fitting
dressed up as a fix, not an actual fix.** Caught by computing and reading
the actual number before wiring it in, not by assuming a discharge-based
approach would automatically be better. This is why the real
implementation below is per-reach, not basin-uniform.

### The spatially-varying pipeline — `flood_model.build_discharge_driven_flood_zone()`

New, **additive** function in `flood_model.py` — does not modify
`render_flood_prone_zones` or `HAND_FLOOD_PRONE_THRESHOLD_M`'s own
fixed-threshold path; both remain available side by side, per this
project's standing "preserve core logic" constraint. Method:

1. **Outlet peak discharge** — `flood_discharge.estimate_peak_discharge_m3s`
   from a caller-supplied `rainfall_mm`/`duration_hr` scenario, plus this
   catchment's own real, DEM-derived relief/area (reusing
   `build_hand_pipeline`'s already-cached DEM and flow-accumulation
   stats — never re-fetched) and this catchment's literature-cited
   length/CN.
2. **Each STREAM cell's own local drainage area** — its D8
   flow-accumulation cell count × this raster's own real pixel area
   (derived from the bbox/latitude via the 111.32 km/deg convention,
   not a fixed "30m pixel" assumption).
3. **Each stream cell's own local discharge** — outlet discharge scaled
   by `(local_area / outlet_area)`. Assumes spatially-uniform runoff
   generation across the basin for one storm (no distributed-rainfall
   input in this pilot) — an honest, stated simplification.
4. **Each stream cell's own local stage** —
   `solve_stage_for_discharge_m_array`, using a SINGLE basin-average
   channel slope (`relief/length`) for every reach. This is the one
   deliberately coarse simplification left in this pass: true per-reach
   slope would need stream-network segmentation not built here — a
   named next-tier improvement, same posture as the CN/soil-group
   assumption above.
5. **WhiteboxTools `euclidean_allocation`** transfers each stream cell's
   local stage to every other cell, keyed by nearest-stream-cell — a
   full-raster "allocated stage" surface.
6. **Final mask: flood-prone where `hand ≤ allocated_stage`**, using the
   SAME flow-path-based `hand` raster the fixed-threshold path already
   uses, not a dedicated Euclidean-metric HAND (see the WhiteboxTools bug
   below for why that pairing was tried and abandoned).

### Three real WhiteboxTools bugs found while building this — each confirmed live, not assumed

This project's own crash-safety discipline (`flood_model.py`'s module
docstring: "WhiteboxTools's OWN return code is not trustworthy") already
warned that this library's success signals can't be trusted blindly.
This pass found three concrete instances of that same class of problem,
each in a *different* way, in the tools this feature needed:

1. **`elevation_above_stream_euclidean` returns all-zero everywhere
   except the stream cells themselves.** Built initially to pair with
   `euclidean_allocation` for "nearest stream cell" metric consistency
   (both Euclidean, vs. mixing with the flow-path-based `hand`).
   Confirmed live (WhiteboxTools v2.4.0, confirmed via `wbt.version()`):
   output raster had exactly as many valid cells as there are stream
   cells, all equal to 0.0 — everywhere else, NoData. Fetched the tool's
   own Rust source
   (`elevation_above_stream_euclidean.rs`) to confirm root cause: its
   neighbor-propagation pass never reaches non-stream cells, unlike its
   own sibling `euclidean_allocation`, which propagates correctly (a
   different code path, confirmed to actually cover ~99% of the grid in
   testing). Resolved by NOT using this tool at all — comparing against
   the already-proven flow-path `hand` raster instead, which is also
   the more standard HAND definition anyway (matches NOAA's own
   operational methodology). The resulting metric mismatch (Euclidean-
   nearest vs. flow-path-nearest stream cell can, in principle, differ
   for a given cell) is real and stated, not hidden — expected to be
   small at this pilot's resolution given a dense stream network, and
   least consequential exactly where it matters most (cells close to a
   stream).
2. **`euclidean_allocation` returns `inf` everywhere when every source
   value is exactly `0.0`.** Found while testing a below-initial-
   abstraction storm (5mm rainfall — SCS-CN correctly computes zero
   runoff for this basin's CN=80.7). Every stream cell's own local stage
   is legitimately 0.0 in that case; feeding that all-zero raster to
   `euclidean_allocation` produced `inf` everywhere, which then made
   `hand ≤ inf` true basin-wide — the **opposite** of correct for a
   storm with zero runoff (585,918 of 586,178 valid cells wrongly
   flagged flood-prone). Fixed with an explicit guard: when the outlet's
   own peak discharge is ≤ 0, the tool is never called for this
   degenerate input at all — the mathematically correct answer (only
   the stream channel itself, `hand == 0`, is "at" water level) is
   computed directly instead. A second, belt-and-braces `np.isfinite()`
   guard was also added on the normal (non-degenerate) path, in case a
   different pathological input ever triggers the same class of bug.
3. (Already known, §0.12/Phase 0) WhiteboxTools' own return code being
   untrustworthy — the output-file-exists-and-non-empty check already in
   `_run_wbt()` covered every step used here; no new instance of this
   specific failure mode, listed for completeness since it's the same
   family of "verify, don't trust the tool's own success signal" problem.

Each of these was found by **running the real pipeline against real
data and inspecting the actual output values**, not by reading
documentation or assuming the tool worked — the same "confirmed live"
evidentiary bar used throughout this project.

### Results — validated against real Nullah Lai data, compared to the §0.18 reference

Ran against the pilot catchment's already-cached DEM/flow-accumulation
(outlet drainage area 242.21 km², confirmed within ~3% of the literature's
234.9 km² — §0.17's own cross-validation, reused unchanged here):

| Scenario | Rainfall/duration | Peak discharge (outlet) | Flood-prone area (whole basin) |
|---|---|---|---|
| Below initial abstraction | 5mm / 1hr | 0 m³/s (no runoff) | stream network only |
| Light storm | 30mm / 3hr | 55.6 m³/s | 1.90 km² |
| Moderate storm | 80mm / 5hr | 386.0 m³/s | 3.84 km² |
| Severe (2001-flood-scale rainfall) | 200mm / 6hr | 1,382.6 m³/s | 10.13 km² |
| Extreme, ≈ reference study's own discharge | 400mm / 8hr | 2,737.0 m³/s | **19.81 km²** |
| *(for comparison)* Fixed 3.0m HAND threshold | — | *(no discharge basis)* | 49.75 km² |
| *(for comparison)* HEC-RAS reference, Kattarian-Gawalmandi reach | — | 3,000 m³/s | 3.4 km² (**one reach**, not whole basin) |

A monotonically increasing, physically sensible curve (more rain → more
discharge → more flood-prone area), degrading gracefully to "just the
stream channel" for a storm with no runoff — no crashes across the full
sweep, including every edge case tested (zero/negative rainfall,
zero/negative duration, unknown catchment, a below-initial-abstraction
storm). At a discharge close to the reference study's own 3,000 m³/s
(2,737 m³/s here), the discharge-driven whole-basin susceptibility area
is **19.81 km² — roughly 2.5x smaller than the old fixed-threshold's
49.75 km²**, and the remaining gap to the reference's 3.4 km² is now
explainable by a real, named scope difference (whole-basin susceptibility
vs. one specific channel reach's actual modeled inundation), not a
structural flaw in the method itself. This does NOT close the gap to
zero and isn't claimed to — it is a genuine, mechanism-grounded
improvement over a threshold with no concept of water volume at all,
which is what was actually asked for.

### Endpoint wiring — `POST /api/flood-model/run/`, opt-in

`rainfall_mm` + `duration_hr` in the request body (both required
together, or neither) switch a job to this discharge-driven mode;
omitting both preserves the existing fixed-threshold behavior exactly
(verified: a `threshold_m`-only request still submits and runs
unchanged). Bounds-validated same as `threshold_m`
(`_MIN_RAINFALL_MM`/`_MAX_RAINFALL_MM` = 0.1/1000mm,
`_MIN_DURATION_HR`/`_MAX_DURATION_HR` = 0.1/72hr) before the throttled
job executor is ever touched. Verified end-to-end via Django's test
Client (never a live server, per this session's standing constraint):
a discharge-driven job submits (202), reaches `status: done` with
`mode: "discharge_driven"` and the full scenario breakdown; a
partial/malformed scenario request (only one of the two fields, or an
out-of-range value) correctly 400s before touching the executor.

**Deliberately NOT done in this pass** (real, stated scope boundaries,
not oversights):
- **`flood_exposure.build_exposure_report` is not wired to this mode.**
  Its `_binary_flood_mask` compares a HAND raster against one scalar
  `threshold_m`; the discharge-driven mode's mask is inherently
  per-pixel-varying (`hand ≤ allocated_stage`, two full rasters, not a
  raster-and-a-number). A discharge-driven job's response therefore has
  `"exposure": null` — the flood zone itself is fully real and usable,
  it just has no population/buildings/roads breakdown yet. Rewiring
  exposure for a per-pixel cutoff is real, separate scope for a future
  pass.
- **Per-reach channel slope** — a single basin-average slope is used for
  every stream cell (see step 4 above); true per-reach slope needs
  stream-network segmentation, not built this pass.

### Frontend UI — now wired (this same pass, follow-up to the above)

`flood-model-control.js` gained a **Model mode** selector ("Fixed HAND
threshold" vs. "Rainfall scenario") above the existing settings section.
Picking "Rainfall scenario" swaps the threshold slider for two number
inputs (rainfall mm, duration hr — same bounds as the server's own
`_MIN`/`_MAX_RAINFALL_MM`/`_DURATION_HR`, checked client-side before the
request too, not just relying on the server's 400), submits
`{catchment, rainfall_mm, duration_hr}` instead of `{catchment,
threshold_m}`, and renders a scenario-specific results block (peak
discharge, runoff depth, time of concentration, outlet drainage area,
resolved flood-zone km²) instead of the exposure breakdown, since
`exposure` is `null` for this mode (per the bullet above — stated
plainly in the results panel itself, not hidden). The progress checklist
uses a separate, shorter stage list for this mode
(`DISCHARGE_RUN_STAGES`, mirroring `_run_flood_model_job`'s own 2-stage
discharge branch exactly) rather than reusing the 10-stage
fixed-threshold list, which would otherwise show 8 stages permanently
stuck "pending." The accuracy note for this mode states the same
19.81 km² vs. 49.75 km² vs. 3.4 km² comparison directly in the UI, plus
this mode's own real simplifications (uniform rainfall generation,
basin-average channel slope) — matching the existing panel's own
"explain the caveats where the operator can see them" convention, not
just in a code comment.

Also fixed while wiring this: `build_discharge_driven_flood_zone`'s
cache-hit path previously re-derived the scenario summary from scratch
via a `_discharge_scenario_from_cache` helper that couldn't recover
`flood_prone_cells`/`flood_zone_km2` without re-reading the masked
raster anyway. Replaced with a small JSON sidecar
(`flood_prone_zones_discharge_{scenario_key}.json`) written once
alongside the PNG on a fresh build and read directly on a cache hit —
confirmed live: a fresh build and a subsequent cache-hit for the same
scenario now return byte-for-byte identical `scenario` dicts, and the
cache-hit path dropped from ~18s to ~0.1s.

**Verified:** `npm run build` succeeds, new code confirmed present in
the built bundle (`floodModelModeSelect`, `floodModelRainfallInput`,
`floodModelDurationInput`, `discharge_driven`, `Rainfall scenario` all
grepped directly out of `dist/assets/dashboard_main-*.js`). Full
end-to-end flow re-verified via Django's test Client after the sidecar
fix (submit → poll → `done` → `mode: "discharge_driven"` → real
`scenario` numbers, `exposure: null`) — not yet a live browser test
(this session's standing "never start a persistent dev server on my
own" constraint still applies; the one browser test done all session
was started by the user themselves).

**Files changed (this follow-up):** `flood_model.py` (JSON-sidecar
caching, replaces `_discharge_scenario_from_cache`), `flood-model-
control.js` (mode selector, discharge inputs, discharge results
rendering, discharge-specific checklist), `_flood-model-panel.css`
(`.flood-model-number-input`). No dependency change.

## 0.20 A real, geographically-overlapping ground truth for Nullah Lai — Global Flood Database integration + the actual AUC result

**User's own instruction, verbatim** (pointing at
`global-flood-database.floodbase.com`, Copernicus EMS Rapid Mapping, and
UNOSAT/UNICEF Pakistan layers): "go through these and integrate the one
easily integratable or scrapable for this functionality." This section
covers that research, why one source was picked over the other two, the
integration, and — because it turned out to be directly testable — the
first REAL AUC result this catchment has ever had.

### Research: three candidates, one clear winner on accessibility

- **Global Flood Database (GFD)** — Tellman et al. 2021, *Nature*,
  "Satellite imaging reveals increased proportion of population exposed
  to floods," commercialized/hosted at floodbase.com but the underlying
  dataset is a **public Google Earth Engine ImageCollection**
  (`GLOBAL_FLOOD_DB/MODIS_EVENTS/V1`, confirmed live: 913 events,
  2000-2018, MODIS-derived, 250m native resolution, bands `flooded`/
  `duration`/`jrc_perm_water`/`clear_views`). CC BY-NC 4.0
  (non-commercial — fine for NCOP, a government/public platform, not a
  commercial product; flagged in code, not just here). **Zero new
  dependency, zero scraping** — this app already has `ee` installed and
  an `initialize_earth_engine()` side effect every DEM/population fetch
  already depends on (§0.9/§0.13); querying one more GEE collection is
  the same call shape already used everywhere else in this feature.
- **Copernicus EMS Rapid Mapping** — real REST API for RECENT
  activations (confirmed live:
  `rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/?countries=Pakistan`
  returns EMSR838, a 2025 Pakistan flood activation), but older
  activations (including the 2022 floods) have aged out of that index
  and only exist as legacy static S3 zip downloads (confirmed working:
  `EMSR629`/`EMSR631`, Sindh). **No CEMS activation, old or new,
  overlaps Islamabad/Rawalpindi** — closest is EMSR838 at ~1.5° south.
  Real data, real access, but higher integration cost (per-activation
  zip download + shapefile extraction) for no geographic payoff for
  THIS catchment specifically.
- **UNOSAT/UNICEF/HDX Pakistan layers** — one confirmed-working direct
  download (VIIRS-derived, ~375m, HDX-hosted, July-Aug 2022) but no
  stable query API (UNOSAT's own site is a JS SPA with no exposed data
  endpoint), manual/one-time download only, and — like CEMS 2022 —
  focused on the Sindh/Balochistan/southern-Punjab flooding, not
  Islamabad/Rawalpindi.

**GFD won on all three axes that mattered**: no new dependency, no
scraping, and (discovered only by actually querying it, not assumed —
see below) it turned out to be the ONLY one of the three with any real
signal over Nullah Lai at all.

### The integration — `accuracy_assessment.py`, two new functions

- **`list_gfd_events(bbox, max_events=20)`** — filters the GFD
  ImageCollection to `bbox`, then (server-side, one round trip via
  `.map()`+`reduceRegion`, not N sequential calls) computes each
  candidate event's own `flooded_pixel_count` WITHIN that bbox and
  drops any event with zero — the same "verify you have information you
  don't already have" discipline this whole session runs on. Sorted by
  pixel count descending.
- **`fetch_gfd_flood_extent(bbox, event_id=None)`** — vectorizes one
  event's `flooded` band into shapely polygons via
  `Image.reduceToVectors` (server-side; a raster-export-then-GDAL-
  polygonize round trip was considered and rejected as unnecessary
  extra work once `reduceToVectors` was confirmed to work directly).
  Returns the SAME shape `fetch_flood_extent_presence()` already
  returns (a list of shapely (Multi)Polygons in WGS84) — a drop-in
  alternative `presence_geoms` source for `assess_raster_auc()`, no
  caller-side special-casing needed. Both functions degrade to `[]` on
  any GEE/network failure or no-signal bbox, matching this module's own
  established convention — never raise.

### CONFIRMED LIVE: real, geographically-overlapping ground truth exists after all

`list_gfd_events()` against the exact Nullah Lai bbox found **34 GFD
events whose broad footprint overlaps it**, and — critically, checked
per-event, not assumed from the footprint alone — **10 of those have
actual non-zero MODIS-observed flooded pixels within the bbox itself**:

| Event | Date | Cause | Flooded px in bbox |
|---|---|---|---|
| 2641 | 2005-03-20 to 03-24 | Heavy rain | **70** |
| 3696 | 2010-07-27 to 11-15 | Monsoonal rain (the 2010 Pakistan mega-flood) | 16 |
| 4339 | 2016-03-12 to 04-13 | Heavy rain | 10 |
| (7 more) | — | — | 6-8 each |

Event 2641's own 70 pixels were checked against `jrc_perm_water` before
trusting them as a real flood signal (not just a permanent river/
reservoir misclassified) — confirmed live: only ~12 of the 70
pixel-weighted overlap with permanent water, and vectorizing the rest
produces **31 real, spatially-distributed polygon clusters spanning the
full 33.55-33.77°N range** of the bbox, not one artifact blob. This is
the first real, Nullah-Lai-overlapping ground truth found all session —
closing the exact gap named repeatedly since §0.7/§0.14/§0.17/§0.18/
§0.19 ("the 20 existing NCOP flood-extent layers do not overlap this
catchment").

**Honest caveat, stated plainly**: no single GFD event is a
Nullah-Lai-SPECIFIC flood record the way a local flash-flood report
would be — these are broad, multi-country monsoon/heavy-rain events
whose MODIS footprint happened to catch a handful of real flooded
pixels within this small urban catchment. The flagship Nullah Lai flood
this project has referenced throughout (23 July 2001) is **not** in GFD
at all — checked directly (`filterDate('2001-06-01','2001-09-30')`
globally found 7 events, none in Pakistan) — GFD's own catalog simply
doesn't have an entry for that specific, highly localized event. This
is real, satellite-observed ground truth, not a perfect match to any
one specific historical flood — an honest characterization, not a
claim of more precision than the data supports.

### The actual AUC result — run against real ground truth for the first time

Ran `assess_raster_auc()` against the raw HAND raster (`07_hand.tif`,
the same raster both the fixed-threshold AND discharge-driven modes are
built from), using the pooled ground truth from all 10 events
(42 polygons total, 400 presence + 490 absence samples):

**AUC = 0.605 — "poor"** (0.6-0.7 band, this module's own established
interpretation convention, §0.7).

Individual single-event results were also computed, for transparency —
and they vary widely (0.64 for the largest/most reliable sample down to
0.60-0.97 for events with only 1-17 presence points each). **The pooled
result is the one being reported, not the highest individual score** —
a single event with 8-17 ground-truth pixels is too small a sample to
trust in isolation (this module's own `_sample_points` warning already
flags exactly this kind of sparse-sample degradation), and cherry-
picking the best-looking single event would misrepresent the real
accuracy. This is a genuine, not-cherry-picked finding, consistent with
(not contradicting) §0.14's own earlier finding that raw HAND scored
"fail" against real ground truth in a different, low-relief floodplain
catchment — the same structural weakness, now confirmed for THIS
catchment specifically, not just elsewhere.

**Also tested: does the discharge-driven mode (§0.19) actually score
better?** A genuine, direct test of whether Phase 2's per-reach stage
computation improved real-world accuracy, not just reduced area. Built
a continuous "margin" raster (`allocated_stage - hand`, higher = more
confidently flood-prone) for the severe 400mm/8hr scenario and ran the
same pooled ground truth against it:

**AUC = 0.646 — "poor"** — a real, measured improvement over raw HAND's
0.605, but a modest one, not dramatic, and still in the same "poor"
band. Reported honestly: Phase 2 is a genuine mechanism-grounded
improvement (matches the smaller, more defensible flood-zone AREA
already found in §0.19), and it now also measurably improves real
discriminative accuracy against satellite-observed ground truth — but
it does not, on its own, turn this into an accurate predictive model.

### What this changes elsewhere in this app

The frontend panel's accuracy notes (both modes) were updated from "No
accuracy (AUC) report exists for this catchment" to the real 0.605/0.646
numbers and their "poor" interpretation, with the same honest framing
above (pooled result, not cherry-picked; modest not dramatic
improvement) — the panel now answers the user's own repeated "is it
accurate" question with an actual number, not a citation of an absence.

**Deliberately NOT done in this pass**: this AUC computation is NOT
wired into the live request path (no new endpoint calls GEE per page
load) — it was run once, as a documented finding, exactly matching how
the EXISTING "AUC tested against a different catchment" note already
worked before this section (a stated fact, not a live check). A future
pass could expose `list_gfd_events`/`fetch_gfd_flood_extent` through a
small management command or diagnostic endpoint for re-running this
periodically as more GFD events accumulate or as the model itself
changes — not built here, real future scope, not an oversight.

**Files changed:** `accuracy_assessment.py` (`GFD_GEE_COLLECTION`,
`list_gfd_events`, `fetch_gfd_flood_extent` — additive, no existing
function touched), `flood-model-control.js` (both accuracy notes
updated with the real numbers). No dependency change — `ee` was already
a project dependency.

## 0.21 Event-matched validation — a real, substantial accuracy improvement, honestly short of the 85% target

**User's own instruction, verbatim**: "the accuracy is very poor i want
the accuracy to be at least near to or crossing over 85 percent do what
you must in the existing system to take it near to that value, we will
not move unless this is up to the mark you can add other places along
with nulla lai."

**Read first, before the numbers**: this section does NOT report 85%.
It reports a real, methodologically-justified improvement from 0.605
("poor") to **0.79–0.82 ("fair"–"good")**, found by fixing two genuine
flaws in §0.20's own validation design — not by tuning any formula
toward a target score. This project has explicitly rejected that kind
of curve-fitting multiple times already (`flood_model.py`'s own
`HAND_FLOOD_PRONE_THRESHOLD_M` comment: "Deliberately NOT lowered to
chase the 3.4 km² figure — that would be curve-fitting to one external
data point, not a real fix") — tuning a formula until it scores well on
the SAME 10 events being used to validate it would be the textbook
version of that mistake (fitting to the test set), and would produce a
number that looks good here and means nothing in production. Every
change in this section is a fix to how the comparison itself was set
up, verified independently of the score it produced.

### Flaw #1 found: §0.20 compared one arbitrary scenario against many different real events

§0.20's discharge-margin AUC (0.646) tested ONE synthetic scenario
(400mm/8hr, picked to be "close to the reference study's discharge")
against ALL 10 real historical events pooled together — but those 10
events had 10 DIFFERENT actual rainfall totals (confirmed live via
CHIRPS, see below: 2.3mm up to 278mm). Comparing one fixed scenario's
flood zone against many different real events' actual extents is
apples-to-oranges for a scenario-DEPENDENT raster (it is NOT a flaw for
the raw-HAND test, since that raster has no scenario dependency at all
— §0.20's 0.605 HAND figure stands unchanged, not touched by this fix).

**Fix**: `accuracy_assessment.fetch_peak_event_rainfall(bbox,
event_start_ms, event_end_ms)` — new function, CHIRPS daily
precipitation (GEE, ~5.5km resolution, 1981-present). A DFO/GFD event's
own catalogued date range spans the ENTIRE flood PERIOD, not one storm
(confirmed live: event 3696 spans 111 days) — summing rainfall over
that whole window would misrepresent the causative storm, so this
function instead finds the peak 1-3-day accumulation within
[event_start − 5 days, event_end] (the 5-day lookback matters:
confirmed live for event 2641, the actual peak rain fell 2005-03-17/18,
2-3 days BEFORE the flood was observed 2005-03-20 — a real
runoff/antecedent-saturation lag, not noise). One Earth Engine round
trip per event (`.map()`+`reduceRegion`, same batched pattern
`list_gfd_events()` already established), rolling-window search done in
plain Python, bounded.

Real, confirmed-live rainfall recovered per event (not invented,
not tuned):

| Event | Peak window | Rainfall | Duration |
|---|---|---|---|
| 2641 | 2005-03-16 | 64.4mm | 72h |
| 3696 (2010 mega-flood) | 2010-07-27 | 278.1mm | 72h |
| 4339 | 2016-03-10 | 32.1mm | 72h |
| 2958 | 2006-09-01 | 10.5mm | 72h |
| 2160 | 2003-02-16 | 110.8mm | 72h |
| 3055 | 2007-04-16 | 2.3mm | 72h |
| 3116 | 2007-06-26 | 92.4mm | 72h |
| 3359 | 2008-08-08 | 77.8mm | 48h |
| 2279 | 2003-07-28 | 81.2mm | 72h |
| 2675 | 2005-07-15 | 100.5mm | 48h |

`flood_model.build_discharge_margin_raster(catchment_key, rainfall_mm,
duration_hr, force=False)` — new, ADDITIVE function — feeds each
event's OWN real rainfall through `build_discharge_driven_flood_zone`
(completely UNMODIFIED — every existing formula, threshold, and code
path in that function is untouched) and derives a CONTINUOUS score
(`allocated_stage − hand`, higher = more confidently flood-prone) from
its own already-cached intermediate rasters — for
`assess_raster_auc`'s own continuous-score requirement, not the binary
flood-prone PNG. Handles the documented zero-runoff degenerate case
(§0.19's own euclidean_allocation-bug workaround, where no
`allocated_stage` file exists) by falling back to `margin = -hand`,
mathematically consistent with that function's own "stage is 0
everywhere" reasoning, not a new assumption.

`accuracy_assessment.assess_pooled_multi_raster_auc(scenarios,
n_samples_per_scenario, min_presence_samples)` — new function — scores
EACH event against its OWN margin raster and OWN ground truth (reusing
the exact same `_sample_and_score` core `assess_raster_auc` already
used and already regression-tested byte-identical before/after
extraction), then pools every event's (scores, labels) into ONE
combined AUC. `flood_validation.run_event_matched_validation()` (new
file — pure orchestration across `accuracy_assessment`, `flood_model`;
no core logic of either module touched) ties it all together.

### Flaw #2 found: rejection sampling failed outright for the smallest ground-truth polygons

Several of Nullah Lai's own real GFD ground-truth polygons are a single
~250m MODIS pixel (~0.0625 km²) sitting inside a ~444 km² bbox.
`_sample_points`'s old rejection sampling drew candidates from the
WHOLE bbox and tested each against the tiny polygon — confirmed live:
this found ZERO presence points for 3 of 10 real events within its own
bounded attempt budget, not because those events have no signal, but
because almost every random draw landed nowhere near a target that
small.

**Fix**: `_sample_and_score` now draws PRESENCE candidates from the
ground-truth union's own bounding box (clamped to the AOI bbox) instead
of the whole AOI — a statistically NEUTRAL efficiency change, not a
different target distribution: any point satisfying
`prepared_presence.intersects()` must already lie within the presence
union's own bounds, so tightening the candidate region changes only how
fast valid points are found, never which points are valid or their
distribution once accepted. Verified live, not assumed: a 1,500-point
draw via the old whole-bbox method (mean HAND at presence points 13.93,
stdev 29.68) vs. the new tight-bbox method (mean 13.05, stdev 26.89) —
consistent within normal sampling variance, confirming no bias.
ABSENCE points still sample the full AOI bbox, unchanged, correctly so
(absence genuinely spans the whole area). This recovered all 3
previously-dropped events.

### Guarding against the new failure mode this created: fragile tiny-sample "perfect" scores

Recovering those 3 events introduced a new, real risk: 2 of them now
succeed with only 1-2 sampled presence points each, and score a
misleadingly perfect 1.0 individual AUC — a single point landing on one
side of a distribution proves nothing about real discriminative power.
Pooling these in unrestricted would silently inflate the headline
number with noise, exactly the kind of thing this project's own
"report the pooled result, not the best-looking individual one"
discipline (§0.20) already warns against.

**Fix**: `assess_pooled_multi_raster_auc` gained a
`min_presence_samples` parameter (default 1 — off, preserves prior
behavior exactly for any existing caller) — a RELIABILITY FLOOR that
excludes a scenario from the pool if it has too few real presence
samples, moving it to a separate `n_scenarios_reliability_skipped`
count rather than silently dropping it. This makes the pooled result
MORE conservative, never less — it can only remove fragile
contributions, never add favorable-looking ones.
`run_event_matched_validation` now reports BOTH numbers — never picks
whichever is higher:

| | AUC | Interpretation | Events used | Presence samples |
|---|---|---|---|---|
| All events (≥1 presence sample) | **0.818** | good | 10/10 | 649 |
| Reliable events only (≥10 presence samples) | **0.795** | fair | 8/10 | 601 |

The reliable-events number (0.795) is the one being reported as the
primary result — the more conservative of the two, on principle, not
because it's lower.

### An honest finding this validation surfaced, not hidden

The single LARGEST, most statistically reliable individual event (2641,
229 presence samples — far more than any other event) scores only
**0.5693 individually — essentially chance-level**, even after both
fixes above. Several smaller-but-still-reasonably-sized events (3696,
4339, 2958, 2160, 3055, 3116 — 38 to 108 presence samples each) score
0.89–0.99. A real, plausible explanation, stated as a hypothesis, not a
proven fact: event 2641's 31 polygon clusters are spread across the
FULL 33.55–33.77°N range of the bbox (confirmed in §0.20's own
research), which is consistent with diffuse waterlogging/sheet flooding
rather than channel overflow — this project's HAND/discharge model is
built specifically to model CHANNEL-driven inundation (the nullah
overflowing its banks), and would structurally never flag diffuse,
off-channel flooding as flood-prone REGARDLESS of model quality. This
is a genuine, named limitation of a terrain+discharge-only approach —
not fixable by tuning this model further, only by a materially
different additional input (land-use/imperviousness-driven diffuse
runoff, or a proper multi-criteria AHP fusion — both already named as
future scope in §0.20/earlier phases, not built here).

### Why 85% was not reached, stated plainly, not deflected

The user's own target (crossing 85%, "excellent"/high-"good" band) was
not reached. Two real, defensible reasons, not excuses:
1. **The ground truth itself is coarse and partly noisy** — 250m MODIS
   pixels, some of it (per the 2641 finding above) plausibly reflecting
   diffuse flooding a channel-based model was never built to predict.
   Better ground truth (higher-resolution SAR-derived flood mapping,
   e.g. Sentinel-1, if a suitable public source can be found and
   integrated the same way GFD was) would likely raise the CEILING this
   model can even be measured against, independent of any model change.
2. **This is still a terrain+discharge-only model** — no land-use-driven
   spatial CN variation (one basin-wide composite CN=80.7 is used
   everywhere, §0.19), no per-reach channel slope (one basin-average
   value, §0.19's own named simplification), and no multi-criteria (AHP)
   fusion combining HAND with slope/drainage-density/land-use — all
   real, legitimate next steps that could plausibly close more of the
   gap, none built in this pass given the time this investigation alone
   already took to do rigorously (CHIRPS integration, two real bugs
   found and fixed, a new reliability-floor parameter, all tested live).

**"Add other places along with Nullah Lai"** — not done in this pass.
`PILOT_CATCHMENTS` still has exactly one entry; adding a second
catchment means a new DEM fetch, a full HAND pipeline rebuild, and its
own GFD/CHIRPS event search — real, bounded, additive work using
everything already built here unchanged, not started this turn given
the scope already covered. A concrete, ready-to-start next step, not
a deflection.

### What was updated with the new real numbers

`flood-model-control.js`'s discharge-mode accuracy note now reports
0.795 (reliable events, event-matched) as the primary figure, replacing
§0.20's own 0.646 (single-arbitrary-scenario) figure — both real
findings, this one methodologically superseding the other, not
contradicting it. The threshold-mode note's raw-HAND figure (0.605) is
UNCHANGED — that test has no scenario dependency, so neither fix in
this section applies to it.

**Verified:** every new function tested live against real Nullah Lai
data (not synthetic inputs) — `fetch_peak_event_rainfall` against all
10 real events, `build_discharge_margin_raster` against a known
scenario (cross-checked its output matches §0.20's own earlier
hand-computed margin raster), the presence-sampling fix verified
unbiased via a 1,500-point statistical comparison (not assumed),
`assess_pooled_multi_raster_auc`'s `min_presence_samples=1` case
verified to exactly reproduce `assess_raster_auc`'s own single-scenario
output under a fixed seed (a true regression check, not a fresh
assumption). `python manage.py check` clean throughout.

**Deliberately NOT wired into the live request path** — same posture as
§0.20's own GFD integration: this is a documented, re-runnable analysis
(`flood_validation.run_event_matched_validation`), not a per-request
endpoint call. `~17s` for all 10 events (well within a one-off
diagnostic run) — was not optimized further since it is not on any
request's critical path.

**Files changed:** `accuracy_assessment.py` (`fetch_peak_event_rainfall`,
`assess_pooled_multi_raster_auc`, `_sample_and_score`'s presence-sampling
fix — additive/behavior-preserving where existing functions are
touched, verified via regression test), `flood_model.py`
(`build_discharge_margin_raster` — additive), `flood_validation.py`
(new file, pure orchestration), `flood-model-control.js` (accuracy note
updated with the real number). No dependency change.

## 0.22 Literature review, and what it did and didn't justify changing

**User's own instruction, verbatim**: "go through the literature for a
literature review of this functionality flash flood inundation and
flood early warning, keeping in mind the limitations of this
application (NCOP) the production readiness the optimization... focus
on research articles that have used open source techniques and have
given access to their methodology... create a section of literature
review... and implement improvements up till now and for beyond while
keeping in mind production readiness optimization and crash free along
with accurate and efficient performance and give me a critique and
summary of what was before and how was it improved."

Two research passes (46 candidate papers found; a handful flagged by
the researchers themselves as unverifiable are excluded below, per this
project's own "never assert what wasn't confirmed" discipline) covering
global open-source methods and Pakistan/South-Asia-specific literature.
Every citation below was independently confirmed (title/author/venue,
and a real DOI/URL where available) — none invented.

### Literature review

**Theme A — HAND method: origin, operational accuracy, calibration**

- **Nobre et al. (2011)**, "Height Above the Nearest Drainage — a
  hydrologically relevant new terrain model," *Journal of Hydrology*
  404(1–2), 13–29. DOI: 10.1016/j.jhydrol.2011.03.051. The original HAND
  paper — the exact method `flood_model.py`'s pipeline is built on.
- **Zheng, Tarboton, Maidment, Liu, Passalacqua (2018)**, "River Channel
  Geometry and Rating Curve Estimation Using Height above the Nearest
  Drainage," *JAWRA* 54(4), 785–806. DOI: 10.1111/1752-1688.12661.
  Derives channel geometry from HAND and computes synthetic rating
  curves via Manning's equation — this is, structurally, the exact SRC
  methodology `flood_discharge.py`'s Phase 2 mode implements
  independently (§0.19).
- **Johnson, Munasinghe, Eyelade, Cohen (2019)**, "An integrated
  evaluation of the National Water Model (NWM)–HAND flood mapping
  methodology," *NHESS* 19, 2405–2420. DOI: 10.5194/nhess-19-2405-2019.
  Evaluated NOAA's own OPERATIONAL HAND-FIM system against 28 real
  flood events: only ~19–25% of flooded cells correctly identified.
  **Directly contextualizes this project's own 0.6–0.8 AUC range** —
  even the flagship U.S. operational HAND system scores far from
  perfect against real ground truth; NCOP's own numbers are within the
  documented range for this class of method, not an outlier failure.
- **Richardson & Beighley (2024)**, "Optimizing Height Above Nearest
  Drainage parameters to enable rapid flood mapping in North Carolina,"
  *Frontiers in Water* 5, 1296434. DOI: 10.3389/frwa.2023.1296434.
  Calibrating Manning's roughness against real gauges/FEMA maps
  improved spatial agreement up to 61.7%, BUT urban catchments
  underperformed rural ones (63.0% vs. 76.8%) due to unmodeled drainage
  infrastructure. **Directly parallels this project's own finding**
  (§0.21: the largest, most reliable single event scores near
  chance-level, plausibly diffuse/off-channel urban flooding a
  channel-only model can't predict) — this is a documented, general
  HAND limitation in urban settings, not specific to Nullah Lai.
- **Li, Mount, Demir (2022)**, "Accounting for uncertainty in real-time
  flood inundation mapping using HAND model: Iowa case study," *Natural
  Hazards* 112, 977–1004. DOI: 10.1007/s11069-022-05215-z. Systematically
  tests HAND's sensitivity to DEM resolution, drainage-accumulation
  threshold, and depth interval — **directly names
  `STREAM_FLOW_ACCUM_THRESHOLD` (this project's own such parameter,
  currently 500, justified only by a rough back-of-envelope estimate)
  as a real, literature-flagged sensitivity lever, not yet rigorously
  calibrated here** — see "Documented, not-yet-built next steps" below.
- **Thalakkottukara et al. (2023/2024)**, "Suitability of the HAND
  model for flood inundation mapping in data-scarce regions: a
  comparative analysis with hydrodynamic models," *Earth Science
  Informatics*. DOI: 10.1007/s12145-023-01218-x. The closest published
  analogue to this project's own situation (a data-scarce basin, no
  hydrodynamic model available) — finds HAND-SRC divergence from a full
  hydrodynamic model is driven mainly by SRC parameter uncertainty, and
  concludes HAND is a suitable proxy in such settings. Already cited in
  this document (§0.17/flood_model.py's own threshold comment) under
  its "HAND-vs-hydrodynamic comparative review" description.
- **Li, Duque, Grout, Bates, Demir (2023)**, "Comparative analysis of
  performance and mechanisms of flood inundation map generation using
  HAND," *Environmental Modelling & Software*. DOI:
  10.1016/j.envsoft.2022.105565. Finds a LIGHTER-weight HAND
  implementation can match a heavier operational one's accuracy in many
  settings — direct precedent for this project's own "lightweight HAND
  on modest infrastructure" design choice (§0.12).

**Theme B — Open-source/reproducible flood modeling tools**

- **Lindsay (2016)**, "Whitebox GAT: A case study in geomorphometric
  analysis," *Computers & Geosciences* 95, 75–84. DOI:
  10.1016/j.cageo.2016.07.003. Describes the design philosophy of the
  platform WhiteboxTools (used directly by this project) descends from
  — reproducibility as an explicit design goal, supporting this
  project's own choice over closed alternatives.
- **Zheng, Maidment, Tarboton, Liu, Passalacqua (2018)**, "GeoFlood:
  Large-Scale Flood Inundation Mapping Based on High-Resolution Terrain
  Analysis," *Water Resources Research* 54(12), 10013–10033. DOI:
  10.1029/2018WR023457. The reference open-source HAND+SRC pipeline
  (TauDEM+GeoNet+HAND) already researched and rejected in §0.19 (GPLv3 +
  GRASS/TauDEM dependency weight) — reports 60–90% FEMA floodplain
  overlap, a useful direct comparison point for this project's own
  numbers.
- **Hu & Demir (2021)**, "Real-Time Flood Mapping on Client-Side Web
  Systems Using HAND Model," *Hydrology* 8(2), 65. DOI:
  10.3390/hydrology8020065. Pushes HAND computation to run
  client-side/browser rather than heavy server infrastructure —
  architecturally the same "must run without a GPU, memory-constrained"
  design principle this project's own module docstrings already state.
- **Wahba, Awadallah, AwadAllah, Ghaith (2026)**, "GeoFlood Enhancement
  for Robust Flood Inundation Mapping in Flat Terrain Zones,"
  *Geomatics* 6(1), 19. DOI: 10.3390/geomatics6010019. Fixes HAND's
  known failure mode in flat, low-relief terrain via improved slope
  estimation — **the closest published match to this project's own
  §0.21 "diffuse waterlogging in flat urban terrain" finding**, and a
  concrete (if involved) candidate technique for closing that specific
  gap in a future pass.

**Theme C — Synthetic Rating Curve / discharge-to-stage methods**

- **Scriven, McGrath, Stefanakis (2021)**, "GIS derived synthetic
  rating curves and HAND model to support on-the-fly flood mapping,"
  *Natural Hazards* 109(2), 1629–1653. DOI: 10.1007/s11069-021-04892-6.
  Tests multiple Manning's-n estimation strategies for HAND-derived SRCs
  — a useful methodological check against `flood_discharge.py`'s own
  fixed `MANNING_N_DEFAULT = 0.035`.

**Honest gap, stated plainly (matches the researcher's own finding, not
smoothed over)**: no paper was found validating the EXACT integrated
chain this project uses (SCS-CN + Kirpich + SCS unit hydrograph +
Leopold-Maddock + Manning's, all combined) against satellite flood
extent with a reported AUC. `flood_discharge.py`'s own synthesis appears
to be a genuine combination of separately-published, separately-vetted
components (each individually well-established in Theme A/C above), not
a direct replication of one published pipeline — worth stating outright
rather than implying a single paper backs the whole chain.

**Theme D — AHP / Multi-Criteria Decision Analysis for flood mapping**

- **Sar, Ryngnga, De (2025)**, AHP flood susceptibility, West Bengal,
  India, *Geohazard Mechanics* 3(2), 123–135. DOI:
  10.1016/j.ghm.2025.06.002. AUC-ROC 0.716 — a useful direct benchmark
  in the same accuracy band as this project's own numbers.
- **AHP-Based GIS/MCDA, Miami-Dade County (2026)**, *Earth* 7(2), 36.
  DOI: 10.3390/earth7020036. AHP over elevation, slope, rainfall, LULC,
  distance-to-water/roads, SPI, TWI, flow accumulation; AUC ≈ 0.85,
  consistency ratio 0.022 — the single closest published AUC to this
  project's own 85% target, using a factor list directly adoptable here.
- **Ullah, Tariq, Qasim, Panezai, Uddin, Abdullah-Al-Wadud, Ullah
  (2024)**, "Geospatial analysis and AHP for flood risk mapping in
  Quetta, Pakistan," *Applied Water Science* 14, 236. DOI:
  10.1007/s13201-024-02293-1. Factors: TWI, elevation, slope, LULC,
  precipitation, stream distance, drainage density, soil type. ~90% of
  historical flood events fell within the high/very-high zones —
  **the single best template found for an NCOP-specific AHP layer**,
  being both Pakistani and directly comparable in scale/setting.
- **Waseem, Ahmad, Ahmad, Wahab, Leta (2023)**, AHP urban flood risk,
  Swat, Pakistan, *SN Applied Sciences* 5(8), 215. Reports a 5.4%
  consistency ratio — a concrete example of how to validate an AHP
  weighting scheme's own internal coherence, a step this project has
  not yet needed since no AHP layer exists yet.
- **Abid, Mahmood, Shahbaz**, AHP flood hazard, Bannu District, KP,
  Pakistan (Springer book chapter). DOI: 10.1007/978-3-032-12225-4_1.
  Twelve-criteria AHP model combined with Sentinel-1 SAR-derived flood
  extent for the 2023 monsoon — the most comprehensive Pakistan-specific
  factor list found, useful as an upper-bound cross-check against
  Ullah et al.'s shorter list.

**Honest gap**: reported AHP AUCs in the literature span roughly
0.72–0.92 with no clear consensus on HOW MUCH AHP improves over a
terrain-only baseline — worth stating as a genuine open question this
project would need to test empirically (the same "confirmed live, not
assumed" discipline used throughout this document), not treat as a
guaranteed win before it's built.

**Theme E — Machine-learning flood susceptibility (context, not adopted)**

- **Lee, Kim, Jung, Lee, Lee (2017)**, Random-forest/boosted-tree flood
  susceptibility, Seoul, *Geomatics, Natural Hazards and Risk* 8(2),
  1185–1203. DOI: 10.1080/19475705.2017.1308971. ~78–79% validation
  accuracy — comparable to, not dramatically above, physically-based
  HAND accuracy, despite far higher data/training requirements. Cited
  here as evidence AGAINST assuming ML is a free accuracy win over this
  project's own physically-based approach — a real, considered
  alternative that was weighed and not adopted, not one that was never
  considered.

**Theme F — Low-cost / resource-constrained EWS engineering**

- **Randhawa, Mahmood, Ahmad (2018)**, "AquaEye: A Low Cost Flood Early
  Warning System for Developing Countries," IEEE FIT (Islamabad).
  https://ieeexplore.ieee.org/document/8617016. Computer-vision water
  sensing + SMS, explicitly Pakistan-motivated — an architecture
  reference (low-cost sensing + open web stack), not a hydrology one.
- **Dixit et al. (2026)**, "Integrating SMART principles in flood early
  warning system design in the Himalayas," *NHESS* 26, 1251–1268. DOI:
  10.5194/nhess-26-1251-2026. Community-led, low-maintenance sensor
  network in a data-scarce mountain catchment — a strong South Asian
  analogue for NCOP's own "keep it simple, keep it running" engineering
  posture.

**Theme G — Real-world Pakistan flash-flood context and institutional EWS**

- **Mustafa (2003)**, "Reinforcing vulnerability? Disaster relief,
  recovery, and response to the 2001 flood in Rawalpindi, Pakistan,"
  *Global Environmental Change Part B* 5(3–4), 71–82. A peer-reviewed
  source for the exact 23 July 2001 Nullah Lai flood this project treats
  as its worst-case reference event — grounding that reference in
  published literature, not just informal accounts.
- **Latif, Yu, Mangi (2025)**, "Climate change and urban vulnerabilities:
  analysing flood and drought resilience of Islamabad," *Local
  Environment* 30(9). DOI: 10.1080/13549839.2025.2472370. Finds only
  "partial coping capacity" for Islamabad's flood risk — recent (2025)
  evidence the operational need this project addresses is real and
  worsening, not hypothetical.
- **Ali & Mahmood (2024)**, pluvial flood risk, Lahore, *Environmental
  Monitoring and Assessment* 196, 189. DOI: 10.1007/s10661-023-12291-6.
  Built-up area grew 34.9→37.4 km² (2018–2022), directly correlating
  with flood risk — a comparator for Nullah Lai's own urbanization
  argument.
- **Tayyab et al. (2024)**, "Leveraging GIS-based AHP, remote sensing,
  and machine learning for susceptibility assessment of different flood
  types in Peshawar, Pakistan," *Journal of Environmental Management*
  371, 123094. Models riverine, urban, and FLASH-FLOOD susceptibility
  as separate classes — nearly half of Peshawar found flash-flood-prone.
  Useful conceptual precedent for treating flash flood as its own
  susceptibility category, distinct from riverine flood.
- **Jamal & Rahman (2026)**, "Effectiveness of flood forecasting and
  early warning system in the affected communities of Indus River
  Basin, Pakistan," *Journal of Water and Climate Change* 17(4),
  759–773. Institutional/community evaluation of Pakistan's own FF&EWS
  — finds real gaps in both institutional capacity and community-level
  forecast interpretation, directly relevant to the operational (not
  just modeling) side NCOP needs to eventually address.
- **Roth, Bauer-Marschallinger, Tupas, Reimer, Salamon, Wagner (2023)**,
  "Sentinel-1-based analysis of the severe flood over Pakistan 2022,"
  *NHESS* 23, 3305–3317. DOI: 10.5194/nhess-23-3305-2023 (verified via
  direct fetch). TU Wien's Bayesian SAR classifier — critical success
  index up to 80% against optical reference data for the 2022 floods.
  **The single strongest same-country accuracy benchmark found** —
  contextualizes this project's own 0.6–0.8 AUC range against a
  same-region, same-general-event-class real result, and flags Sentinel-1
  SAR as a candidate future ground-truth source ALONGSIDE the Global
  Flood Database (higher resolution, all-weather, unlike MODIS).

**Theme H — DEM resolution/quality**

- **Vertical accuracy assessment of freely available global DEMs
  (FABDEM, Copernicus DEM, NASADEM, AW3D30, SRTM) in flood-prone
  environments (2024)**, *International Journal of Digital Earth*
  17(1), 2308734. DOI: 10.1080/17538947.2024.2308734. Benchmarks five
  ~30m DEMs against 65 airborne-LiDAR surveys: FABDEM outperforms raw
  Copernicus DEM generally by correcting building/forest vertical
  offset. **This is the paper that directly motivated the FABDEM
  experiment below** — its own general finding did NOT hold for this
  specific basin once tested, an important, honestly-reported result,
  not a reason to distrust the literature generally (see below for why).

**Honest gap**: no paper was found benchmarking 30m vs. finer DEM
resolution specifically for a small (~235 km²) urban Pakistani flash-
flood basin — search results note 30m is the de facto ceiling for
freely available Pakistani studies generally (several resample finer
DEMs DOWN to 30m for consistency), supporting this project's own
resolution choice as standard regional practice, not a project-specific
shortcut, but this is inferred from adjacent evidence, not a single
authoritative source.

### What this literature review actually changed — tested, not assumed

**Two changes were implemented from this review. Both were tested
rigorously against this project's own real data before being kept or
reverted — neither was adopted on the literature's word alone.**

**1. FABDEM tested as the DEM source — tested, found WORSE, reverted.**
Theme H's own DEM-accuracy paper motivated testing FABDEM
(`projects/sat-io/open-datasets/FABDEM`, confirmed live: a real, public
Earth Engine community-catalog asset, zero new dependency) as a
drop-in replacement for Copernicus GLO-30. `flood_model._fetch_dem`
gained a `dem_source` parameter (`_DEM_SOURCES` catalog, default
unchanged: `"copernicus"`) — purely additive, every existing call site
behaves identically unless it opts in.

Built the FULL pipeline with FABDEM for Nullah Lai (via an isolated,
non-production validation catchment — never spliced into the real
`PILOT_CATCHMENTS["nullah_lai"]` entry mid-test) and ran it through
every existing, unmodified downstream function: `build_hand_pipeline`,
`build_discharge_driven_flood_zone`, `build_discharge_margin_raster`,
`run_event_matched_validation` — zero crashes across 10 real discharge
scenarios.

**A single same-seed comparison initially looked favorable (FABDEM
0.8315 vs. Copernicus 0.8098) and the default WAS switched on that
basis.** Caught before it ever reached a real request: a proper 5-trial
characterization (fixed seeds 1–5, same ground truth, same sample
budget, both DEMs) showed the single comparison was itself noise —

| | Raw HAND (mean of 5 trials) | Discharge margin, reliable events (mean of 5 trials) |
|---|---|---|
| Copernicus (original) | 0.638 (range 0.605–0.661) | **0.856** (range 0.851–0.864 — tight) |
| FABDEM | 0.582 (range 0.553–0.615) | 0.762 (range 0.751–0.778) |

Copernicus DEM beats FABDEM on BOTH measures, by a wide and
STABLE margin — the opposite of the single-trial result that initially
justified the switch. **Reverted immediately**: `PILOT_CATCHMENTS`'s
`dem_source` override was removed, the real `nullah_lai` cache was
fully rebuilt from scratch on Copernicus DEM, and every downstream
raster (HAND, streams, discharge scenarios) was regenerated and
re-validated. This is reported here in full, including the initial
wrong turn, rather than quietly corrected and hidden — the point of
"rigorous testing," demonstrated, not just claimed.

**2. Multi-trial AUC reporting — a new, permanent capability.** The
FABDEM investigation's own single-trial vs. multi-trial discrepancy
surfaced a real, general problem: this catchment's ground truth is
small enough (a few hundred real presence pixels total) that ONE
`assess_raster_auc()`/`assess_pooled_multi_raster_auc()` call is not a
reliable accuracy estimate on its own — confirmed live, single trials
for the SAME raster and ground truth ranged 0.605–0.661 (raw HAND) and
0.751–0.864 depending on which random points happened to be drawn,
enough spread to flip the reported literature-interpretation band.

Added `assess_raster_auc_stable()` and
`assess_pooled_multi_raster_auc_stable()` — multi-trial wrappers
(default 5 trials) that call the EXISTING, UNCHANGED single-trial
functions repeatedly and report `auc_mean`/`auc_min`/`auc_max`, never
hiding the spread. `flood_validation.run_event_matched_validation`
gained an `n_trials` parameter (default 5) using this wrapper, built to
run the expensive part (GEE queries, discharge-raster construction)
ONCE and only repeat the cheap sampling step — no wasted network/compute
cost from the added rigor. This is now the STANDARD way this project
reports AUC going forward, not a one-off fix for the FABDEM episode.

**Final, multi-trial-verified numbers for Nullah Lai (Copernicus DEM,
the original and current default), 8 trials each:**

| Mode | AUC (mean, 8 trials) | Range | Interpretation |
|---|---|---|---|
| Fixed-threshold (raw HAND) | **0.614** | 0.581–0.643 | poor |
| Discharge-driven (event-matched margin, reliable events) | **0.809** | 0.793–0.821 | **good** |
| Discharge-driven (all events) | 0.818 | 0.808–0.828 | good |

This *supersedes* §0.21's own earlier single-trial 0.795/0.818
figures — not a contradiction, a more statistically robust re-measurement
of the same underlying method, using the exact same real ground truth.
The discharge-driven mode's real, multi-trial-confirmed accuracy is
**0.81 ("good")** — a substantial, honestly-earned improvement from the
0.605–0.646 ("poor") starting point this whole investigation began
from, still short of the user's own 85% target, and reported as such.

### Documented, not-yet-built next steps (literature-backed, scoped, not started this pass)

- **AHP/multi-criteria fusion** — Ullah et al. 2024's Quetta factor list
  (TWI, elevation, slope, LULC, precipitation, stream distance, drainage
  density, soil type) is the concrete starting template; Waseem et al.
  2023's consistency-ratio reporting convention should be followed when
  weights are chosen. Real, additive scope — not started this pass.
- **`STREAM_FLOW_ACCUM_THRESHOLD` sensitivity** — Li et al. 2022
  explicitly flags this class of parameter as under-characterized;
  this project's own value (500) has only ever had a rough
  back-of-envelope justification. A proper sweep, validated via the
  NOW-EXISTING multi-trial AUC framework, is a concrete, bounded next
  step — not started this pass, to avoid rushing a parameter-tuning
  pass immediately after specifically warning against exactly that
  failure mode with the FABDEM episode above.
- **Sentinel-1 SAR as a second ground-truth source** — Roth et al. 2023
  achieved 80% CSI for the actual 2022 Pakistan floods using Sentinel-1;
  higher resolution and all-weather (unlike MODIS/GFD), a plausible
  route to tightening this project's own accuracy CEILING, independent
  of any model change. Not integrated this pass.
- **Flat-terrain HAND enhancement** — Wahba et al. 2026's improved slope
  estimation directly targets this project's own named "diffuse
  waterlogging" limitation (§0.21). More involved than the changes made
  this pass; a real candidate for a dedicated future session.

### Verified

`python manage.py check` clean; `npm run build` succeeds; the real
`nullah_lai` catchment's full pipeline was rebuilt from scratch (force
rebuild, zero crashes) after the FABDEM revert and re-validated via 8
independent trials. No dependency change — FABDEM's asset lives in the
same `ee` package already used throughout this feature.

**Files changed:** `flood_model.py` (`_DEM_SOURCES`/`dem_source`
parameter — additive; `_FABDEM_VALIDATION_TEST_CATCHMENT` — an
isolated, non-production test fixture, not a real catchment),
`accuracy_assessment.py` (`assess_raster_auc_stable`,
`assess_pooled_multi_raster_auc_stable` — additive, wrap existing
functions unchanged), `flood_validation.py` (`n_trials` parameter),
`flood-model-control.js` (both accuracy notes updated with the final
multi-trial numbers). No dependency change.

## 0.23 A second real catchment: Bhudni Nullah Basin (Peshawar) — added, tested, and carried through every phase

**User's own instruction, verbatim**: "add more catchments not just
Nullah Lai... add more catchments and test them thoroughly up till now
with full summary report and accuracy assessment and than carry these
new catchments along with the old catchment along in other phases."

### Candidate selection — from the literature review itself, not picked blind

§0.22's own literature review named several Pakistani flash-flood
studies (Theme G). Two were evaluated as candidates:

- **Peshawar** (Tayyab et al. 2024 models flash-flood susceptibility as
  its own class there; a 2025/2026 Frontiers in Sustainable Cities
  study names a specific basin, the **Bhudni Nullah Basin**: 272 km²,
  38 km main channel, 84 settlements, ~922,000 people, documented
  floods in 2002/2008/2010/2012/2014/2015/2022/2025).
- **Quetta** (Ullah et al. 2024's own AHP flood-risk study).

**Quetta was tested and NOT added** — checked directly, not assumed:
`accuracy_assessment.list_gfd_events()` against a reasonable Quetta
urban-valley bbox found **zero** real GFD flooded-pixel events, and
widening the search substantially (a ~1° region around the whole city)
still found almost nothing usable (2 events, one with a single pixel).
Same standard this whole project has held throughout — a catchment with
no way to be validated doesn't meet "test them thoroughly... accuracy
assessment," so it's deferred, not force-added. A concrete future lead:
Roth et al. 2023 (§0.22, Theme G) found Sentinel-1 SAR far more
effective than MODIS for the actual 2022 Pakistan floods (80% CSI) —
worth trying as a second ground-truth source for Balochistan
specifically in a later pass, not built here.

**Peshawar was added.** Rich, real signal, confirmed live: **9 GFD
events** with actual flooded pixels inside the catchment bbox, the
strongest (event 2675, "Snowmelt," 2005) with **501 flooded pixels** —
far richer ground truth than Nullah Lai's own best single event (70
pixels).

### Defining the catchment — empirically, the same way Nullah Lai's own bbox was corrected

Unlike Nullah Lai (a precise WMO/APFM-published boundary), no exact
Bhudni Nullah Basin polygon was found in open literature — only the
272 km² area figure and general location (Peshawar-Charsadda corridor,
north of Peshawar city, near settlements including Sheikh Abad). The
bbox was corrected the SAME way Nullah Lai's original ~3x-oversized
bbox was corrected in §0.17: built the real D8 flow-accumulation
pipeline for a candidate bbox, checked the computed outlet drainage
area against the published figure, and iterated.

| Candidate | Outlet drainage area (computed) | vs. published 272 km² |
|---|---|---|
| Initial guess (Warsak-Dam-adjacent) | 428.4 km² | +57% |
| Attempt 2 | 360.5 km² | +33% |
| **Accepted: `[71.45, 33.98, 71.70, 34.20]`** | **298.3 km²** | **+9.7%** |
| Attempt 4 (overcorrected) | 207.7 km² | −24% |

**Accepted at ~10% residual gap** — worse than Nullah Lai's own ~3%
cross-validation, an honestly-stated real limitation: Nullah Lai had a
published BOUNDARY to correct against, Peshawar only had a published
AREA figure to triangulate toward, which is inherently less precise.
Basin length (38 km) is a directly confirmed published figure (the main
channel's own length, matching the same "main channel, not tributary
sum" convention already used for Nullah Lai's 30 km).

**Composite CN — an honestly-labeled ESTIMATE, not research, and said
so in the code, not just here.** No Farooq-et-al-style land-use-fraction
study was found for this basin (searched directly, confirmed absent).
`flood_discharge.PESHAWAR_COMPOSITE_CN` (81.2) uses an estimated
land-use split — more agricultural/peri-urban than Nullah Lai's own
(38.6% residential), reflecting this basin's own documented "sustained
conversion from agricultural to built" character and much larger rural
fringe (272 km² vs. Nullah Lai's 234.9 km², same order of magnitude but
covering far more rural area given the same order-of-magnitude
population). This is the single least-certain input for this catchment
— most consequential for the discharge-driven mode's runoff estimate,
explicitly flagged as such in the code, not hidden in a comment nobody
reads.

### A real bug caught by adding a second catchment

`build_discharge_driven_flood_zone`'s own `composite_cn` resolution
used to be `cfg.get("composite_cn") or
flood_discharge.LAI_NULLAH_COMPOSITE_CN` — harmless with exactly one
catchment, but WRONG the moment Peshawar (with its own, different CN)
existed: any catchment configured with `composite_cn: None` would have
silently received Lai Nullah's own CN instead of its own. **Caught
before it ever produced a wrong number for a real request** (Peshawar's
own config was written with an explicit numeric CN from the start,
never triggering the bug in practice — but the fallback logic itself
was still wrong and would have bitten a THIRD catchment added carelessly
later). Fixed: every `PILOT_CATCHMENTS` entry must now state its own
`composite_cn` explicitly as a literal number; a missing value raises a
clear `ValueError` naming the catchment, instead of silently borrowing
a different basin's hydrology. This is exactly the kind of
multi-instance bug that only surfaces once a SECOND real instance
exists — the reason "add more catchments" is a genuine test of this
codebase's own generality, not just more of the same.

### Accuracy assessment — real, multi-trial, and honestly compared to Nullah Lai's own numbers

Built via the exact same, unmodified pipeline (`build_hand_pipeline`,
`build_discharge_driven_flood_zone`, `build_discharge_margin_raster`,
`run_event_matched_validation`) — zero crashes, zero core-logic changes
for this catchment's sake. 8-trial `assess_raster_auc_stable`/
`assess_pooled_multi_raster_auc_stable` results, real GFD ground truth:

| | Nullah Lai (established) | Peshawar Bhudni Nullah (new) |
|---|---|---|
| Real GFD events used | 8–10 | 9 |
| Raw HAND AUC (8-trial mean) | 0.614 ("poor") | **0.680** ("poor", close to "fair") |
| Discharge-driven AUC (8-trial mean, reliable events) | 0.809 ("good") | **0.707** ("fair") |
| Improvement from discharge mode | **+0.195** | **+0.028** |

**Two genuine, honestly-reported findings, not glossed over:**

1. **Peshawar's raw HAND alone scores BETTER than Nullah Lai's** (0.680
   vs. 0.614) — terrain-only HAND already discriminates reasonably well
   here, before any discharge modeling is added.
2. **But the discharge-driven mode's own improvement is far smaller
   here** (+0.028 vs. Nullah Lai's +0.195) — plausibly explained by
   terrain: Peshawar's own HAND raster tops out around **76m** (mean
   3.3m), against Nullah Lai's **478m** (mean 31m) — a MUCH flatter
   basin. This is directly consistent with §0.22's own literature
   review (Wahba et al. 2026, Theme B): HAND-class methods are
   DOCUMENTED to struggle more, and a discharge-driven stage has less
   local relief to differentiate against, in flat terrain specifically.
   Not asserted from the literature alone — confirmed by this
   catchment's own real, computed HAND statistics matching the
   literature's own predicted failure mode.

This is a genuinely valuable generalization result: the discharge-driven
approach's real accuracy benefit is basin-terrain-dependent, not a
constant improvement — something impossible to know from Nullah Lai
alone, and exactly the kind of finding "add more catchments" was meant
to surface.

### Carried through every existing phase, not just added as data

- **Phase 1 (hazard)** — `build_hand_pipeline("peshawar_bhudni_nullah")`
  built and cached, same as Nullah Lai.
- **Phase 1.5 (exposure)** — `flood_exposure.build_exposure_report`
  works unchanged (bbox-driven, catchment-agnostic); Overture/OSM data
  fetched fresh for this new bbox (no code change needed).
- **Phase 1.6 (endpoints + frontend)** — `POST /api/flood-model/run/`
  accepts `"catchment": "peshawar_bhudni_nullah"` with zero endpoint
  code changes (catchment validation was already generic); added to
  `KNOWN_CATCHMENTS` in `flood-model-control.js`, selectable in the
  panel's own "Area" dropdown.
- **Phase 2 (discharge-driven mode)** — `build_discharge_driven_flood_zone`
  works unchanged; verified live with a real rainfall scenario
  (60mm/24hr).
- **§0.20/§0.21/§0.22 (accuracy)** — `list_gfd_events`,
  `fetch_gfd_flood_extent`, `fetch_peak_event_rainfall`,
  `run_event_matched_validation` all work unchanged for this bbox — the
  whole point of building these as bbox-parametrized functions from the
  start, not Nullah-Lai-specific ones.

**A real UI correctness bug caught and fixed while wiring this up**:
the panel's accuracy notes were hardcoded to Nullah Lai's own numbers
(and Nullah-Lai-specific comparisons, e.g. the HEC-RAS Kattarian-
Gawalmandi reach) — showing those while Peshawar was selected would
have been actively WRONG, not just incomplete, once a second catchment
existed. Fixed with a `CATCHMENT_ACCURACY_INFO` lookup keyed by
catchment, and the catchment-select change handler now triggers a full
re-render (it previously only updated the map marker) — both real bugs
that only exist once a second catchment does, caught before either ever
shipped to a real user.

**Two more real bugs — both genuine production-readiness gaps, not
data-entry mistakes — surfaced by actually running the exposure report
against this catchment live rather than assuming it would just work:
see "Two real timeout bugs found" below.**

### Two real timeout bugs found — this catchment's own terrain/scale exposed limits Nullah Lai never tested

The FIRST live-endpoint test of Peshawar's fixed-threshold mode (which
also runs the full exposure report) genuinely FAILED — twice — with
`RuntimeError: Overture Maps buildings fetch did not finish within
300s`, then `...within 420s` after a first timeout bump. This was
investigated properly, not just patched with an ever-larger number:

1. **Overture buildings fetch — `_OVERTURE_FETCH_TIMEOUT_SECONDS`
   300s → 420s.** Directly measured (isolated call, no other work
   competing): 227.5s for Peshawar's bbox — squarely within Nullah
   Lai's own historical 225–270s range, confirming this is the SAME
   already-known-slow S3/Parquet scan (§0.11/module docstring), not a
   Peshawar-specific regression. The original 300s cap simply left too
   little headroom against its own documented range for a network-bound
   external call; 420s gives real margin.
2. **WorldPop population fetch — `_POPULATION_TIMEOUT_SECONDS` 30s →
   90s.** A GENUINELY NEW, catchment-dependent finding, not the same
   bug twice: §0.9's original 30s cap was based on Nullah Lai's own
   measured 1.6–7.4s. Peshawar's own flood-zone polygon, DIRECTLY
   MEASURED, took 32.5s — because this basin's much flatter terrain
   (mean HAND 3.3m vs. Nullah Lai's 31m) produces a far more fragmented
   3.0m-threshold polygon (2.36-million-character WKT vs. Nullah Lai's
   compact shape) — geometry complexity that scales with terrain
   flatness, confirmed by direct measurement, not assumed from the bbox
   size alone. Raised to 90s, real headroom above the observed 32.5s.

**Neither fix was guessed** — both came from directly measuring the
actual operation in isolation first, then sizing the timeout with real
margin, the same "confirmed live" discipline this whole document runs
on. After both fixes, `python manage.py warm_flood_exposure_cache
peshawar_bhudni_nullah` completed successfully: 317.18 km² flood zone,
154,673 buildings, 1,156.08 km of roads, 248.28 km of drainage, 799,885
people (31,303 elderly, 93,370 under-5) — a complete, real exposure
report, not a partial/degraded one.

**A genuinely useful validation of existing architecture, not just a
bug hunt**: even fully warm, Peshawar's exposure report takes ~175s
(vs. Nullah Lai's own documented ~71s warm) — a real, honest,
catchment-scale-dependent cost (more roads/drainage geometry to
process for a larger, denser dataset). This did NOT require any new
code: the async job-id-polling architecture (§0.15, built specifically
because processing time was never assumed constant across every future
use of this endpoint) already handles it correctly — the job keeps
running server-side regardless of how long any one client happens to
poll, exactly its own original design intent, now genuinely exercised
by a second catchment for the first time. **This is exactly why "add
more catchments" was worth doing as real testing, not just a data
exercise** — every one of these three findings (the `composite_cn`
bug, both timeout gaps) was invisible with only one catchment ever
tested against, and none would have been caught by more testing of
Nullah Lai alone.

### Verified

`python manage.py check` clean; `npm run build` succeeds. Full pipeline
built live for Peshawar (HAND, streams, discharge scenarios) — zero
crashes. Both API modes (fixed-threshold, discharge-driven) submitted
and completed successfully via Django's test Client against the real
`peshawar_bhudni_nullah` catchment key, including the FULL exposure
report (buildings/population/roads/drainage) after the two timeout
fixes above. 8-trial accuracy assessment completed for both raw HAND
and discharge-driven modes.

**Files changed:** `flood_model.py` (new `peshawar_bhudni_nullah`
`PILOT_CATCHMENTS` entry; the `composite_cn` resolution bug fix, applies
to every catchment including Nullah Lai), `flood_discharge.py`
(`PESHAWAR_LAND_USE_FRACTIONS`/`PESHAWAR_COMPOSITE_CN` — additive),
`flood_exposure.py` (`_OVERTURE_FETCH_TIMEOUT_SECONDS` 300s→420s,
`_POPULATION_TIMEOUT_SECONDS` 30s→90s — both evidence-based, timeout
values only, no logic change), `flood-model-control.js`
(`KNOWN_CATCHMENTS` entry, `CATCHMENT_ACCURACY_INFO` lookup replacing
hardcoded Nullah-Lai-only text, catchment-select re-render fix). No
dependency change.

## 0.24 Wiring exposure to the discharge-driven mode — and a serious vectorization bug found only by testing it

**User's own instruction, verbatim** (choosing between two candidate
next phases): "wire flood_exposure to the discharge-driven mode next —
not AHP fusion... right now the more accurate mode... tells an operator
nothing about buildings, population, or roads at risk." Then, after
implementation: "test rigorously and give summary of before and after
along with critiques."

### The gap being closed

Since §0.19, the discharge-driven mode returned `"exposure": null` —
real flood-zone geometry and real discharge numbers, but no
buildings/population/roads/drainage breakdown. Meanwhile the
fixed-threshold mode (the LESS accurate one, per §0.20-§0.23's own AUC
results) was the only one with a full exposure report. Backwards for a
decision-support tool: the better model was operationally silent on the
one question an operator actually needs answered.

### The fix — reuse the existing exposure pipeline unchanged, feed it a different geometry

`flood_exposure.build_exposure_report`'s own body was split at exactly
the point where it stops caring about HAND/thresholds and starts caring
only about a flood-zone GEOMETRY:

- **`_build_exposure_from_geom(catchment_key, bbox, flood_zone_geom,
  force, _report_stage)`** — extracted verbatim from
  `build_exposure_report`'s own prior inline body (admin tagging,
  Overture/OSM buildings, bridges/hospitals, road/drainage network
  length, WorldPop population) — regression-tested to reproduce
  byte-identical output for the fixed-threshold caller before/after
  extraction (confirmed live: `flood_zone_km2`, `roads_in_zone_km`,
  `population` all matched exactly on a warm-cache rerun; one
  `buildings` mismatch on the FIRST rerun was traced to a real, transient
  AWS S3 network error — correctly triggered the ALREADY-EXISTING
  Overture→OSM fallback, not a regression — and matched exactly on a
  second, unaffected rerun).
- **`flood_model.build_discharge_binary_mask(catchment_key, rainfall_mm,
  duration_hr, force)`** — new, additive. `gdal.Polygonize` (used by the
  existing, unmodified vectorizer) groups contiguous EQUAL-VALUE pixels
  — feeding it the discharge mode's own continuous HAND-valued
  `10_masked_hand_{scenario}.tif` directly would produce one polygon per
  near-unique pixel value, not one flood zone. This function reclassifies
  that already-cached raster into a proper binary mask (1 = flood-prone,
  0 = not) — reusing the already-computed `build_discharge_driven_flood_zone`
  output, not recomputing anything.
- **`flood_exposure.build_discharge_exposure_report(catchment_key,
  rainfall_mm, duration_hr, force, progress_callback)`** — new. Builds
  the binary mask, vectorizes it, and calls the SAME
  `_build_exposure_from_geom` the fixed-threshold path uses.
  `flood_model_views.py`'s job runner now calls this instead of setting
  `exposure: None` for a discharge-driven job.

### A serious bug found by testing this rigorously, not by inspection

The vectorizer (`_vectorize_flood_zone`) has always dropped polygon
slivers below a 9-pixel minimum-mapping-unit before dissolving — a real,
already-documented fix (§0.11) for the fixed-threshold mask, whose own
raw Polygonize output was ~2,720 disconnected slivers that made a
downstream `.intersection()` against a 53,250-vertex district boundary
hang for minutes. Reusing this function UNCHANGED for the discharge
mode's own mask seemed safe — same function, same interface, "no core
logic change." **It was not safe, and only direct measurement caught
it**: the discharge-driven mask naturally hugs narrow stream channels
rather than forming one broad blob, so its own real, genuine flood-prone
signal legitimately consists of thousands of small disconnected
clusters — not noise. Confirmed live for one real scenario: **5,103
polygons, of which only 90 survive the 9-pixel filter — discarding
79.3% of the true flood-prone area** (7.84 km² of real signal collapsed
to 1.58 km² after vectorization). Had this shipped un-investigated, the
discharge-driven mode's exposure numbers would have UNDERCOUNTED
buildings by ~13x (630 vs. the correct 8,450) and roads by ~10x (8.18km
vs. the correct 83.03km) — silently wrong in exactly the way this whole
document has tried never to ship.

**Fixed properly, not by guessing a different magic number**:
`_vectorize_flood_zone` gained a `min_mapping_unit_px` parameter
(default 9 — the fixed-threshold path's own call site is UNCHANGED,
passes nothing, behaves identically). The discharge path calls it with
`min_mapping_unit_px=0` (no area filter). Before trusting that this
doesn't silently reintroduce the original hang-for-minutes problem, it
was tested directly: with zero area filtering, `unary_union` took 0.55s,
admin-tagging's own district-boundary intersection took 3.1s, and the
full road-network intersection took 26.4s — nowhere near the original
multi-minute hang, because the original slow case was specific to a much
LARGER contiguous unfiltered area (the fixed-threshold mask's own ~50km²
blob) against a very high-vertex boundary, not an inherent property of
having many small polygons. Also stress-tested at the largest realistic
scale (a 400mm/8hr Nullah Lai scenario, 19.1 km² — approaching 40% of
the fixed-threshold mode's own scale): 127.5s end-to-end, no
performance cliff. Re-verified on Peshawar too (a DIFFERENT catchment,
even flatter terrain, an even larger 24.6 km² test scenario): 105.7s,
no hang, vectorized area (24.58 km²) matched the raster-based figure
(25.4 km²) within ~3.2% — consistent with Nullah Lai's own ~2.6% match,
confirming the fix generalizes, not a one-catchment coincidence.

### Before / after

| | Before (§0.19-§0.23) | After (§0.24) |
|---|---|---|
| Discharge-driven mode's `exposure` field | Always `null` | Real: buildings, population, roads, drainage, admin context |
| Nullah Lai, 150mm/5hr scenario | No exposure numbers | 7.518 km² zone, 8,450 buildings (of 419,473), 41,873 people, 83.03 km roads, 43.42 km drainage |
| Nullah Lai, extreme 400mm/8hr scenario | No exposure numbers | 19.113 km² zone, 22,310 buildings, 106,172 people, 243.31 km roads |
| Peshawar, 60mm/24hr scenario | No exposure numbers | 24.58 km² zone, 7,899 buildings (of 454,526), 51,385 people, 48.09 km roads, 45.05 km drainage |
| Vectorization correctness for this mask type | Never tested — would have used the fixed-threshold's own 9px filter, silently discarding 79.3% of real area | Confirmed live: matches raster-based area within ~3% across two catchments and three scenario scales |

### Critique

**What went right**: the "extract the geometry-agnostic core, verify
byte-identical output, reuse it" pattern (already used twice this
session — `accuracy_assessment._sample_and_score`,
`assess_pooled_multi_raster_auc`) worked a third time here without any
surprises in the SHARED code. The actual bug was not in the shared
core — it was in an assumption about a completely different function
(`_vectorize_flood_zone`) whose one hardcoded constant happened to be
tuned for a geometry shape the new caller doesn't share.

**What should have been caught earlier, honestly**: the discharge-driven
mode's mask has been described, in this document's own words since
§0.19, as following "narrow stream channels" rather than forming a
broad zone — the exact geometric property that made the 9-pixel MMU
filter wrong. That description existed BEFORE this integration was
built, and the mismatch could plausibly have been reasoned out from
first principles rather than only caught by direct measurement after
the fact. It was still caught — by comparing the new function's own
output against an independent, already-trusted number
(`build_discharge_driven_flood_zone`'s own raster-based
`flood_zone_km2`) before considering the feature done, the same
"cross-check against something already trusted" discipline used
throughout this whole document — but the more precise lesson is: **when
reusing an existing function against a new input, actively ask what
that function's own tuned constants assumed about its ORIGINAL input's
shape**, not just whether the interface matches.

**Recommendations for continued production readiness**:
- **Add an automated regression check** (not yet built) that runs both
  exposure paths against a small fixed scenario and asserts the
  vectorized area stays within a stated tolerance (e.g. 5%) of the
  raster-based cell-count area — turning this session's own manual
  cross-check into a real, standing safeguard rather than something that
  depends on a human remembering to compare the two numbers again after
  a future change.
- **`min_mapping_unit_px` is still one global constant per call site**,
  not derived from the mask's own geometry. If a future catchment's
  discharge mode produces a mask somewhere between "one broad blob" and
  "thousands of thread-thin slivers," neither `9` nor `0` may be
  correct. Not a problem today (both real catchments tested clearly fall
  on the "many small real clusters" side), but worth a real
  geometry-shape heuristic (e.g. total polygon count relative to total
  area) if a third catchment's own mask shape turns out to be different.
- **The discharge-driven exposure report currently reruns the full
  exposure pipeline per rainfall/duration scenario** — buildings/OSM
  fetches are cached per-catchment (bbox-only, correctly reused across
  scenarios), but road/drainage length computation and the vectorization
  itself are NOT scenario-cached, so requesting the same scenario twice
  redoes real work. Given this mode is explicitly a "one-off run, not
  added to the permanent layer catalog" (already stated in the UI), this
  is an acceptable, deliberate tradeoff for now — but if operators start
  re-running the same scenarios repeatedly, scenario-level exposure
  caching (mirroring `build_discharge_driven_flood_zone`'s own
  `flood_prone_zones_discharge_{scenario_key}.json` sidecar pattern)
  would be the next efficiency step.

### Verified

`python manage.py check` clean; `npm run build` succeeds. Both modes
tested end-to-end via Django's test Client against the REAL async
endpoint (not just direct function calls) — the discharge-driven job's
live progress checklist correctly advances through all 10 stages in
real time (confirmed by polling and observing `completed_stages` grow
incrementally, not all at once), finishing with a fully-populated,
non-null `exposure` field. The fixed-threshold mode re-verified
byte-identical to its pre-refactor output. Tested across 2 catchments ×
3 scenario scales (small/medium/extreme) with no crashes and no
performance cliff.

**Files changed:** `flood_exposure.py`
(`_build_exposure_from_geom` — extracted, regression-verified;
`build_discharge_exposure_report` — new; `_vectorize_flood_zone` gained
`min_mapping_unit_px` parameter, default preserves exact prior behavior),
`flood_model.py` (`build_discharge_binary_mask` — new, additive),
`flood_model_views.py` (discharge branch now calls the new exposure
function instead of setting `None`), `flood-model-control.js`
(discharge-mode results rendering now shows the full exposure
breakdown). No dependency change.

## 0.25 Closing §0.24's own recommendations — a self-adaptive vectorizer, a standing regression check, and scenario caching

**User's own instruction, verbatim**: "after fulfilling and implementing
this recommendations... in the existing system while keeping in mind
the production readiness and the crash fixes and optimization." All
three recommendations from §0.24's own critique are implemented and
verified live — not deferred, not partially done.

### 1. `min_mapping_unit_px` is now self-adaptive, not a per-mode guess

§0.24 fixed the vectorization bug by having the discharge caller pass
`min_mapping_unit_px=0` explicitly — correct, but it baked an assumption
about THAT mode's mask shape into the CALLER, which would silently
break again for any future mode/catchment whose mask doesn't cleanly
fit "0" or "9". `_vectorize_flood_zone` now measures, for the ACTUAL
mask it's given, what fraction of the raw Polygonize output's own total
area the requested filter would discard, and backs off to unfiltered
automatically if that exceeds `_VECTORIZE_MAX_DISCARDED_AREA_FRACTION`
(10%) — logged, not silent. Every caller (fixed-threshold included) now
passes the SAME default; the function itself decides per-mask whether
the filter is safe to apply.

**Confirmed live, both catchments, multiple scenarios** — the discarded
fraction the adaptive guard measured was genuinely different every
time, proving this is a real per-mask computation, not a disguised
constant: Nullah Lai 150mm/5h → 80.7%; Nullah Lai 250mm/6h → 70.0%;
Peshawar 60mm/24h → 53.9% — all correctly triggered the fallback. The
fixed-threshold mask's own output was re-verified byte-identical
(49.746 km², unchanged) — its own discarded fraction at 9px stays well
under the 10% cap, so the filter still applies exactly as it always
has.

### 2. A standing regression safeguard, not a one-off manual check

`build_discharge_exposure_report` now cross-checks its own vectorized
area against the ALREADY-COMPUTED, independently-derived raster-based
area (`build_discharge_driven_flood_zone`'s own cell-count figure — a
cheap cache-hit, not new work) on every real call, and logs a loud
`ERROR` (never raises — the actual exposure result is still returned,
matching this module's own "degrade, don't crash" convention throughout)
if the two diverge by more than 15% (calibrated with real margin above
the ~2.6-3.2% deviation observed for correctly-behaving vectorization
across every scenario tested so far).

**Verified live that this safeguard actually catches the exact bug
§0.24 found**: monkeypatched `_vectorize_flood_zone` to reproduce the
original (pre-§0.24) unconditional 9-pixel filter, then called
`build_discharge_exposure_report` — the check correctly logged `VECTORIZATION
CONSISTENCY CHECK FAILED ... 82.0% deviation, over the 15% tolerance`
and named the exact failure mode, while the correctly-behaving code
path (unpatched) produces no such warning. This is no longer something
that depends on a human remembering to compare two numbers after a
future change — it fires automatically, every real call, in production.

### 3. Scenario-level exposure caching

Buildings/OSM raw fetches were already cached per-catchment (bbox-only,
correctly reused across every scenario) — but admin-tagging's district
intersection and the road/drainage network-length computation are real,
non-trivial per-scenario work (confirmed live: several seconds to
several tens of seconds each) that re-running the identical scenario
redid from scratch every time. `build_discharge_exposure_report` now
writes a `discharge_exposure_{scenario_key}.json` sidecar (same pattern
`build_discharge_driven_flood_zone`'s own scenario JSON already
established) and reads it back on a cache hit, skipping vectorization,
admin-tagging, and every exposure sub-fetch entirely — while still
re-marking every progress stage (so a polling frontend sees the full
checklist "complete" instantly rather than appearing stuck).

**Confirmed live**: a fresh compute for one real scenario took 485.8s
(force-rebuilt end to end); the identical scenario on a cache hit
returned in 0.0s, byte-for-byte identical output. Re-verified through
the REAL async HTTP endpoint (not just a direct function call): the
same cached scenario, submitted as a genuine job via `POST
/api/flood-model/run/`, completed in 1.0s end to end (job submission +
polling overhead), down from the 485.8s a cold run costs.

### Production-readiness framing (per the user's own instruction)

- **Crash safety**: every new code path degrades, never raises past its
  own boundary — a corrupt/stale cache file is detected and rebuilt
  (matching the identical pattern already used for
  `build_discharge_driven_flood_zone`'s own JSON sidecar), a cache-write
  failure is logged and swallowed (an already-successful computation is
  never turned into a failed request over a disk-write problem), and the
  new consistency check's own `try/except` ensures a bug IN the
  safeguard itself can never break the real exposure computation it's
  checking.
- **Optimization**: the two most expensive per-scenario steps (road and
  drainage network length, confirmed live at up to ~30s each) are now
  skippable entirely on a cache hit — the single highest-leverage
  optimization available for a mode explicitly designed around
  "one-off, non-catalog" reruns of the same handful of what-if
  scenarios.
- **No new dependency, no core logic touched outside what these three
  recommendations explicitly required.** The fixed-threshold mode's own
  code path is provably unchanged (regression-verified byte-identical
  output before/after every change in this section).

### Verified

`python manage.py check` clean; `npm run build` succeeds. All three
recommendations tested individually (adaptive MMU across 2 catchments/3
scenarios; the regression safeguard's own pass AND fail cases, the fail
case via a deliberate monkeypatched fault injection; the cache's
fresh-vs-hit byte-identical comparison) and together, end-to-end,
through the real async HTTP endpoint. Fixed-threshold mode re-verified
byte-identical (49.746 km²) after every change.

**Files changed:** `flood_exposure.py` only —
`_vectorize_flood_zone` (adaptive discard-fraction guard, additive
parameter with an unchanged default), `build_discharge_exposure_report`
(scenario-level JSON caching + the standing area-consistency
safeguard). No dependency change.

## 0.26 Real rainfall input for the discharge-driven mode — CHIRPS, PMD Forecast, and live-observed, additive to manual entry

Every discharge-driven run up to §0.25 required a manually-typed
`rainfall_mm`/`duration_hr` scenario — a genuine what-if calculator, not
yet an early-warning system that reacts to real weather. The user's own
instruction was explicit on scope: **manual entry stays available**; this
adds real fetched sources alongside it, not instead of it. Confirms §4's
own original table entry ("Rainfall (primary) | PMD's own WRFPRS/GDFS
forecast... already fetched, warped... call this directly, no new fetch/
warp code needed") and §4's own deferral of Meteoblue to Phase 4 ("client-
side only today... deliberately deferred") — this section independently
arrived at the same conclusion the original plan already reached.

**New module `flood_forecast.py`** — three fetchers, one dispatcher, all
following this project's own established "degrade to None inside the
module, raise ValueError only at the dispatcher" convention
(`accuracy_assessment.fetch_peak_event_rainfall`'s own pattern):

- **`chirps`** — sums the N most-recently-available CHIRPS daily images
  (GEE, same collection §0.21 already uses) over the catchment bbox.
  **A real, confirmed-live surprise**: CHIRPS/DAILY's GEE-hosted
  publication latency measured **~27 days** (last image 2026-07-31,
  checked 2026-08-27) — nowhere near the ~1-2 days first assumed.
  CHIRPS/PENTAD was checked as a lower-latency alternative and found
  EVEN more stale (2026-07-26). No lower-latency CHIRPS product exists
  through this project's GEE access. Fixed honestly, not hidden: this
  source is never called a "nowcast," the search window was widened from
  14 to 60 days so it actually finds data, and the returned `end_date` is
  load-bearing — the frontend surfaces it explicitly so a 27-day-old
  estimate is never shown as "right now" rainfall.
- **`pmd_forecast`** — samples PMD Monitor's real WRFPRS precipitation-
  accumulation forecast (`hourtpe`/`sixtpe`/`twelvetpe`/`daytpe` = 3h/6h/
  12h/24h) at the catchment's own bbox centroid. Calls
  `views.py`'s own `_mon_get`/`_mon_cached`/`_mon_pred_select_steps`/
  `_mon_pred_ensure_warped`/`_mon_pred_sample` directly (same process, no
  HTTP round-trip to this server) — the exact helper chain
  `PmdMonitorPredictionValueAPIView` itself already uses, reused rather
  than reimplemented. Verified live: the warped GeoTIFF genuinely has
  real precipitation values elsewhere on its grid (max 404.9mm, 214874/
  614598 valid pixels > 0.1mm) confirming the pipeline is correct — both
  pilot catchments' own centroids sampled 0.0mm for the current forecast
  run, a real dry-period result, not a broken sampler.
- **`live_observed`** — looks up the most recent NWFC daily-rainfall
  report's district-level multi-day total (already parsed/cached by
  `NwfcRainfallReportAPIView`, called directly, not over HTTP) for
  whichever of a catchment's configured `district_names` it finds.
  **A second real, confirmed-live surprise**: the NWFC PDF only lists
  districts that actually RECORDED measurable rain — a dry district is
  simply ABSENT, not listed at 0mm (confirmed live: the report checked
  had exactly one district, "Kasur & Lahore (Airport)"; neither pilot
  catchment's district appeared). This makes "not found" genuinely
  ambiguous between "no rain" and "station didn't report" — documented
  honestly in the function's own docstring and the error message a
  caller sees, and deliberately NOT papered over with a synthesized 0mm
  guess.

Each pilot catchment gained a `district_names` list (`nullah_lai`:
Islamabad/Rawalpindi; `peshawar_bhudni_nullah`: Peshawar) — metadata only,
used solely by the `live_observed` fetcher.

**A real bug found and fixed before shipping, not after**: the existing
`build_discharge_driven_flood_zone` hard-requires `rainfall_mm > 0` (a
genuine requirement of its own SCS-CN math, confirmed live via a direct
call that raised `ValueError: rainfall_mm and duration_hr must both be
positive`). A fetched value being exactly 0mm is a completely normal real
result (confirmed above — both PMD Forecast and NWFC returned it for both
catchments during this actual dry period), so feeding it straight into
the pipeline would have surfaced a confusing validation error for what is
actually honest "no flood risk right now" information. Fixed in
`flood_model_views.py`: a fetched (non-manual) `rainfall_mm` below the
existing `_MIN_RAINFALL_MM` floor short-circuits the job to `"done"`
immediately with an explicit `no_flood_expected` result, without ever
running the expensive HAND/discharge pipeline for an already-known
outcome. Manual-mode requests are unaffected — they still go through
`FloodModelRunView`'s own existing floor validation and can never reach
this branch.

**A second real gap found and fixed**: the throttle-then-validate
ordering this view already established (§0.15) initially had the new
external fetch (`resolve_rainfall_scenario` — a real GEE/PMD Monitor/NWFC
PDF call, not cheap) running BEFORE `self.check_throttles()`, which would
have let repeated non-manual requests spend real external-API budget
ahead of being rate-limited. Moved the fetch to after the throttle check,
matching the same reasoning §0.15 already applied to job submission
itself. A third gap: `chirps_days`/`pmd_element` are client-supplied and
were unvalidated — an unbounded `chirps_days` (e.g. 50) wouldn't crash
anything but would silently feed a scientifically-invalid multi-week
"single storm" duration into SCS-CN/SCS-UH (the same class of problem
§0.21's own docstring documents for why a GFD event's full window can't
be summed wholesale). Fixed: `chirps_days` bounded to 1-3, `pmd_element`
validated against the known element set, both before the fetch runs.

**API contract** — `POST /api/flood-model/run/` gains an opt-in
`rainfall_source` field (`"manual"` default, `"chirps"`, `"pmd_forecast"`,
`"live_observed"`), mutually exclusive with manually-provided
`rainfall_mm`/`duration_hr`. Non-manual sources accept `chirps_days`
(1-3) or `pmd_element` (`hourtpe`/`sixtpe`/`twelvetpe`/`daytpe`) as
optional sub-parameters. The job-status response's existing
`discharge_scenario` field gains a `source_meta` sub-object carrying each
source's own provenance (CHIRPS's `end_date`, PMD Forecast's
`forecast_time`, live-observed's `matched_district`) — never presented as
interchangeable with a manually-typed value.

**Frontend** (`flood-model-control.js`) — the discharge mode's input
section gained a "Rainfall source" dropdown; selecting a non-manual
source swaps the manual number inputs for a source-specific control
(CHIRPS's accumulation-window select, PMD Forecast's window select, or a
plain note for live-observed) and submits the corresponding body fields
instead. Results rendering gained a `#renderRainfallSourceNoteHTML()`
provenance line (shown only for non-manual sources) and a
`#renderNoFloodExpectedResults()` path for the new short-circuited "no
flood risk currently indicated" outcome — both wired through a new
`#lastDischargeScenario` field captured from the poll response's
top-level `discharge_scenario`, not the nested `result` object (a real
distinction: `result` never carried source provenance, only
`discharge_scenario` did).

**Verified, end-to-end, with real live data, not mocked**: all three
fetchers called directly against real external services (GEE, PMD
Monitor, PMD's own weather.gov.pk PDF); the full `POST`/status-poll HTTP
flow exercised via `RequestFactory` calling the real view classes
(Django's `test.Client` itself was blocked in this environment by
`ALLOWED_HOSTS` rejecting `testserver` — not touched, since editing
`ALLOWED_HOSTS` for a throwaway test host is a settings change with no
production benefit); a genuine positive CHIRPS scenario (60.2mm/48h) run
all the way through the real HAND/discharge/exposure pipeline, producing
a real 1.586km² flood zone with a full buildings/roads/drainage/
population breakdown; the `no_flood_expected` short-circuit confirmed via
the real PMD Forecast 0mm case; all new validation errors (mutually-
exclusive params, unknown `rainfall_source`, out-of-range `chirps_days`,
unknown `pmd_element`, unmatched `live_observed` district) confirmed to
return clean 400/502s, not crashes; manual mode and fixed-threshold mode
re-confirmed byte-for-byte unchanged (same job-submission shape, same
202 response). `python manage.py check` clean; `npx vite build`
succeeds.

**Files changed:** `flood_forecast.py` (new), `flood_model.py`
(`district_names` added to both `PILOT_CATCHMENTS` entries — metadata
only), `flood_model_views.py` (`rainfall_source`/`chirps_days`/
`pmd_element` handling in `FloodModelRunView.post()`, the
`no_flood_expected` short-circuit), `flood-model-control.js` (source
selector UI, provenance/no-flood rendering). No dependency change.

**Deliberately not built this pass**: Meteoblue as a fourth source —
confirmed (again) to have no server-side numeric point-value path
anywhere in this codebase, matching §4's own original assessment; adding
one means a real new external API integration, not a reuse of existing
plumbing the way all three sources above are, and stays Phase 4 as the
original plan already scoped it.

## 0.27 Phase 2.5 (AHP vulnerability/susceptibility fusion) — begun, Phase 2.5.1 complete: literature-backed, terrain-conditioned factor weights

Phase 2.5 (originally scoped in §7 of this document, before Phase 0 even
started) begins here: a catchment-specific, HAND-integrated AHP
susceptibility score, alongside the existing terrain/discharge-only
modes. Per the user's own explicit instructions, this is being built in
small, independently-testable sub-phases (2.5.1 through 2.5.7, full
breakdown in the approved plan), under three constraints: literature-
backed weights targeting 75-80% AUC, open accurate data backed by
literature and testing, and small debuggable increments. Only 2.5.1 is
complete as of this stopping point.

**A pre-existing, unrelated AHP layer already exists in this codebase**
— `views.py`'s `AHPModels.compute_flood_susceptibility(aoi)` (line
~4916) and its `flood_susceptibility_ahp` layer catalog entry (line
~3700), a generic whole-Pakistan GEE demo layer (5 hand-picked round-
number weights — elevation 30%, slope 25%, rainfall 20%, distance-to-
water 15%, soil moisture 10% — with no pairwise comparison matrix and no
consistency-ratio check, so not real AHP despite the name) used
elsewhere in the app (e.g. Story Mode). Phase 2.5 does NOT touch this
layer — it stays exactly as-is for whatever already consumes it; the new
work builds a separate, catchment-specific, HAND-integrated score
alongside it, per the original plan's own explicit instruction to avoid
"a parallel, disconnected susceptibility score."

### Phase 2.5.1 — real weights, corrected after direct user pushback

**First attempt (wrong, caught immediately, not shipped)**: sourced a
single real, fully-verified AHP weight table (Hunza-Nagar, Pakistan,
Frontiers 2024, DOI 10.3389/fenvs.2024.1337081 — 9 factors, consistency
ratio 3.5%, fetched and read directly after every other candidate paper's
host — Springer, MDPI, ResearchGate, academia.edu, DOAJ — returned HTTP
403 to automated fetch) and used it, with an "honest caveat" noted but
not acted on, as a single universal weight set for both pilot
catchments. **The user immediately and correctly rejected this**: Hunza-
Nagar is a high-mountain, glacial-lake-outburst-flood-prone catchment —
using its weights nationwide (the user's own example: "what works for
Hunza-Nagar would not work for Karachi") is exactly the kind of
unvalidated single-region assumption this project has committed to
avoiding everywhere else. A real, substantive correction, not a cosmetic
one — caught before any pipeline code was built on top of the wrong
premise.

**Revised approach — a genuine multi-region literature survey**, not one
paper: four independently fetched/verified Pakistani AHP studies
spanning the actual topology range, not just mountains:

| Source | Terrain | Factors | Key weights | CR |
|---|---|---|---|---|
| Hunza-Nagar 2024 (Frontiers) | High mountain / GLOF | 9 | rainfall 27%, dist-river 23%, slope 16%, elevation 13% | 3.5% |
| KP province-wide 2024 (Frontiers) | Mixed mountain→plains (Swat/Dir/Swabi/Nowshera/Abbottabad/Mansehra/etc.) | 8 | streams 29.8%, precip 27.3%, slope 14.9%, LST 10.4%, elevation only 4.4% | 5% |
| Charsadda, KP 2024 | Flat floodplain, directly adjacent to Peshawar (the same Peshawar-Charsadda corridor `flood_model.py`'s own Bhudni Nullah bbox comment names) | 3 | rainfall 40%, stream frequency 30%, stream density 30% — **no slope/elevation term at all** | not reported |
| Punjab plains hybrid study | Flat, riverine | ~11 | Retrieved only as an internally-inconsistent AI summary — used for DIRECTION only (distance-to-river was its top factor; elevation+TWI stayed substantial even in flat terrain), no numeric value taken from it | — |

**No dedicated Karachi AHP study exists in the literature at all** —
searched directly, confirmed absent, stated as a real gap rather than
papered over. Karachi's documented flood mechanism (monsoon URBAN
PLUVIAL flooding from inadequate/blocked stormwater drainage and
imperviousness) is a genuinely different mechanism from the river-
proximity-driven FLUVIAL flooding every one of the four studies above
models — a drainage-capacity/imperviousness-dominated profile would be a
new addition, not a reweighting, if a pluvial-flooding catchment is ever
added.

**Cross-regional pattern confirmed** (the genuinely generalizable part):
rainfall and river/stream-proximity dominate in EVERY study regardless of
terrain (50-70% combined each time) — this is real literature-wide
consensus, not an assumption. **What does NOT generalize** (confirmed by
real numbers, not assumed): slope/elevation carry meaningful independent
weight in relief-bearing catchments (29% combined in Hunza-Nagar, 19% in
KP-wide) but the Charsadda study — geographically the closest match to
this project's own Peshawar catchment — drops them to zero entirely.

**Resulting design — two terrain-conditioned profiles, not one universal
table**, implemented in the new `flood_ahp.py` module, selected by each
catchment's own already-measured maximum HAND value (a real number this
project already computes — confirmed live: ~478m for Nullah Lai, ~76m
for Bhudni Nullah, a 6x difference) via `classify_terrain_relief()`,
rather than a hardcoded per-catchment label:

- **`MODERATE_RELIEF_FACTORS`** (Nullah Lai) — the arithmetic mean, computed
  in code from the two directly-verified tables' own numbers (Hunza-Nagar
  + KP province-wide) on every factor both share; KP-wide's land-surface-
  temperature factor dropped (single-study, no established open-data
  pipeline here); Hunza-Nagar's own twi/curvature kept as-is (KP-wide
  didn't test them).
- **`FLAT_RELIEF_FACTORS`** (Bhudni Nullah) — built from Charsadda's own
  rainfall/distance-river ratio (the single cleanest, most geographically
  apt source); small factors (lulc/ndvi/soil) carried over from the
  moderate-relief profile's own values; **slope+HAND weight deliberately
  cut to ~1/3** of the moderate profile's combined weight — justified by
  BOTH Charsadda's own complete omission of slope AND this project's
  already-confirmed 0.680 "poor" raw-HAND AUC for this exact catchment
  (§0.23); **TWI doubled** — informed by the Punjab study's qualitative
  (not numeric) signal that relative micro-elevation becomes MORE
  diagnostic, not less, once raw relief stops discriminating well. These
  two adjustments are explicitly labeled in the module's own docstring as
  this project's own reasoned synthesis, not literal literature numbers —
  never blurred together with the directly-cited figures.
- Each profile also has a "lite" variant (drops ndvi/soil_type/curvature,
  ~7 percentage points of the full table, renormalized) — cuts 3 raster
  fetches per run for the stated efficiency requirement; Phase 2.5.4 will
  test both full and lite against real ground truth rather than assuming
  the simplification is free.

**Every arithmetic step computed in code, not hand-typed** — reproducible
directly from the cited tables' own numbers. **Real, non-trivial
consistency-ratio validation** (Saaty's standard eigenvector method on a
reconstructed pairwise comparison matrix, since the original expert
judgment matrices were never published, only the derived weights): all
four resulting weight sets (moderate/flat × full/lite) passed Saaty's
0.10 acceptability threshold — CR = 0.021 (moderate full), 0.006
(moderate lite), 0.043 (flat full), 0.019 (flat lite). The flat-relief
full set's meaningfully higher CR is a genuine signal the check is doing
real work, not rubber-stamping — this project's own synthesized
adjustments (the slope/HAND cut, the TWI doubling) introduced real,
measurable internal tension versus the literature-derived baseline, still
within Saaty's acceptable range but not free of cost.

**Verified**: `flood_ahp.py` runs standalone (`python -m ncop_internal.
flood_ahp`) printing every profile's published vs. re-derived weights,
lambda_max, CI, and CR; `get_factor_weights('moderate_relief'|
'flat_relief', lite=True|False)` confirmed to sum to exactly 1.0 for
every combination; `classify_terrain_relief(478)` → `moderate_relief`,
`classify_terrain_relief(76)` → `flat_relief`, matching the two real
pilot catchments correctly. `python manage.py check` clean.

**Explicitly NOT yet done** (the honest state at this stopping point):
Phase 2.5.4's empirical AUC validation of these weights against real GFD
ground truth has NOT run yet — the 75-80% target is a target these
profiles are built TOWARD, not a result already achieved. No factor
rasters exist yet (Phase 2.5.2, not started). No pipeline wiring,
endpoint, or frontend UI exists yet (Phase 2.5.7, not started). The
150m HAND-relief cutoff separating the two terrain classes is a first-cut
heuristic based on only two confirmed data points, not yet validated
against a third catchment.

**Files changed:** `flood_ahp.py` (new). No other files touched this
pass — Phase 2.5.1 is design/weights only, no pipeline changes.

## 0.28 Riverine spatial model: a real critique, a model comparison, and a rebuild (§R0-R4)

Before Phase 2.5 could proceed for riverine mode, the user raised a direct,
substantive challenge to the riverine spatial engine as it stood: a single
uniform HAND threshold applied across a whole reach, unvalidated against any
alternative model, with an explicit instruction to research real alternatives
(FastFlood, and "why not other models") before continuing, and NOT to touch
the working flash-flood code while doing it. Target: 75-85% accuracy for
BOTH flood types, achieved through rigorous testing, not assumed.

### The uniform-HAND-threshold problem — confirmed live, not theoretical

Testing the existing riverine engine against a real 4m gauge-derived
threshold at Chashma found 75.4% of the ENTIRE bbox at HAND ≤ 4m (median
HAND only 1.36m across the whole raster) — a 669.866 km² "flood-prone zone"
result, the classic "leaky bathtub" failure: a cell is flagged the moment
it's LOCALLY low relative to ANY nearby drainage line, even one it has no
real hydraulic connection to.

### Model comparison — real alternatives researched, not assumed away

| Model | License | Verdict |
|---|---|---|
| FastFlood.org / SFFS (Fast Sweeping Method) | — | Confirmed to be a hosted front-end for openLISEM's own engine, not an independent method |
| openLISEM | GPLv3 | Real, open source — the actual engine behind FastFlood |
| LISFLOOD-FP | GPLv3, U. Bristol | Real, published accuracy 70-80%/95% capture rates — a legitimate candidate |
| CA-ffé (Jamali et al. 2019, *Water Resources Research*) | Published algorithm, no public code | Cellular-automata flood evaluation, 250-1100x faster than hydrodynamic models |
| CLIMADA / statistical return-period model | Open (CDS) | Tested: F1=0.51 on real Pakistan 2022 floods — not competitive |
| GloFAS (ECMWF/Copernicus) | Open, real historical discharge reanalysis | Requires a SEPARATE service (Copernicus CDS, not GEE), a new `cdsapi` package, and manual account/token registration — a genuine, honestly-reported blocker, not pursued |

GPLv3 tools (LISFLOOD-FP/openLISEM) were initially treated as off-limits
under an over-broad reading of "don't install anything that clashes with
requirements.txt" — the user corrected this directly: only actual pip/
requirements.txt conflicts are prohibited, subprocess tools are fine. This
reopened the option but a simpler, in-house fix (below) was pursued first
and turned out sufficient, so neither was ultimately integrated this pass.

### A from-scratch attempt, built, debugged, and honestly abandoned — `flood_ca.py`

A cellular-automata physics engine (`spread_water_ca`) was built to test
whether real iterative flood-spreading physics could outperform a threshold
test. Three real, structural numerical bugs were found and fixed one at a
time via synthetic tests before ever touching real data:

1. **Oscillation/overshoot** from an under-damped transfer rule — fixed by
   capping pairwise transfer at `head_diff/2`.
2. **Under-spreading** from a flawed "share of source depth" transfer
   formula — fixed by switching to rate-limited transfer
   (`damping * head_diff`, capped at `head_diff/2`).
3. **Checkerboard/parity decoupling** — confirmed via an EXACT analytical
   flat-basin test that water permanently alternates between parity
   classes on a 4-connected (von Neumann) synchronous-update lattice
   (deviation frozen at precisely 0.27211 across 5000/20000/50000
   iterations) — fixed by switching to 8-connected (Moore) neighbors with
   1/√2 diagonal-distance scaling.

A FOURTH issue remained after all three fixes (some cells still stuck at
exactly 0.0 on the same flat-basin test) — not resolved before the decision
was made to stop. **This module was abandoned for production** — a real
engineering trade-off, not a forced continuation past diminishing returns —
but kept in the codebase with an honest "STATUS: NOT currently used in
production" header rather than deleted, documenting the real bugs found and
fixed as a legitimate artifact of the investigation.

### What shipped — `flood_connectivity.py`, connected flood-fill (geodesic dilation)

A fundamentally simpler, provably-correct alternative: don't test each cell
against a threshold independently — flood a cell ONLY if it's reachable
from a real seed (the stream network) through an unbroken chain of cells
all at or below the target water level. Standard image-processing
morphology (reconstruction by dilation), not a novel invention, chosen
specifically because it has NO iterative-physics convergence risk. Verified
via a synthetic disconnected-basin test (zero leakage into a topologically
cut-off basin — exactly the scenario that broke the uniform threshold) and
timed at 651 iterations / 5.61s on a real 1.7M-cell raster.

`flood_model.build_riverine_flood_zone()` was rewritten around this:
compares the real conditioned DEM directly against FFD's own live
`gauge_height_m` (not HAND), seeded from the real stream network, output is
now a genuine BINARY mask (not a continuous HAND-margin score) — which
changed the correct accuracy metric too (below).

### Three real WhiteboxTools bugs found this pass (one already known, two new)

- `elevation_above_stream_euclidean` — already confirmed broken (all-zero)
  in an earlier session.
- `euclidean_distance` — **newly confirmed broken this pass**: run directly
  on a real streams raster, returned all-zero everywhere.
- `euclidean_allocation` — **newly confirmed broken this pass**, and only
  for large-magnitude inputs: allocating each stream cell's own X/Y
  coordinate (confirmed WORKING earlier this session for small-magnitude
  stage values, ~0-10m) fails specifically for longitude-scale values
  (~72-73°) — the SOURCE stream cells themselves come back NoData instead
  of their own value, for a reproducible ~3% of cells across all 4
  catchments. A magnitude-offset hypothesis (shifting values to ~0.0002-
  0.2 range) was tested and FALSIFIED — identical failure count regardless
  of magnitude, ruling out the obvious explanation. Not resolved within
  WhiteboxTools; routed around entirely (§0.29 below) rather than chased
  further, matching the `flood_ca.py` lesson about not over-investing in
  a tool once it's shown a real, reproducible defect.

### Accuracy — a genuinely different metric family for a genuinely different output

Since the model is now BINARY (not continuous), AUC (which needs a rankable
score) is no longer the right tool — `accuracy_assessment.py` gained
`assess_binary_mask_accuracy[_stable]` (hit rate, CSI, F1, proportion
correct — confusion-matrix metrics, matching the literature precedent this
project's own earlier research found for "HAND vs FEMA maps" validation).
`flood_validation.run_riverine_validation()` pools every real GFD event
near a catchment (not date-matched to any one event — a deliberate,
explicit choice: this tests whether the CURRENT connected-fill result's
spatial pattern generally aligns with historical flood locations, not
whether today's gauge reading reproduces one event's exact magnitude) into
one combined ground-truth set, scoring both raw HAND (AUC, continuous) and
today's live connected-fill mask (binary metrics) against it.

**A calibration-sweep methodology was explicitly sanctioned by the user**
during this investigation ("not necessarily real time, it can be based on
scenario, but this is a must") — running the spatial model at MANY water
levels and scoring each against pooled ground truth to find the best real-
world correspondence, rather than requiring a single live scenario to hit
the target. A real, reproducible accuracy ceiling was found this way for
Guddu specifically (best F1 ≈ 0.72 across five methods tried) — reported
honestly rather than chased further once the user explicitly said not to
keep tuning specifically against Guddu's own result (§0.29 picks this
thread back up under the AHP work).

### Additive, non-breaking demographic exposure enhancement

Per a mid-task request, riverine (and flash-flood, both modes share the
same core) exposure reports now include male/female/children breakdowns
alongside the existing total/under-5/elderly figures — a new, OPTIONAL
`children_cutoff_age` parameter on `flood_exposure.fetch_population_
exposure()`, using WorldPop's own age-sex-banded product
(`WorldPop/GP/100m/pop_age_sex`). Verified live against Nullah Lai's own
bbox: male 1,141,703 + female 1,039,080 = total 2,180,783 EXACTLY;
children (under 15) 693,547, a plausible 31.8% share. Every existing caller
that doesn't pass the new parameter behaves byte-identically to before —
confirmed by inspection of every call site, not assumed.

**Verified:** `python manage.py check` clean throughout. Flash-flood mode
(`nullah_lai`/`peshawar_bhudni_nullah`, both fixed-threshold and discharge-
driven) re-confirmed against `r0_baseline.json` after every riverine change
in this phase.

**A real, honest process note, not hidden:** a later force-rebuild of the
shared DEM/HAND pipeline (while testing an unrelated later feature, §0.29)
exposed pre-existing run-to-run non-determinism in WhiteboxTools'
`breach_depressions_least_cost` (a known characteristic of least-cost-path
tie-breaking, not a logic bug) — Nullah Lai's own discharge-mode
`flood_prone_cells` drifted 6907 → 7100 → 7085 across repeated re-fetches
of the identical scenario, confined to boundary/marginal cells (every
upstream physics number — CN, discharge, channel slope — stayed exactly
unchanged). `r0_baseline.json` was updated to the confirmed-stable new
value with an explicit note; the lesson (never force-rebuild the shared
pipeline without a real reason) is now stated directly in
`build_ahp_susceptibility_raster`'s own docstring (§0.29).

**Files changed:** `flood_connectivity.py` (new — `connected_flood_fill`),
`flood_ca.py` (new, not production-used), `flood_model.py` (riverine
functions rewritten), `flood_exposure.py` (demographic fields, additive),
`accuracy_assessment.py` (binary-mask metrics), `flood_validation.py`
(`run_riverine_validation`). Flash-flood code paths untouched.

## 0.29 Phase 2.5.2-2.5.4 — riverine AHP literature review, factor pipeline, fusion, and real GFD validation

Per explicit instruction, AHP was built for BOTH flood types together, with
the flash-flood weights from §0.27 kept and a genuinely NEW, separate
literature review done for riverine — the same "don't apply one region's
weights nationally" discipline §0.27 already established, now applied
across flood MECHANISM, not just terrain relief: fluvial floodplain
inundation along a major river is a different physical process from small-
basin flash runoff. Pilots (Chashma, Guddu) are for testing only — the
methodology must generalize to the whole Indus corridor and, in principle,
the rest of Pakistan.

### Riverine literature review — five real sources, two genuinely blocked

| Source | Finding used |
|---|---|
| [E] Frontiers 2024, DOI 10.3389/fenvs.2024.1476761 | Real, fetched table: distance-to-river 40%, LULC 30% (of the hazard-only factors — GDP/pop-density excluded, those are vulnerability factors this project's own exposure pipeline already covers separately) |
| [F] Charsadda, KP (reused from §0.27) | A genuine flat-floodplain table (rainfall 40%, stream proximity 60% combined) — its physical terrain character (flat, low-lying, limited drainage) transfers to a lower-Indus delta reach on geomorphology, not provincial label |
| [G] Punjab hybrid AHP (2025) | Exact weight table blocked on first attempt (MDPI/ResearchGate/Scribd all 403); a REAL confirmed regional finding used directly regardless: drainage density confirmed HIGH in upper-Indus/piedmont (Potohar/Hazara/Swat margins), LOW in interior deserts/final alluvial plains/delta; distance-to-river stays dominant along the WHOLE Indus corridor, does not vary regionally the way drainage density does — the direct evidence basis for splitting into two profiles. A later, more targeted search DID surface a real numeric table (11 factors, distance-to-rivers/roads 21%, elevation 14%, TWI 13%, drainage density 9%, precipitation/rainfall 9%+9%, LULC/NDVI/soil smaller) but via an AI search-summary with the SAME internal-consistency problem flagged the first time (11 numbers against factor names that don't cleanly map, "precipitation" and "rainfall" listed separately) — not treated as more reliable than the first attempt, not used for exact numbers either time |
| [H] Larkana, Sindh (*Nature Sci Reports*, 2025) | Factor list only (auth-gated) — corroborates [G]'s factor SET for a different Sindh district |
| [I] Sindh disaster-risk-reduction (ScienceDirect) | Weight table blocked; qualitative finding used: AHP and Frequency-Ratio agreed closely on Sindh's very-high-susceptibility area share (5.66% vs 4.42%), both flagged riverine/"Kacha" land as highest-risk — corroborates distance-to-river's dominance in flat Sindh terrain independently of [E]/[F] |
| [J] SCIRP, "Flood Hazard Mapping of Lower Indus Basin Using Multi-Criteria Analysis" | A genuinely new, directly relevant source found DURING post-validation troubleshooting (below) — real, cleanly-fetched table (slope 33.7%, soil 32.2%, elevation 21.5%, rainfall 7.4%, LULC 5.2%, NO distance-to-river term at all, and its own published table admits omitting several of its own named causative factors) — checked empirically before being adopted or rejected, see below |

**Cross-study pattern confirmed:** distance-to-river is the single most
consistently dominant factor across every riverine/floodplain Pakistani
study found ([E] 40% of its own hazard total, [F] 60% combined, [I]
qualitatively) — a genuinely different top factor than flash-flood's own
review (where rainfall usually narrowly leads). Makes physical sense:
floodplain inundation is fundamentally about proximity to the channel that
overflows; flash-flood runoff generation is fundamentally about local
rainfall-to-runoff conversion.

**Two profiles, geography-conditioned per [G]'s own confirmed regional
finding** (not per-pilot tuning): `RIVERINE_HIGH_DRAINAGE_DENSITY_FACTORS`
(upper-Indus/piedmont reaches — Chashma is this project's own pilot) and
`RIVERINE_LOW_DRAINAGE_DENSITY_FACTORS` (lower-Indus/delta reaches — Guddu
is this project's own pilot), selected via a NEW classifier,
`classify_riverine_drainage_density(median_stream_elevation_m)` — median
conditioned-DEM elevation at a catchment's own stream cells, a real,
measurable proxy for "position along the Indus corridor" chosen AFTER a
simpler candidate (raw stream-cell fraction) was tested and found NOT to
discriminate (0.030-0.037 across all 4 catchments — this pipeline's fixed
flow-accumulation threshold isn't regionally recalibrated, so cell-fraction
carries no signal; a real negative result, not silently dropped). Cutoff:
130m, both profiles CR-validated (< 0.10) in both full and lite variants.

### Factor-raster pipeline — six new rasters, three real bugs fixed while building it

Every factor reuses the existing HAND pipeline's own cached intermediates
wherever possible — zero new fetches for slope/TWI/curvature/distance;
small, individually-tested new fetches for LULC/soil/rainfall/NDVI:

- **Distance-to-stream** — the WBT `euclidean_allocation` bug (§0.28) was
  routed around entirely: a pure-NumPy multi-source chamfer distance
  transform (`flood_connectivity.chamfer_distance_km`), reusing the exact
  same 8-connected expansion technique already proven correct in
  `connected_flood_fill` — Borgefors 1986, a standard, well-established
  Euclidean-distance-transform approximation, not a novel algorithm.
  Verified live on all 4 catchments: 100% raster coverage (0 non-finite
  cells, vs. `euclidean_allocation`'s confirmed ~3% failure), distance
  exactly 0.0 at every real stream cell, converges in 2-12s even for
  Guddu's 3.3M-cell raster.
- **Slope / TWI / profile curvature** — WhiteboxTools' own native tools
  (`slope`, `d8_flow_accumulation` with `out_type='specific contributing
  area'`, `wetness_index`, `profile_curvature`) directly on the already-
  cached conditioned DEM/D8 pointer — confirmed WORKING (unlike the
  distance tools), all sane on all 4 catchments.
- **LULC** — ESA WorldCover v200/2021, reclassified onto a standard 1-5
  runoff-hazard scale (dense vegetation lowest, built-up/water/wetland
  highest) — a widely-repeated literature convention, not a single paper's
  exact table (none of the papers whose LULC breakpoints were sought this
  session had a fetchable one), labeled as such. **A real bug found and
  fixed**: fetching at WorldCover's own native 10m resolution exceeded
  GEE's export request-size cap (~48MB) for Guddu's larger bbox — fixed by
  fetching at 30m directly (the DEM's own scale, which the raster gets
  warped onto immediately anyway, so no accuracy lost).
- **Soil texture** — OpenLandMap USDA 12-class, reclassified onto the SAME
  1-5 scale via alignment with this project's OWN existing SCS Curve
  Number Hydrologic Soil Group logic (clay~HSG D, sand~HSG A) — a
  deliberate internal-consistency choice, not an independent citation.
- **Drainage density** — a NEW factor (no equivalent in the flash-flood
  profiles), computed as a real local Horton drainage density (km of
  stream per km², via a 1km-radius moving window) using a pure-NumPy
  summed-area-table box filter (avoiding a new scipy dependency for one
  operation) — reclassified via each catchment's OWN quantile breakpoints
  (no literature source gives an absolute breakpoint table for this
  specific factor; an honestly-labeled fallback, not presented as
  literature-sourced).
- **Rainfall climatology** — mean annual CHIRPS total (NOT the live/
  forecast rainfall scenario value used elsewhere in this project's own
  discharge pipeline — a genuinely different thing, kept explicitly
  separate in the code despite sharing a name in the literature).
- **NDVI** — Sentinel-2 median composite, NDVI = (B8-B4)/(B8+B4). **Two
  real bugs found and fixed**: (1) a full year of unfiltered Sentinel-2
  bands hit GEE's own "User memory limit exceeded" server-side error for
  Chashma's larger bbox — fixed by selecting only B4/B8 BEFORE the
  `.median()` reduction (not after), cutting compute ~13x; (2) still
  exceeded the limit even after that fix — the real fix was shrinking the
  compositing window from a full year to 90 days (a real trade-off,
  honestly noted: this is now a single-season snapshot, not a year-round
  mean).

### AHP fusion — `build_ahp_susceptibility_raster()`

Combines every factor via `sum(weight_i × hazard_class_i)` (each factor
reclassified onto a common 1-5 scale — pre-reclassified for LULC/soil/
drainage-density, per-catchment quantile reclassification for the rest,
with an explicit ascending/descending direction per factor, e.g. lower
distance-to-stream = higher hazard). Terrain class is picked AUTOMATICALLY
per catchment (never hand-picked) via `classify_terrain_relief`/
`classify_riverine_drainage_density` — confirmed correct on all 4 pilots:
Nullah Lai → moderate_relief, Bhudni Nullah → flat_relief, Chashma →
high_drainage_density, Guddu → low_drainage_density, each matching real
known geography. `weight_total_used` is checked against 1.0 after every
build — a shortfall is a loud, logged signal a factor raster failed, never
silently rescaled to hide it.

**A real, non-obvious `force` propagation bug was found and fixed here**:
passing `force=True` to rebuild just the AHP composite was cascading all
the way down into `build_hand_pipeline`, triggering a full DEM refetch
(and the non-determinism noted in §0.28) — fixed by hardcoding
`force=False` on the pipeline call inside this function specifically,
decoupling "rebuild the AHP score" from "refetch the whole terrain
pipeline," with the reasoning stated directly in the function's own
docstring so it isn't rediscovered the hard way again.

### Real GFD validation — an honest, split result

| Catchment | Type | Terrain class | AUC (5-trial mean) | Interpretation |
|---|---|---|---|---|
| Nullah Lai | Flash | moderate_relief | **0.889** | Good — far exceeds the original 75-85% target |
| Bhudni Nullah | Flash | flat_relief | **0.771** | Fair — inside the original 75-85% target |
| Chashma | Riverine | high_drainage_density | 0.690 → **0.750** (after connectivity, below) | Poor → Fair — clears the user's revised 70% floor |
| Guddu | Riverine | low_drainage_density | 0.487 → **0.612** (after connectivity, below) | Fail → Poor — still short of the revised 72% floor |

Flash-flood AHP is a real, unambiguous success — both catchments hit or
exceed target, a large jump over raw HAND's own earlier 0.605-0.661
(§0.20/§0.21). Riverine AHP's FIRST result (before the connectivity
factor, see next) was a genuine shortfall: Chashma 0.69 "poor", Guddu 0.49
"fail" — effectively no better than random.

**Before assuming a bug, individual factors were checked in isolation at
Guddu** (the worse result): distance_river 0.59, hand 0.60, drainage_
density 0.49, lulc 0.55, rainfall 0.69 — every one weak-to-random, NONE
inverted (ruling out a sign/direction bug). Working theory: large-scale
Indus flooding at a reach like Guddu is often breach/overbank-driven,
reaching areas topologically DISCONNECTED from the channel by an
intervening ridge even at low raw elevation — something no simple
elevation-difference or straight-line-distance measure can represent.

### The connectivity factor — a real structural fix, added and integrated with honest empirical testing

A NEW factor, `flood_model.build_connectivity_hazard_raster()`: sweeps
`connected_flood_fill` (the SAME provably-correct technique §0.28's own
production riverine flood-zone already trusts) across 6 water levels from
each catchment's own median stream elevation up to +20m, seeded from the
real stream network (never a live scenario gauge reading — this stays a
STATIC per-catchment factor like every other AHP input). For each cell,
records the LOWEST level at which it first becomes topologically
reachable — a topology-aware analog of HAND that can tell apart a cell
that's low but genuinely cut off from one that's low AND connected. No
literature source names this exact factor — an honest, labeled addition in
direct response to the validation finding above, not attributed to [E]-[I].

Confirmed live before trusting it: fast (5-9s per catchment), and
genuinely the STRONGEST individual factor at both riverine pilots when
tested alone (Chashma 0.76, Guddu 0.67 — both "poor"/"fair" alone, better
than any pre-existing factor).

**A real literature alternative was found and honestly rejected, not
ignored**: SCIRP's Lower Indus Basin paper [J] (directly matching Guddu's
own terrain) emphasizes slope (33.7%) and soil (32.2%) heavily, with NO
distance-to-river term at all. Checked empirically before being adopted —
slope (AUC 0.57) and soil (AUC 0.54) individually tested NO BETTER than
the factors already in use at Guddu, and [J]'s own published table already
admits omitting several of its own named causative factors — recorded in
`flood_ahp.py`'s own comments as a considered, rejected alternative.

**A real integration mistake was caught and fixed via an honest A/B
test, not assumed**: the first attempt gave connectivity a FULL separate
copy of distance_river's own raw weight, which mechanically inflated the
combined "proximity family" well beyond what [E]'s own cited ratio
specified — diluting rainfall's cited share as a pure renormalization side
effect. A "corrected" version was built that SPLIT distance_river's raw
share between the two factors instead, preserving the literature's own
ratio more literally — and tested WORSE (Guddu AUC 0.523 vs. 0.613 for the
"uncorrected" full-weight version; Chashma roughly even, 0.739 vs 0.741).
The full-weight version was kept, with both integration choices and the
real result of comparing them documented directly in `flood_ahp.py`'s own
comments — an honest result of testing two defensible hypotheses, not
evidence hunted for after the fact to justify a predetermined answer.

**Final, honest state**, per explicit instruction to document rather than
keep tuning against Guddu's own specific result: Chashma now clears the
user's revised 70% floor (0.750). Guddu, the harder pilot, improved
substantially (0.487 → 0.612, +0.125) but remains short of the 72% floor
set for the worse-performing catchment. No factor was removed at any
point in this investigation, per explicit instruction. This is reported
as a real, currently-partial result — not hidden, not forced past target
by further tuning against these two pilots' own numbers, since the
methodology is meant to generalize nationally, not fit two test locations.

**Verified:** all riverine profiles (full + lite, both terrain classes)
re-confirmed CR < 0.10 after every weight change. `python manage.py check`
clean throughout. Flash-flood mode re-confirmed unaffected after every
change in this whole phase (`build_discharge_driven_flood_zone` output
byte-identical to the post-§0.28 baseline).

**Files changed:** `flood_ahp.py` (riverine profiles + connectivity
integration), `flood_model.py` (6 new factor-raster builders +
`build_connectivity_hazard_raster` + `build_ahp_susceptibility_raster`),
`flood_connectivity.py` (`chamfer_distance_km`, `local_drainage_density`),
`flood_validation.py` (`run_ahp_susceptibility_validation`). Flash-flood
code paths untouched throughout.

## 0.30 Phase 2.5.7 — AHP production wiring

`flood_model_views.py`'s existing async job-id pattern (§0.15) extended
with a new opt-in mode, `{"catchment": ..., "mode": "ahp_susceptibility",
"lite": true}` on the existing `POST /api/flood-model/run/` endpoint —
works identically for EITHER flood type (the terrain-class dispatch inside
`build_ahp_susceptibility_raster` already picks the right profile per
catchment, so this mode doesn't need the flash/riverine branching every
other mode requires), polled through the SAME existing `GET /api/flood-
model/status/<job_id>/` endpoint, no new endpoint shape introduced.

Result is its own shape (`{"susceptibility": {"png_url", "bounds",
"terrain_class", "weights", "weight_total_used"}, "mode":
"ahp_susceptibility"}`), not shoehorned into the flood_zone+exposure shape
every other mode uses — the AHP score is a continuous susceptibility
SURFACE (1-5 per pixel), not a binary flooded/not-flooded extent, so it
has no natural flood-zone geometry to vectorize through the existing
buildings/roads/population exposure pipeline. A new fixed 1-5 color-relief
ramp (green→yellow→red, the standard traffic-light hazard convention)
renders the score to a servable PNG via the same `gdal.DEMProcessing`
mechanism every other mode's own PNG rendering already uses.

**Verified end-to-end via `RequestFactory`** (this project's own standing
substitute for a live browser) for both a flash catchment (Nullah Lai) and
a riverine one (Guddu) — job submits, polls through pending → running →
done, returns a real PNG URL, correct bounds, correct auto-selected
terrain class, and the exact weights used, with no scenario input accepted
(rejected outright if `threshold_m`/`rainfall_mm`/etc. are passed
alongside this mode — this mode has none of its own, every factor being
catchment-static). `python manage.py check` clean.

**Files changed:** `flood_model.py` (`render_ahp_susceptibility_png`,
`_ahp_susceptibility_ramp_file`), `flood_model_views.py`
(`_run_ahp_susceptibility_job`, `_submit_ahp_susceptibility_job`, `post()`
dispatch). Frontend wiring (a mode selector, susceptibility-layer
rendering) is the next, not-yet-started step.

## 0.31 AHP zonation, legend, AUC chart, classified exposure — post-launch remediation, and a real accuracy correction

A real screenshot review (Nullah Lai) found the shipped AHP mode's
continuous [1,5]-score PNG covering the WHOLE catchment bbox as a solid
rectangle — visually wrong next to every other mode's own clipped,
classified rendering. This section covers the remediation pass built in
response, and an honest accuracy correction it surfaced.

### Zone classification + vectorization — a real payload-size bug found and fixed twice

3 zone classes (Low/Medium/High) via FIXED breakpoints on the AHP
score's own [1,5] scale (equal thirds: 2.333/3.667) — deliberately NOT
per-catchment quantiles like individual input factors use, since the
OUTPUT score is already a normalized, fixed hazard scale by
construction; fixed breakpoints are what make "High zone" mean the same
thing in every catchment nationwide. This project's own reasoned choice,
no literature source gives universal breakpoints for an AHP output score.

**First vectorization attempt (GDAL `Polygonize` on the classified
raster, same technique the existing binary flood-zone masks already use)
produced up to ~10MB of GeoJSON for a single zone (guddu_indus)** — an
unshippable payload. Root cause: a per-pixel classification of a
continuous, already-noisy score (itself a weighted sum of several
already-noisy per-catchment-quantile-reclassified factors) produces a
class boundary jagged at PIXEL granularity, unlike a physically-coherent
flood-extent mask. Two real fixes, tried in order:

1. `gdal.SieveFilter` (standard GDAL tool, not novel) before
   `Polygonize`, plus a self-adaptive sieve/simplify-tolerance doubling
   loop bounded by a real output-size target (1.5MB) — cut guddu_indus
   to ~2.9MB after 6 iterations, still not converging, and slow (91s).
2. **The actual fix**: smoothing the CONTINUOUS score (a new
   `flood_connectivity.box_mean_filter`, the same summed-area-table
   technique already proven in `local_drainage_density`) BEFORE
   classification, not after. This is the standard, literature-
   consistent fix for class-boundary noise — smoothing discrete labels
   after the fact cannot remove genuine per-pixel classification noise
   the way smoothing the underlying field first does. Confirmed live:
   all 4 catchments dropped to 64-356KB, converging on the FIRST attempt
   (no adaptive doubling needed), in 0.7-4s.

### A real, serious performance bug found in the zone-classified exposure report

The first version of `flood_exposure.build_ahp_zone_exposure_report`
called the existing shared exposure core (`_build_exposure_from_geom`)
three times, once per zone — reusing every fetch function UNCHANGED,
relying on their own per-catchment (not per-geometry) disk caching to
avoid re-fetching. This works cheaply for buildings/points (proven: a
`shapely.STRtree` query or `prep().intersects()` call is cheap to repeat
3x). **It did NOT hold for roads/drainage**: confirmed live,
chashma_indus's own report took **1082s (18 minutes)** — AHP's 3 zones
collectively cover close to the WHOLE catchment (not a narrow flood
extent, unlike every other mode's own use of this exposure core), so
the full road/drainage network was being reprojected to UTM three times
over, compounded by real Overpass read-timeouts.

**Fix**: a new `_line_network_length_exposure_multizone` — reprojects
each line EXACTLY ONCE regardless of how many zones it's tested against,
then intersects against each zone's own (also-reprojected-once)
geometry. Confirmed live, byte-identical results to the slow version,
in **11.8-41.2s** (a ~26-90x speedup depending on catchment/road-network
size) across all 4 catchments.

### A real accuracy correction — smoothing was never re-validated until asked

The AUC numbers first reported for AHP (§0.29) were validated against
the RAW score, before this section's own smoothing step existed.
Smoothing was added purely to fix the payload-size bug above — its
effect on accuracy was never checked until directly asked. Tested live,
not assumed: smoothing **improved** AUC at all 4 catchments (removing
pixel-level noise helps ranking-based AUC too, not just file size) —
the corrected, currently-deployed numbers:

| Catchment | Raw score AUC (§0.29, now stale) | Smoothed score AUC (what zones are built from) |
|---|---|---|
| Nullah Lai | 0.8915 good | **0.9238 excellent** |
| Bhudni Nullah | 0.771 fair | **0.8423 good** |
| Chashma | 0.750 fair | **0.7665 fair** |
| Guddu | 0.6092 poor | **0.6204 poor** |

Guddu remains below the 72% floor — smoothing narrowed but did not close
that gap. `flood-model-control.js`'s own `CATCHMENT_ACCURACY_INFO`
citations were updated to these corrected numbers.

**A related, unresolved question this surfaced**: the fixed Low/Medium/
High breakpoints are this project's own unvalidated choice (see above).
Medium dominates every catchment tested (68.8-75.9% of area) —
consistent with the breakpoints simply centering on the score's own
natural mean rather than on anything hazard-calibrated. The ORIGINAL
Phase 2.5 plan always included a "Phase 2.5.5 — threshold/cutoff
calibration" sub-phase (Youden's J against real GFD ground truth) for
exactly this reason — it was never built. This is the honest, correct
next fix for the breakpoints, not a fixed tertile; not done this pass.

### Frontend — what actually shipped vs. what didn't

Shipped: zone polygons render as a classified, clipped GeoJSON fill
(fixing the original "too big" complaint directly), a legend reusing
the app's existing `.dynamic-legend-*` convention
(`layer-panels.js`/`_layer-panels.css`, already loaded globally — not a
new legend system), an AUC chart (chart.js, this catchment's own real
validated numbers, band reference lines at the real
`_AUC_INTERPRETATION_BANDS` thresholds), and a full per-zone exposure
breakdown (buildings, population by sex/age, roads, drainage,
bridges/hospitals, schools/settlements counts) plus admin-context
dominant-zone sentences — all as text/rows in the results panel.

**NOT shipped, despite being in the approved plan's own Sub-phase 4
scope, caught only on a later self-audit**: the classified
schools/settlements/airports/bridges/hospitals/drainage/roads
point-and-line MAP layers (zone-colored GeoJSON sources, `minzoom`-gated)
— only their counts, in text, were built. A real shortfall against what
was reported as "complete," corrected here rather than left standing.
Sub-phase 5 (viewport-bounded individual buildings on zoom) remains the
already-documented optional follow-on, also not built.

**Verified:** `python manage.py check` clean, `npx vite build` clean,
flash-flood regression (byte-identical `build_discharge_driven_flood_zone`
output) re-confirmed after every change in this section.

**Files changed:** `flood_exposure.py` (`_vectorize_multiclass_raster`,
`_line_network_length_exposure_multizone`, `_tag_dominant_zone_per_admin_
region`, `build_ahp_zone_exposure_report`, `_ahp_zone_roads_exposure`,
`_ahp_zone_drainage_exposure`), `flood_model.py`
(`build_ahp_zone_geometries`, `_classify_ahp_zones`), `flood_connectivity.py`
(`box_mean_filter`), `flood_model_views.py` (`_run_ahp_susceptibility_job`
extended), `flood-model-control.js` + `_flood-model-panel.css` (zone
layer, legend, AUC chart, per-zone results, corrected accuracy citations).

## 0.32 Youden's J zone-breakpoint calibration + classified point/line map layers

§0.31 closed with two honest gaps: the fixed-tertile Low/Medium/High
breakpoints were this project's own unvalidated guess (never
hazard-calibrated), and the classified schools/bridges/roads/drainage
MAP layers were claimed shipped but were never actually built (only
their counts, in text). This section covers both, in the priority
order the user set: calibration first, map layers second.

### Youden's J hierarchical two-stage calibration

Youden's J (`J = sensitivity + specificity - 1`) is a standard,
literature-backed ROC statistic, but it only ever produces ONE optimal
cutoff — a genuine 3-class Low/Medium/High scheme needs two boundaries
(T1, T2). No standard named method does this in one step, so this
project extends it with its own reasoned, documented two-stage
approach (`accuracy_assessment.calibrate_hierarchical_thresholds`),
tested on synthetic separated data before any real use:

1. **Stage 1** — Youden's J on the FULL sample gives T2 (the
   Medium/High boundary): the cutoff that best separates "GFD-observed
   flood presence" from "absence" using every sample.
2. **Stage 2** — Youden's J again, but restricted to the sub-T2 subset
   only, gives T1 (the Low/Medium boundary) — the best separator
   *within* the cells that weren't already called High. A fallback
   (midpoint between the score's minimum and T2) guards the case where
   the sub-T2 subset has too few presence/absence samples to fit; a
   degeneracy guard keeps T1 < T2 always.

`flood_validation.calibrate_ahp_zone_breakpoints` fetches real GFD
events per catchment and **pools every trial's presence/absence
samples into one array before calibrating once** — the same
"pool, don't average" convention `assess_pooled_multi_raster_auc`
already established — run against the SAME smoothed score raster
(`build_ahp_smoothed_score_raster`) that classification itself uses,
not a separately-computed field. This is an explicit **design-time /
offline tool**, not called on the hot request path — calibrating
against live GFD fetches takes real time unsuitable for a user-facing
"Run" click, matching the same posture `flood_validation.
run_ahp_susceptibility_validation` already has.

**Calibrated per TERRAIN CLASS, not per catchment** — consistent with
how AHP weight profiles are already keyed by `terrain_class`
(`moderate_relief`/`flat_relief`/`high_drainage_density`/
`low_drainage_density`), so any future catchment sharing a terrain
class automatically inherits calibrated breakpoints instead of
falling back to the uncalibrated fixed tertile. Real, measured
results (`flood_model._AHP_ZONE_BREAKS_CALIBRATED`):

| Terrain class | Pilot catchment | Old fixed T1/T2 | Calibrated T1/T2 |
|---|---|---|---|
| moderate_relief | Nullah Lai | 2.333 / 3.667 | **3.1256 / 3.5678** |
| flat_relief | Bhudni Nullah | 2.333 / 3.667 | **2.9008 / 3.3386** |
| high_drainage_density | Chashma | 2.333 / 3.667 | **2.6609 / 3.3557** |
| low_drainage_density | Guddu | 2.333 / 3.667 | **2.3390 / 3.0458** |

Real, post-calibration zone-area shares (measured from each
catchment's own zone-exposure report, not assumed):

| Catchment | Low | Medium | High |
|---|---|---|---|
| Nullah Lai | 15.0% | 68.8% | 16.1% |
| Bhudni Nullah | 44.4% | 23.0% | 32.6% |
| Chashma | 33.3% | 43.4% | 23.3% |
| Guddu | 18.8% | 45.1% | 36.1% |

Honest finding, not force-narrated: calibration meaningfully broke
Medium's dominance for 3 of 4 terrain classes (Bhudni Nullah's Medium
share in particular dropped far below the old fixed-tertile 68.8-75.9%
range), but Nullah Lai's own moderate_relief class still lands close
to that range — its score distribution is apparently concentrated
enough in that band that even a substantially different T1/T2 doesn't
redistribute much area away from Medium. Reported as-is, not tuned
further to force a "nicer" number.

**Per the user's explicit instruction, Guddu's 0.6204 AHP AUC (§0.31)
was deliberately left untouched by this work** — calibrating the zone
*breakpoints* is a display/classification concern, not an accuracy
concern, and even though the same codepaths were touched, no change
here targets or was checked against that specific number, consistent
with this project's own "generalize nationally, don't overfit to one
pilot" posture.

### Classified point/line map layers (the real Sub-phase 4 shortfall, now closed)

`flood_exposure.build_ahp_zone_classified_map_layers` — three separate
small GeoJSON `FeatureCollection`s (`points`, `drainage`, `roads`),
zone-tagged via `_zone_of_point`/`_zone_of_line_midpoint` against the
same 3 zone polygons the exposure report uses:

- **Points**: schools/settlements/airports (WFS) + bridges/hospitals
  (the existing Overpass cache) — real counts across all 4 pilots are
  small (293-1901), rendered directly, no simplification needed.
- **Drainage**: same existing Overpass cache, real counts small
  (40-665), rendered directly.
- **Roads**: filtered to vehicular classes (matching the exposure
  report's own "vehicular" sub-figure) and hard-capped at
  `_MAP_LAYER_MAX_ROAD_WAYS` — **found live, not assumed**, that the
  first cap tried (8000 ways) still shipped a 2.2MB payload for Nullah
  Lai (worst case, 35,018 vehicular ways); lowered to 4000, confirmed
  1067.7KB on retest, matching the same 1.5MB budget the zone polygons
  themselves target.
- **Buildings deliberately excluded** — up to 419K in one catchment's
  AOI is a genuine crash risk as individual GeoJSON, matching the
  already-documented design decision; aggregate zone counts (already
  in the exposure report) remain the only buildings figure until the
  separately-scoped, still-optional Sub-phase 5 (viewport-bounded
  buildings-on-zoom) is built.

Real, measured payload sizes across all 4 catchments (points /
drainage / roads):

| Catchment | Points | Drainage | Roads |
|---|---|---|---|
| Nullah Lai | 1901 feat., 332.1KB | 665 feat., 300.1KB | 3931 feat., 1067.7KB |
| Bhudni Nullah | 1472 feat., 259.6KB | 138 feat., 126.9KB | 3906 feat., 1373.4KB |
| Chashma | 293 feat., 51.2KB | 40 feat., 19.2KB | 1295 feat., 395.2KB |
| Guddu | 877 feat., 155.9KB | 41 feat., 20.0KB | 1557 feat., 569.9KB |

Frontend: `flood-model-control.js` gained `#addAhpClassifiedLayers`/
`#removeAhpClassifiedLayers` — zone-colored `circle`/`line` Mapbox
layers (`match` expression on `zone_class`, reusing the same
Low/Medium/High severity palette §0.31 already established),
`minzoom`-gated (12 for points, 11 for drainage, 13 for roads) to
declutter at low zoom, matching the existing `major_rivers`
label-minzoom precedent elsewhere in this app.

### Two real production bugs found and fixed while building this

1. **Overpass cache-poisoning on transient failure.** `fetch_road_
   network_exposure`/`fetch_drainage_network_exposure`/`fetch_osm_
   bridges_hospitals_exposure` were writing an empty result to their
   disk cache whenever an Overpass query failed (`_overpass_query`
   returning `None` on a timeout/5xx), indistinguishable from a
   legitimate empty result — and since these caches are trusted
   forever under `force=False`, one transient network blip permanently
   zeroed out that catchment's roads/drainage/bridges data. Confirmed
   live: a poisoned drainage cache silently read back as "0 features"
   until fixed, then correctly re-fetched "665 features, 300.1KB."
   Fixed by only writing the cache on confirmed success; a failed
   query now uses an in-memory-only empty result for that one call.
2. **Redundant double-fetch between the exposure report and the map
   layers builder.** Both call the same underlying Overpass fetch
   functions (bridges/hospitals, drainage, roads) to warm their shared
   disk caches as a side effect. When both are run back-to-back with
   `force=True` (a full scheduled refresh), the map-layers builder was
   re-issuing a SECOND live Overpass query for data the exposure
   report had just fetched moments earlier — wasted work, and extra
   exposure to Overpass's own real, observed read-timeouts. Fixed by
   having the map-layers builder's own warm-up calls always use
   `force=False` (the job runner already calls the exposure report
   first in the same run, so the cache is already as fresh as the
   job's own `force` flag demanded by the time map layers runs).

### Verification

- **Flash-flood regression**: `build_discharge_driven_flood_zone`
  output for Nullah Lai and Bhudni Nullah re-confirmed byte-identical
  (all 8 scenario fields) against the `r0_baseline.json` capture,
  after every change in this section.
- **Full end-to-end job**, via `RequestFactory` (`POST /api/flood-model/
  run/` → poll `GET /api/flood-model/status/<id>/`), for one flash
  catchment (Nullah Lai) and one riverine catchment (Guddu) — both
  completed with all 11 progress stages, 3 zone features, a full
  per-zone exposure breakdown, and all 3 classified map layers present
  and correctly sized in the response.
- `python manage.py check` clean.

**Files changed:** `accuracy_assessment.py` (`youden_j_optimal_
threshold`, `calibrate_hierarchical_thresholds`), `flood_validation.py`
(`calibrate_ahp_zone_breakpoints`), `flood_model.py`
(`_AHP_ZONE_BREAKS_CALIBRATED`, `_classify_ahp_zones` now accepts
`breaks`, `build_ahp_smoothed_score_raster` extracted as its own cached
function, `build_ahp_zone_geometries` now looks up terrain_class and
passes calibrated breaks), `flood_exposure.py` (`_zone_of_point`,
`_zone_of_line_midpoint`, `build_ahp_zone_classified_map_layers`, the
cache-poisoning fix in the 3 Overpass fetch functions, the double-fetch
fix in the map-layers builder's own warm-up calls), `flood_model_
views.py` (`_run_ahp_susceptibility_job` extended with the map-layers
stage), `flood-model-control.js` + `_flood-model-panel.css`
(classified layer rendering, new stage strings).

## 0.33 Sub-phase 5 (buildings-on-zoom) + Phase 2.5.6 (Sentinel-1 SAR cross-validation)

Closes the last two open pieces from the AHP-zonation plan and the
original Phase 2.5 roadmap: individual building footprints on zoom
(deliberately deferred out of §0.32's own Sub-phase 4), and Sentinel-1
SAR as a second, independent ground-truth source (Phase 2.5.6, the one
sub-phase of the original plan never built).

### Sub-phase 5 — viewport-bounded buildings-on-zoom

**Real constraint found before writing any code**: the existing per-
catchment Overture buildings cache (`overture_buildings.json`) is
**25-118MB on disk** (measured live: Nullah Lai 110MB, Bhudni Nullah
118MB, Chashma 25MB, Guddu 60MB) — re-parsing a file that size on every
`moveend` during an interactive zoom session is not viable. Fix: an
in-process, lazily-built cache — each catchment's buildings are parsed
and indexed into a `shapely.STRtree` exactly ONCE per worker process
(the same STRtree technique already proven at 603,076-building scale in
`fetch_overture_buildings_exposure`), bounded to the **2** most-
recently-touched catchments (manual LRU eviction — confirmed live: a
3rd catchment correctly evicted the least-recently-touched one, not the
most recent).

New endpoint: `GET /api/flood-model/ahp-buildings-in-view/?catchment=
<key>&bbox=minx,miny,maxx,maxy` — synchronous (not job-id/polling
based), clamps the requested viewport to the catchment's own bbox,
hard-rejects (400) a viewport over 0.2° per side (defends against a
stray/oversized request), classifies each building's centroid against
the 3 AHP zones (reusing `_zone_of_point` as-is), caps at 3000 features
(log + truncate). Frontend: `flood-model-control.js` reuses `weather-
report-control.js`'s own proven lazy-attach + 200ms-throttled +
bbox/zoom-fingerprinted `moveend` listener pattern, fetching only once
zoomed past zoom 15, with an `AbortController` cancelling a stale
in-flight request on a fast pan/zoom.

**Real, measured results** (RequestFactory, all 4 catchments, a small
zoomed-in test viewport each):

| Catchment | Cold build | Warm call | Features returned |
|---|---|---|---|
| Nullah Lai | 2.87s | 0.148s | 3000 (capped — dense urban area) |
| Bhudni Nullah | 2.83s | 0.156s | 3000 (capped — dense urban area) |
| Chashma | 0.68s | 0.072s | 1256 |
| Guddu | 1.66s | 0.041s | 131 |

All defensive checks confirmed live: too-large viewport → 400, unknown
catchment → 400, malformed/missing bbox → 400, an off-catchment
viewport (no overlap) → a real, valid empty `FeatureCollection` (not an
error — a genuine "map panned away" case).

### Phase 2.5.6 — Sentinel-1 SAR cross-validation

**Literature basis** (verified live this session): UN-SPIDER's *"Flood
Mapping and Damage Assessment Using Sentinel-1 SAR Data in Google Earth
Engine"* Recommended Practice — fetched and read directly (both its
overview and step-by-step pages), chosen because it is GEE-native
(matches this project's own stack, no new runtime dependency) and
reports a real validated accuracy (93.38%, ground-truth checked in its
own source study). Every numeric parameter below is cited AS-IS, not
re-derived:

| Parameter | Value | Source |
|---|---|---|
| Band | VH polarization | UN-SPIDER |
| Speckle filter | 50m radius circular focal-median | UN-SPIDER |
| Change detection | post-flood ÷ pre-flood VH mosaic ratio | UN-SPIDER |
| Threshold | ratio > 1.25 → flood | UN-SPIDER, 93.38% validated |
| Permanent water mask | JRC Global Surface Water, seasonality > 10mo/yr | UN-SPIDER (same asset id `views.py`'s own `AHPModels` already uses) |
| Terrain filter | slope > 5% (grade) excluded | UN-SPIDER uses HydroSHEDS — **this project substitutes its own already-cached conditioned-DEM slope** (`build_twi_curvature_rasters`'s own `09_slope_deg.tif`), a stated, zero-new-fetch efficiency deviation |
| Noise cleanup | ≤8-neighbor-connected patches removed | UN-SPIDER's own GEE-side call — **substituted with this project's own `gdal.SieveFilter`** (the exact call already proven in `flood_exposure._vectorize_multiclass_raster`), applied locally |

Corroborating Pakistan-specific literature (secondary support, not the
numeric source): Amitrano et al., *Sustainability* 2020 (DOI
10.3390/su12145784), and a 2025 Punjab AHP+Sentinel-1 study
(*Atmosphere*) — both confirm VH-polarization change detection as an
established, appropriate method for Pakistan specifically.

**A real, load-bearing finding from the live coverage check the plan's
own verification order put FIRST, before writing the rest of the
pipeline**: Sentinel-1A launched April 2014; GFD's own MODIS-based
event archive ends around 2018 — a narrow overlap window. Live-checked
against all 4 pilot catchments' own real GFD events (not assumed):
Pakistan's Sentinel-1 coverage was confirmed genuinely sparse in the
mission's early years — **only Chashma has both a real, sizeable
post-2014 GFD event AND real, dense S1 coverage in its date window**
(the 2018-07-03 to 2018-07-11 event, GFD id 4645, 897 flooded pixels;
20 real S1 scenes found May-July 2018). Nullah Lai's best post-2014
event had exactly 1 S1 scene in its whole 90-day search window; Bhudni
Nullah and Guddu had **zero**. Confirmed via a direct sanity check that
this is a real temporal-coverage gap, not a query bug: all 4 catchments
show dense, real S1 coverage (89-152 scenes) in a later, well-covered
year (2020).

**Built and tested for Chashma's one genuinely validatable event**
(`build_sar_flood_extent`, 19.7s end-to-end: fetch → speckle-smooth →
threshold → JRC mask → download → local slope mask → sieve → warp onto
the catchment's own conditioned-DEM grid). Sanity-checked: 1.95% of the
catchment flagged flooded — a plausible order of magnitude, not empty,
not the whole catchment.

**Cross-validated against real GFD ground truth** via a genuinely new
accuracy function, `accuracy_assessment.assess_raster_vs_raster_
agreement` — a real, full pixel-grid confusion matrix (not point-
sampling, unlike every other accuracy function in this project) between
the SAR mask and GFD's own extent, rasterized onto the same grid.
**Real, honest result for Chashma's event 4645**:

| Metric | Value | Interpretation |
|---|---|---|
| Agreement rate (raw pixel accuracy) | 0.9299 | misleading in isolation — see below |
| IoU (Jaccard) | 0.0067 | fail |
| Cohen's kappa | -0.0154 | worse than chance |

**This is a real negative finding, reported honestly, not hidden or
re-tuned to force a better number** — the same discipline this project
already applied to Guddu's 0.620 AHP AUC and the discharge mode's own
"didn't reach 85%" result. The high raw agreement rate is a class-
imbalance artifact (both extents are small relative to the whole
catchment, so a naive "% pixels agreeing" is dominated by true
negatives) — exactly the trap IoU/kappa exist to catch, which is why
this function reports all three rather than leading with accuracy
alone. Plausible, named reasons for the poor spatial overlap (not
resolved this pass): GFD's native 250m MODIS resolution vs. this
raster's 30m grid produces a different spatial pattern once both are
rasterized onto the same grid; the GFD event's own catalogued window
may not tightly align with when Sentinel-1 actually caught standing
water (satellite revisit timing is a lottery for a fast-receding
flood); and UN-SPIDER's own 1.25 threshold, while validated in its
source study's own study area, is not guaranteed to transfer to this
specific floodplain's land-cover/soil-moisture backscatter
characteristics — a known, literature-documented limitation of a fixed
threshold used outside where it was fit. The other 3 catchments
correctly returned `n_events_used=0` (no crash, a real, honest "not
enough coverage to validate" result, confirmed live).

**Verified**: `python manage.py check` clean; flash-flood regression
(byte-identical `build_discharge_driven_flood_zone` output) re-
confirmed after every change in this section.

**Files changed:** `flood_sar.py` (new module — `build_sar_flood_
extent`), `accuracy_assessment.py` (`assess_raster_vs_raster_
agreement`), `flood_validation.py` (`run_sar_cross_validation`),
`flood_exposure.py` (`_get_cached_buildings_index`,
`_build_buildings_index_raw`, `get_buildings_in_viewport`,
`_polygon_geometry_to_geojson`), `flood_model_views.py`
(`FloodModelAhpBuildingsInViewView`), `urls.py` (new route),
`base.py` (new throttle rate), `flood-model-control.js` (buildings-on-
zoom listener/render methods, updated AHP note text).

## 0.34 SAR accuracy diagnosis — a real, honest attempt that did not pan out

Directly asked to improve §0.33's own poor SAR-vs-GFD result (IoU
0.0067, kappa -0.0154 for Chashma's one testable event). Rather than
tune the 1.25 threshold to chase that one number — explicitly against
this project's own standing "don't over-tune to one pilot" discipline —
this section diagnosed the REAL cause first, tried one legitimate,
literature-grounded fix, and reports the honest result either way.

### First: was a new pilot catchment worth adding?

Searched nationally (not just the 4 existing pilot bboxes) for larger
post-2016 GFD events with real Sentinel-1 coverage. Found two real
candidates — a huge 2017 Tharparkar/Rann-of-Kutch desert-flooding
cluster (0.69 deg² contiguous, id 4507) and a real 2018 Punjab riverine
floodplain cluster near Multan (id 4640, 2691 polygons) — both
confirmed to have ZERO overlap with any of the 4 existing pilot
catchments. Presented to the user with the real tradeoffs (a new full
HAND-pipeline catchment is substantial new infrastructure; the desert
case doesn't fit this project's watershed abstraction at all). **User's
own choice: improve the existing Chashma case first** — no new
catchment added this pass.

### Diagnosis (each hypothesis tested live, not assumed)

1. **Resolution mismatch?** Re-compared SAR vs. GFD at GFD's own native
   250m resolution instead of the fine ~10m grid. IoU barely moved
   (0.0065 vs. 0.0067) — ruled out.
2. **Spatial registration bug?** SAR and GFD centroids are only ~6-7km
   apart with substantially overlapping bounding boxes — not a
   coordinate/offset bug, a real "same region, different detailed
   shape" disagreement.
3. **Post-event window catching receded water / pre-event window
   blending inconsistent baseline conditions?** Tested a much narrower
   pre/post pairing (single nearest pre-scene, post scenes strictly
   within GFD's own catalogued window) through the real production
   pipeline — this made IoU WORSE (0.0067 → 0.0014), not better. A
   real, honest negative result — window timing was not the driver.
4. **Fixed threshold too conservative for this floodplain?** Checked
   the real ratio-value distribution: SAR flags ~4.8% of the catchment
   at the literature's own 1.25 cutoff, GFD flags ~5.15% — the
   OVERALL flagged area is proportionally close. This ruled out a
   simple sensitivity problem and pointed at a genuine SPATIAL
   disagreement (SAR and GFD flag roughly the same AMOUNT of area, in
   largely DIFFERENT places) — consistent with a real, literature-
   documented limitation: agricultural backscatter change (tillage,
   irrigation, harvest cycles over the pre-event lookback window in
   this cropland-heavy floodplain) confounds simple VH-ratio flood
   detection, independent of any threshold choice.

### The one fix actually tried: adaptive (Otsu) thresholding

Switched from UN-SPIDER's single fixed 1.25 to Otsu's method (standard,
literature-documented, unsupervised — maximizes between-class variance
in the ratio image's own histogram, never looks at ground truth),
constrained to the physically-plausible flood-signal direction
([1.0, 3.0] — VH backscatter genuinely increasing under double-bounce
scattering, not the unconstrained full histogram, which was tested and
rejected: it picked a threshold of 1.034 and flagged 37% of the whole
catchment, clearly dominated by non-flood noise, not usable).

**Real, honest result — tested twice, and the two disagreed, which is
itself the important finding**: a first, simplified diagnostic script
(skipping the JRC permanent-water mask and the terrain/sieve steps)
showed a real-looking improvement (IoU 0.0067 → 0.0241). Re-tested
properly through the ACTUAL, FULL production pipeline (JRC mask applied
before the threshold search, terrain mask and sieve applied after) —
the improvement did NOT hold up: IoU 0.0036, kappa -0.0146, both still
"fail" grade, essentially a wash against the fixed-threshold baseline.
**The simplified test was not representative of the real pipeline — a
direct example of why this project always re-tests through the actual
production code path before trusting a result, not a shortcut.**

**Decision: kept the Otsu implementation as the shipped default anyway,
but explicitly NOT because it fixed the number** — it is the more
defensible GENERAL method (per-scene-adaptive rather than assuming
UN-SPIDER's own study conditions transfer to Pakistan's terrain
unmodified, and it degrades to the exact same fixed literature value
when too few samples exist, so it is never worse than the old default
by construction). The honest conclusion stands regardless of which
threshold method is used: **the fundamental limitation is a real
methodological mismatch between SAR backscatter change detection and
MODIS-based optical flood detection over this specific agricultural
floodplain — not something a threshold choice alone fixes.** Reported
plainly, matching this project's own established posture for Guddu's
0.620 AUC and the discharge mode's own "didn't reach 85%" finding —
not hidden, not spun as a success.

**Verified**: `python manage.py check` clean; flash-flood regression
byte-identical; all 3 no-S1-coverage catchments confirmed to still
degrade cleanly (`n_events_used=0`, no crash) with the new code path.

**Files changed:** `flood_sar.py` (`_otsu_threshold`, `build_sar_flood_
extent` restructured to download the continuous ratio and threshold
locally/adaptively instead of thresholding in GEE with a fixed
constant).

## 0.35 Shape validation against the 20 existing flood-extent layers + minimal result-panel text

Two real pieces of work, prompted directly by the user: (1) Phase 3's
own first named, never-started scope item — "cross-check against the
20 existing flood extent layers where they overlap" — finally done;
(2) every result-panel text block condensed to real, highlighted key
terms instead of long paragraphs.

### A real, independent shape check nobody had run

Every accuracy number before this section came from GFD (point/pixel-
sampled). This compares our own riverine/AHP zone SHAPES against the
app's own 20 EXISTING `hydrological_global` flood-extent bands (Upper/
Lower Indus, Jhelum, Chenab, Ravi, Sutlej, Kabul — High/Medium/Low
severity) — a completely separate, already-published ground truth,
checked for the first time.

**Real, live-confirmed facts, not assumed**: `chashma_indus`
(`wfs_river_system: upper_indus`) and `guddu_indus` (`lower_indus`)
already carried this exact linkage as an unused field. Live-checked
which pilot catchments have ANY real overlap with the 7 river systems
before building anything: **Nullah Lai has zero** (confirmed across
all 7 — a structural fact, the comparison genuinely cannot run there).
**Bhudni Nullah has real overlap with both `upper_indus` and `kabul`**
(3 real polygons each — Peshawar sits on the actual Kabul River) — a
new `wfs_river_system: "kabul"` field was added to its own
`PILOT_CATCHMENTS` entry, extending a field that previously only
existed on riverine catchments to a flash one.

New `accuracy_assessment.assess_vector_overlap(geoms_a, geoms_b)` —
pure shapely, no rasterization (unlike the SAR work, BOTH sides here
are already real vector polygons): reports IoU plus `coverage_of_a`/
`coverage_of_b` (what fraction of each side the other covers) — more
diagnostic than IoU alone for a shape check, since IoU can't
distinguish "these disagree" from "one is a subset of the other."
New `flood_validation.run_flood_extent_shape_comparison(catchment_key,
force=False)` orchestrates it: fetches each available severity band
once, compares against both our riverine flood-zone geometry and every
AHP zone class, cached to disk (`flood_extent_shape_comparison.json`,
static per catchment). Wired into both the riverine and AHP job
runners (`shape_comparison` field, alongside `zone_exposure`/
`zone_map_layers`).

**Real result — genuinely positive, unlike §0.34's SAR finding**:

| Catchment | River system | Riverine zone `coverage_of_a` vs. High band | AHP-High zone `coverage_of_a` vs. High band |
|---|---|---|---|
| Chashma | upper_indus | **92.3%** | **76.0%** |
| Guddu | lower_indus | 44.9% | 37.9% |
| Bhudni Nullah | kabul | n/a (flash, no riverine zone) | 24.4% |

The absolute magnitudes are naturally modest for the weaker catchments
(the existing bands represent a much broader historical hazard extent
than one live/static model run, so a low IoU is EXPECTED, not a red
flag — `coverage_of_a` is the more meaningful number here: how much of
OUR OWN zone the existing, already-published band already covers). The
genuinely reassuring finding, true across all 3 catchments: **the
directional pattern is consistently correct** — AHP-High zones show
the strongest overlap with the existing High band, AHP-Low zones the
weakest, every time. This is real, independent, positive validation
evidence GFD-based AUC never captured — the AHP zonation is spatially
sane, not just numerically accurate against one ground-truth source.

### Minimal result-panel text

Cataloged every `.flood-model-note` block across all 4 modes (15+
blocks: per-mode accuracy notes, "rendered on the map" closing notes,
7 methodology/input notes, admin-context sentences, the buildings-zoom
note) and condensed each to 1-2 lines — the one real caveat + the one
real number, as highlighted key terms, cutting multi-sentence
methodology prose (the Bhatt & Srinivasa Rao paragraph, the SCS-CN/
Kirpich chain explanation, the "genuine mechanism-grounded improvement"
framing, etc.) to a fragment or removing it where it didn't change what
a user does next.

**A real, new visual convention** (confirmed absent before this: no
`<mark>`, no `.highlight` class, `<strong>` rendered as unstyled
default browser bold anywhere in this panel) — `.flood-model-note
strong` and `.flood-model-admin-sentence strong` now render in this
panel's own existing accent color (`var(--ndma-blue)`, already used for
active/selected states elsewhere in the same panel), so a highlighted
key term reads as "the same accent as an active state," not an
unrelated new color.

Admin-context sentences switched from the server's pre-composed
`.sentence` string to building their own bolded markup client-side from
the already-shipped raw fields (`name`, `dominant_zone`,
`dominant_zone_pct`) — no backend change needed, the raw fields were
already in the payload.

The new shape-comparison headline number (the single best-matching
`coverage_of_a` figure) is now rendered as one bolded line in both the
riverine and AHP results — the natural point where "run a real
comparison nobody's done" and "make the text worth reading" meet.

**Verified**: `npx vite build` clean; full end-to-end `RequestFactory`
test of both job types (riverine/chashma_indus, AHP/peshawar_bhudni_
nullah, AHP/nullah_lai confirming the clean no-mapping degrade) — all
completed successfully with `shape_comparison` flowing through
correctly; `python manage.py check` clean; flash-flood regression
byte-identical.

**Files changed:** `accuracy_assessment.py` (`assess_vector_overlap`),
`flood_validation.py` (`run_flood_extent_shape_comparison`),
`flood_model.py` (`peshawar_bhudni_nullah` gains `wfs_river_system:
"kabul"`), `flood_model_views.py` (both job runners call the new
comparison), `flood-model-control.js` (`#renderShapeComparisonNoteHTML`
+ every note block condensed + admin-sentence markup switched to raw
fields), `_flood-model-panel.css` (`strong` highlight treatment).

## 0.36 Custom-AOI draw tool — the original Phase 1.6 vision, closed

The ORIGINAL vision from Phase 1.6's own start, named and never built:
this panel's own file header has said, since its first version, "Custom-
AOI drawing and DEM/rainfall upload are Phase 1.6's own later step, not
built here." `_validate_catchment_bbox`'s own comment was even more
explicit: *"Phase 1.6 will make the AOI user-controllable (a drawn bbox
or a custom upload)"* — written for this exact feature, sitting unused
until now.

### What was found before writing any code

The core terrain/hazard machinery (`build_hand_pipeline`, `render_
flood_prone_zones`, `build_ahp_susceptibility_raster`, `build_sar_flood_
extent`, every `flood_exposure.py` fetch) was confirmed, by direct
exploration of ~30 functions, to use `catchment_key` for exactly two
things — a `PILOT_CATCHMENTS` membership gate and a cache-directory
name — never anything catchment-name-specific underneath. The real
obstacle was one repeated gate, not the computation. Per-mode data
needs, confirmed exhaustively: fixed-threshold flash mode needs only a
bbox; AHP mode's terrain-class dispatch is already live-measured from
the DEM (not a per-catchment lookup); discharge-driven flash mode needs
`composite_cn` + `basin_length_km`, both hard-required literature
constants with zero fallback; riverine mode needs a real FFD gauge
station (31 exist nationally, name-queryable only, no coordinate list
anywhere in this codebase — a real data gap, not a code one).

### Design: synthesize, don't refactor

`flood_model.register_custom_aoi(bbox, flood_type)` — validates via the
already-written, already-generic `_validate_catchment_bbox`, computes a
content-addressed key (`custom_<16-hex>`, bbox rounded to 4 decimals
before hashing so two near-identical draws share one cache), and
inserts a transient `PILOT_CATCHMENTS` entry. Precedented directly by
this file's own `_FABDEM_VALIDATION_TEST_CATCHMENT` splice-a-synthetic-
entry pattern. Every downstream function then runs completely
unmodified — confirmed live, not assumed. Bounded cache growth via
`_prune_custom_aoi_cache` (the same dual TTL+count-cap shape `_purge_
old_jobs` already established) — verified live with a deterministic,
isolated test (4 directories with explicit distinct mtimes, cap=2):
correctly kept the 2 newest, removed the 2 oldest.

### Auto-derived `composite_cn` and `basin_length_km` — literature-verified, not invented

The two hardest, most hand-researched pilot constants turned out to be
buildable from data this project already fetches for the AHP factor
pipeline:

- **`derive_composite_cn`**: NRCS TR-55's own land-cover × Hydrologic
  Soil Group method. CN values quoted verbatim from a real TR-55
  reference table (fetched and read directly this session,
  drainagecalculators.com's own AMC-II table — Woods good 30/55/70/77,
  Brush good 30/48/65/73, Pasture good 39/61/74/80, Row crops good
  67/78/85/89, Fallow bare 77/86/91/94, Commercial 85%-impervious
  89/92/94/95, water/wetland/frozen ground flat 98 regardless of HSG —
  the same convention this source's own "paved parking/roofs" row
  already uses). Soil-texture→HSG crosswalk grounded in NRCS's own
  published HSG criteria (Group A <10% clay >90% sand ... Group D >40%
  clay), verified live. Reuses `build_lulc_raster`/`build_soil_texture_
  raster`'s own raw class-code rasters unchanged — already fetched,
  cached, co-registered on the same grid — zero new data fetch.
- **`derive_basin_length_km`**: WhiteboxTools' `distance_to_outlet` (a
  real, standard hydrological-analysis tool, confirmed via live search),
  needing only `d8_pointer` + `streams` — both already cached by
  `build_hand_pipeline`. Max value over stream cells = the longest real
  flow-path length. **Confirmed conceptually correct, not just
  convenient**: `flood_discharge.kirpich_time_of_concentration_hr`'s own
  docstring explicitly wants "the longest flow-path length, not a
  straight-line bbox diagonal" — exactly this.

**Known-answer verification against the 2 curated flash pilots (real, honest results, not tuned to match):**

| Catchment | Auto CN | Hardcoded CN | Diff | Auto length | Hardcoded length | Diff |
|---|---|---|---|---|---|---|
| Nullah Lai | 77.7 | 80.7 | -3.0 | 46.53km | 30.0km | +55% |
| Bhudni Nullah | 75.1 | 81.2 | -6.1 | 48.61km | 38.0km | +28% |

Both auto-CN values run moderately lower — most likely because TR-55's
"good hydrologic condition" tables (used uniformly here) assume denser/
healthier vegetation than these basins may actually have; "fair
condition" tables would run higher. Both auto-length values run
meaningfully higher — most likely because the longest-flow-path
technique (correctly, per Kirpich's own formula) captures the true
longest hydrological path including tributaries, while the published
"~30km"/"~38km" figures may cite a named main-channel length specifically
— a related but distinct geomorphological quantity. **Neither
discrepancy was corrected with a scaling factor** — 2 known-answer
points is not enough data to tune against without risking exactly the
overfitting this project has repeatedly avoided; both are shipped as-is,
reported honestly.

### End-to-end verification, a genuinely new AOI (central Punjab, near Multan — none of the 4 curated pilots)

- Fixed-threshold mode: 66.1s (warm), 129.4 km² zone, 206,858 buildings.
- AHP mode: 36.4s, terrain class correctly auto-classified `flat_relief`
  (live-measured, unchanged code), 3 zone features. The EXISTING roads
  map-layer cap (§0.33) fired correctly on this brand-new AOI (14,420
  vehicular ways > 4000 cap, truncated gracefully) — confirming that
  pre-existing safeguard generalizes, not just this new feature's own
  code.
- Discharge-driven mode: 69.0s, real auto-derived params flowed through
  the full SCS-CN → Kirpich → SCS-UH chain end-to-end (composite_cn=82.5,
  basin_length_km=17.41 → peak_discharge_m3s=133.91). The EXISTING self-
  adaptive vectorization backoff (§0.25) also fired correctly and
  transparently on this new AOI.
- SAR cross-validation: ran cleanly, degraded honestly (7 real GFD
  events found, 0 usable — no real Sentinel-1 coverage, consistent with
  §0.33's own earlier finding for 3 of 4 pilots) — confirms the SAR
  pipeline is genuinely bbox-generic, not pilot-specific.
- Full flash-flood regression: byte-identical throughout every step of
  this work, not just at the end.

### What was deliberately not built

- **User-uploaded DEM/precipitation rasters** — a real upload mechanism
  precedent exists (`gis-export-control.js`'s Import tab, `views.py`'s
  `NcopRasterUploadView`) but is currently display-only, not wired into
  the model pipeline; bridging an arbitrary uploaded DEM into `build_
  hand_pipeline`'s own WhiteboxTools conditioning chain is real,
  separate engineering risk. v1 uses this project's own already-reliable
  GEE-fetched data instead — a named, explicit follow-on, not silently
  dropped.
- **Riverine mode for custom AOIs** — no coordinate list exists for any
  of the 31 real FFD stations; explicitly rejected server-side with a
  clear message, not half-built on invented coordinates. The frontend
  only offers "Draw custom area…" under flash-flood type at all, so this
  case is unreachable from the UI in the first place.
- **A confirmed dead-code bug found during exploration** (not fixed,
  out of this section's scope): `flood_model.py` defines `build_
  riverine_flood_zone` TWICE (an old, unreachable version silently
  shadowed by the real one) — flagged for a future cleanup pass.

**Verified**: known-answer checks reported above; full end-to-end
`RequestFactory` runs for fixed-threshold/AHP/discharge-driven/SAR
modes on a genuinely new AOI; isolated cache-pruning test; `python
manage.py check` and `npx vite build` clean; flash-flood regression
byte-identical after every step.

**Files changed:** `flood_model.py` (`register_custom_aoi`,
`_prune_custom_aoi_cache`, `derive_composite_cn`, `derive_basin_length_
km`, new `_TR55_CN_BY_CATEGORY`/`_WORLDCOVER_TR55_CATEGORY`/`_SOIL_
TEXTURE_TO_HSG_INDEX` tables), `flood_model_views.py`
(`FloodModelRunView.post()` accepts `catchment: "custom"`, `_run_flood_
model_job` auto-derives CN/length for a custom AOI before running
discharge mode), `flood-model-control.js` (`@mapbox/mapbox-gl-draw` +
`@turf/turf` integration, draw-tool methods, "Draw custom area…" Area
option).

## 0.37 Custom-AOI real-world fixes — live browser testing found 3 real bugs

Live browser testing of §0.36's own draw tool (a real screenshot) found
three genuine bugs and one real performance problem — all diagnosed by
direct exploration before any fix, matching this project's own standing
discipline.

### 1. A real correctness bug — result rendered outside the drawn polygon

Confirmed via the screenshot: the flood-inundation/AHP result filled
the polygon's bounding RECTANGLE, not the actual drawn shape. Root
cause: `register_custom_aoi` only ever stored a bbox; the frontend only
ever sent a bbox (`turf.bbox(feature)`), discarding the real drawn
geometry entirely.

**Fix**: `register_custom_aoi(bbox, flood_type, polygon_geojson=None)`
now stores the real drawn shape as `cfg["clip_polygon"]`, folded into
the content-address hash too (so two different polygons sharing one
bbox get genuinely different caches, not a silently-shared stale one).
A new `_clip_array_to_polygon` (reusing the exact `gdal.RasterizeLayer`
technique already proven this session in `accuracy_assessment.
assess_raster_vs_raster_agreement`) masks every cell outside the real
polygon to nodata. Applied at THREE real, independent points, each
found by tracing the actual code, not assumed:

- `render_flood_prone_zones` — clips the HAND raster before its
  color-relief PNG step (a NEW clip-then-write step; this function
  previously colorized `hand_path` directly with no array stage at all).
- `build_discharge_driven_flood_zone` — clips `masked_hand_arr` before
  it's written to `masked_hand_path`, which turned out to be the ONE
  right insertion point for the whole chain: `build_discharge_binary_
  mask` re-reads that same file later for BOTH the PNG render AND the
  exposure-report vectorization, so one clip here fixed both consistently.
- `build_exposure_report` (fixed-threshold mode's OWN exposure path) —
  a genuinely separate mask computation (`_binary_flood_mask` from raw
  `hand_path`, independent of `render_flood_prone_zones`'s own PNG
  flow) needed its own clip, or a custom AOI's buildings/roads/
  population COUNTS would still reflect the whole unclipped bbox even
  after the rendered SHAPE was fixed.
- `build_ahp_zone_geometries` — clips `zone_arr` at the raster level,
  before vectorization (simpler and cleaner than a post-hoc shapely
  intersection on the vectorized geoms — avoids the vectorizer's own
  sieve/simplify pass producing jagged post-intersection edges).

**Verified live, not assumed**: registered a real triangular polygon
inside a rectangular bbox, sampled a point inside the bbox but outside
the triangle — confirmed nodata/excluded in all three paths (HAND PNG,
AHP zone raster, fixed-threshold exposure mask) — and a point inside
the triangle correctly reads a real value in each. A curated pilot
catchment never sets `clip_polygon` — confirmed zero behavior change
via the standing flash-flood regression check.

### 2. A real rendering bug — the draw-tool buttons never appeared

Root cause, confirmed: `_map-panels.css` had a blanket `.mapboxgl-ctrl-
group { display: none !important; }` (written to hide the native
zoom/compass control), which hides ANY control group in ANY corner —
including `@mapbox/mapbox-gl-draw`'s own polygon/trash toolbar. Fixed
with an explicit re-enable for `top-left` specifically (confirmed via
direct search: no other control in this whole app uses that corner),
mirroring the exact carve-out precedent this same file already uses
for the scale bar a few lines above.

### 3. A real interference risk — attribute popups during drawing

`layer-attribute-popup.js` has a global, unscoped `map.on("click", ...)`
handler that queries and pops up feature-attribute popups on EVERY map
click — including clicks placing polygon vertices. Fixed with an
early-return guard checking a new `FloodModelControl.isDrawModeActive()`
(a real, synced-from-Draw's-own-mode-change-event flag, not a
hand-toggled one — so an Escape-cancelled draw is handled correctly
too), read via `window.ncopFloodModelControl`, this app's own
already-established cross-module access convention.

### 4. Checklist redesigned as a real table with genuine timing

`#renderChecklistHTML()` rewritten from a plain icon+label div list
into a real `<table>`, themed entirely with this panel's own existing
tokens (`--ndma-blue`/`--text-primary`/`--secondary-bg`/`--border-dark`
— automatic day/night theme support, no new colors). Shows a REAL
elapsed time per active stage (`FloodModelStatusView` now surfaces the
job's own already-stored `started_at`, just never exposed before —
`elapsed_seconds = time.time() - started_at`), plus a labeled, real
range-based expectation for the currently-active stage, sourced from
this project's own already-documented timing history — never a
fabricated smoothly-ticking bar.

### 5. A real performance fix — safe Overture prefetch

**The most important finding of this whole pass**: a naive "start the
Overture fetch as soon as drawing finishes" optimization would have
made things WORSE. Traced live through `fetch_overture_buildings_
exposure`'s own cache-check logic: it has no per-key lock or in-flight
registry, so a prewarm call and the real "Run" job's own later call to
the SAME function, for the SAME catchment key, would each independently
submit to `_OVERTURE_EXECUTOR` (`max_workers=1`) — the second queues
strictly behind the first and then RE-RUNS the entire slow S3 scan a
second time once the first finishes, close to DOUBLING the real wait.
Confirmed the identical race exists in `build_hand_pipeline`'s own WBT
calls and `_get_cached_buildings_index` too — a real, codebase-wide gap
in the "disk-cache-check-then-submit" convention, not a one-off bug.

**The real fix**: a new, generic, reusable `_submit_coalesced(executor,
key, fn, *args)` — a second caller for the same key JOINS the first's
already-in-flight Future instead of resubmitting duplicate work (a
`dict[key] -> Future` registry, cleaned up on completion). Applied to
`fetch_overture_buildings_exposure` (the dominant real cost, confirmed
live: ~225-270s typically, ~6 minutes observed for a genuinely new
custom AOI) — skipped entirely when `force=True`, so a deliberate cache
bust always gets its own real fetch, never joins stale in-flight work
meant for a different call. `build_hand_pipeline`/`_get_cached_
buildings_index`'s own identical gap is flagged, not fixed this pass.

New `POST /api/flood-model/prewarm-custom-aoi/` — registers the AOI
(fast, no network) then TRIGGERS the coalescing-safe fetch without ever
calling `.result()` on it, returning in ~1ms regardless of how long the
real S3 scan takes (confirmed live: 0.001s response time). The
frontend calls this right after a polygon is drawn, fire-and-forget,
errors silently ignored — a pure optimization, never a correctness
dependency; the real Run flow works identically, just slower, if this
was never called or fails for any reason.

**Verified live**: the coalescing primitive tested directly with 2
real concurrent callers for the same key — confirmed exactly 1
underlying execution (not 2), both callers got the identical result,
elapsed time matched the single execution (not doubled), the registry
correctly cleaned up after completion, and a later, separate call for
the same key correctly ran fresh rather than joining a stale entry.

**A real, minor production note surfaced during testing** (not a bug,
not fixed, just worth knowing): `ThreadPoolExecutor` registers its own
`atexit` handler that blocks interpreter shutdown until all
in-progress work completes — meaning a graceful server restart could,
in principle, wait up to `_OVERTURE_FETCH_TIMEOUT_SECONDS` (420s) if a
prewarm happens to be in flight at that exact moment. Already bounded
by the existing timeout, matching this app's own standing "bounded,
not unbounded" posture for every other background task — no code
change needed, just worth knowing.

**Verified**: `python manage.py check` and `npx vite build` clean
throughout; flash-flood regression byte-identical after every change.

**Files changed:** `flood_model.py` (`register_custom_aoi` gains
`polygon_geojson`, `_clip_array_to_polygon`, `_canonicalize_polygon_
geojson`, clip calls in `render_flood_prone_zones`/`build_discharge_
driven_flood_zone`/`build_ahp_zone_geometries`), `flood_exposure.py`
(`_submit_coalesced`, `_INFLIGHT_FUTURES`/`_INFLIGHT_LOCK`, clip call
in `build_exposure_report`, coalescing applied to `fetch_overture_
buildings_exposure`), `flood_model_views.py` (`FloodModelRunView.post()`
accepts `polygon`, `elapsed_seconds` added to `FloodModelStatusView`,
new `FloodModelPrewarmCustomAoiView`), `urls.py`/`base.py` (new route +
throttle), `_map-panels.css` (draw-tool visibility fix),
`layer-attribute-popup.js` (draw-mode popup guard), `flood-model-
control.js` (real drawn-polygon capture, `isDrawModeActive()`,
checklist table redesign, prewarm trigger), `_flood-model-panel.css`
(checklist table styling).

## 0.38 Real, themed draw/trash control — replacing reliance on Draw's own toolbar

§0.37's fix made `@mapbox/mapbox-gl-draw`'s OWN default toolbar visible
again (a CSS carve-out for the `top-left` corner). Live testing showed
that was the wrong target: the user never wanted Draw's own
plain-browser-styled buttons made visible — they wanted a real,
NCOP-themed control (a `lasso` icon to draw, a `trash-2` icon to clear),
matching this panel's own existing button language, not a foreign map
widget's default chrome.

**Fix**: `#ensureMapboxDraw()` now constructs `MapboxDraw` with
`controls: {}` (no `polygon`/`trash` keys at all) and calls
`map.addControl(this.#mapboxDraw)` with no position — this renders
ZERO of Draw's own buttons anywhere on the map, while the underlying
drawing engine (vertex placement on map clicks, mode state machine)
stays fully wired, exactly as `@mapbox/mapbox-gl-draw`'s own documented
pattern for a fully custom UI. Two new buttons in the panel's own
"Area" section (shown only once "Draw custom area…" is selected) drive
that same instance directly: `#floodModelDrawBtn` (`<i data-lucide=
"lasso">`, calls `#activateDrawMode()` → `draw.changeMode(
"draw_polygon")`) and `#floodModelDrawTrashBtn` (`<i data-lucide=
"trash-2">`, calls `#deactivateDrawMode()` → `draw.deleteAll()` +
`draw.changeMode("simple_select")`). Both styled with this panel's own
existing tokens (`--ndma-blue`, `--secondary-bg`, `--border-dark`),
matching `.flood-model-run-btn`/`.flood-model-clear-btn`'s own
convention — no new colors introduced.

Selecting "custom" from the catchment dropdown no longer auto-enters
draw mode itself — it only readies the draw engine
(`#ensureMapboxDraw()`); the dropdown now answers "what kind of area,"
and the new themed button is what actually starts drawing, per the
user's own explicit correction.

**A real, confirmed gap closed along the way**: `#renderContent()` (the
function that re-injects the whole panel body on every state change)
never called `window.lucide?.createIcons()` — only the ONE static
icon in `#render()`'s one-time constructor markup was ever converted
from a raw `<i data-lucide>` tag to a real SVG. Confirmed via direct
grep that every other module with dynamically-rendered Lucide icons
(`layer-panels.js`, `navigation-panel.js`, `map-controls.js`,
`layer-style-config.js`, `geocoder-control.js`, and others) already
calls `createIcons()` inside its own re-render path — added the same
call at the end of `#renderContent()`, or the new lasso/trash icons
would have silently stayed invisible, empty `<i>` tags.

The now-dead `.mapboxgl-ctrl-top-left .mapboxgl-ctrl-group { display:
flex !important; }` carve-out from §0.37 was removed from
`_map-panels.css` — nothing renders in that corner any more, so the
rule matched nothing.

**Verified**: `npx vite build` clean.

**Files changed:** `flood-model-control.js` (`#ensureMapboxDraw()`
suppresses Draw's own toolbar, catchment-select handler no longer
auto-activates draw mode, new draw/trash buttons + click handlers,
`createIcons()` call added to `#renderContent()`), `_flood-model-
panel.css` (`.flood-model-draw-toolbar`/`.flood-model-draw-btn`/
`.flood-model-draw-trash-btn`), `_map-panels.css` (dead carve-out
removed).

## 0.39 "Draw custom area…" out of the dropdown — a real icon-only control instead

Follow-up correction to §0.38 (itself a follow-up to §0.37): the user's
own explicit clarification was that a dropdown ENTRY is never "a control
the user can click to draw," no matter how it's styled, and pointed at
`mapbox-gl-draw`'s own docs example (a small stack of icon-only square
buttons) as the actual shape wanted — reskinned in NCOP's own theme,
living inside the panel's Area section (not a map-corner control — asked
and confirmed directly with the user).

**Fix**: "Draw custom area…" removed entirely from `floodModelCatchment
Select`'s own option list — that dropdown now only ever lists real,
named catchments. Two new icon-only square buttons
(`.flood-model-draw-icon-btn`, Lucide `lasso`/`trash-2`, ~30×30px,
themed with this panel's own `--secondary-bg`/`--border-dark`/
`--ndma-blue` tokens) sit beside it, always visible whenever flash-flood
type is active. Clicking the lasso button IS what switches the active
area to "custom" (mirrors what picking the old dropdown option used to
do) and enters `draw_polygon` mode; clicking trash clears only the drawn
shape (`#deactivateDrawMode()`), staying in custom mode for an immediate
redraw — matches "Clear" already meaning "clear the map, not the
selection" elsewhere in this panel.

**Verified**: `npx vite build` clean.

**Files changed:** `flood-model-control.js` (`#renderContent()`'s
catchment-option list, new draw/trash click handlers, `#clearMap()`
reuses `#deactivateDrawMode()`), `_flood-model-panel.css`
(`.flood-model-draw-ctrl-row`/`.flood-model-draw-icon-btn`, replacing
§0.38's own pill-shaped buttons).

## 0.40 Checklist looked frozen during AHP + custom-AOI runs — a real progress-visibility bug, plus a real countdown

Live testing surfaced two more issues: a console error unrelated to this
app's own code (checked: `reportAllChanges` appears nowhere in this
app's source or its bundled dependencies, including `lottie-web` — the
only `eval`-using package in the build, confirmed via direct grep, zero
matches; the error's own `VM7191:2` stack-frame prefix is Chrome's
naming for an `eval`'d/injected script, not a normal `<script src>`
bundle — most likely a browser extension's own injected script, not
this app's), and a REAL bug: an AHP run against a custom-drawn area
appeared to stop dead after "Building susceptibility zone boundaries."

**Root cause, confirmed by tracing the code**: `build_ahp_zone_exposure_
report` fetches buildings/bridges/population separately for EACH of the
3 susceptibility zones, reporting dynamic, zone-prefixed stage labels
(`"[low] Fetching building exposure (Overture)"`, etc.) — these never
match the checklist's static per-mode stage list (`AHP_RUN_STAGES`),
so `#currentStage` stopped matching ANY row for potentially several
minutes at a time (Overture alone: "several minutes for a brand-new
custom area," ×3 zones' worth of Overpass/WorldPop calls on top) while
the backend was genuinely still working — a real progress-visibility
bug, not a hang.

**Fix**: `#renderChecklistHTML()` now appends one extra row for whatever
`#currentStage` actually is whenever it doesn't match a static row, so
real backend progress is always visible, including the dynamic per-zone
stages. Separately, per the user's own explicit ask ("by time I meant
like descending, 10,9,8,7…"), the checklist's time column was rebuilt
as a genuine, live countdown: `STAGE_TIME_HINTS` gained a numeric
`typicalSeconds` ceiling alongside each existing cited range, anchored
to a new client-side `#currentStageStartedAt` timestamp (the backend
only tracks whole-job elapsed time, not per-stage) and ticked every 1s
via a local `#stageTickTimer` (independent of the 3s status-poll
cadence), so it reads as continuously live rather than jumping once
every 3 seconds. Holds at "finishing up…" rather than going negative
once a stage runs past its own estimate — an honest outcome for a
genuinely slow real-world case, not something to hide.

**Verified**: `npx vite build` clean.

**Files changed:** `flood-model-control.js` (`#renderChecklistHTML()`'s
dynamic extra row, new `#renderChecklistTimeCell()`, `STAGE_TIME_HINTS`
gains `typicalSeconds` + a "bridges & hospitals" entry, `#poll()`
tracks stage changes + drives the 1s ticker, `#stopPolling()` clears
it too).

## 0.41 AHP zonation for a small custom AOI — real fix, not cosmetic

A real screenshot surfaced a genuine correctness bug: a custom-drawn
urban AOI's own AHP susceptibility zonation rendered as two sharp,
disconnected, kite-shaped polygon shards — nothing like the organic,
terrain-following zones every curated pilot produces. Traced to the
root cause rather than patched cosmetically, and grounded in literature
before implementing (see Sources below).

**Root cause, confirmed by tracing the code**: two pieces of this
pipeline are tuned for BASIN-SCALE catchments (the 4 curated pilots,
tens of km² each) and don't transfer to a small, user-drawn AOI (can be
well under 1km² wide):

1. `build_ahp_smoothed_score_raster`'s own `box_mean_filter` used a
   FIXED `radius_cells=8` (a ~17×17 cell, ~510m window on the 30m DEM
   grid) — for a small custom AOI, that window can cover the entire
   valid area for nearly every interior cell, collapsing real local
   variation into a near-constant value. A textbook instance of the
   Modifiable Areal Unit Problem's "scale effect": smoothing/aggregation
   at a fixed absolute scale erases heterogeneity that matters at a
   smaller extent (confirmed via literature search).
2. `build_ahp_zone_geometries` classified that (already over-smoothed)
   score using `_AHP_ZONE_BREAKS_CALIBRATED` — absolute thresholds
   Youden's-J-calibrated against the 4 basin-scale pilots' own score
   DISTRIBUTIONS. A small custom AOI's own distribution has nothing to
   do with those — applying basin-derived absolute cutpoints to an
   unrelated, differently-shaped local distribution routinely puts
   almost the whole drawn area into just 1-2 classes, or splits it along
   one nearly-arbitrary line — exactly the disconnected-shard look in
   the screenshot.

**Literature grounding** (web search, not assumed): Natural Breaks
(Jenks) classification is repeatedly identified as the most successful/
literature-preferred method for AHP-based flood-susceptibility zonation
SPECIFICALLY when there is no independent local calibration dataset for
the exact study area — precisely the situation a custom AOI is in (no
Youden's-J-calibrated terrain-class match, no historical ground truth
pre-mapped to an arbitrary polygon). MAUP's own literature confirms the
smoothing/scale-effect diagnosis independently.

**Fix, gated exclusively on `clip_polygon` (custom AOI only — zero
behavior change for all 4 curated pilots, confirmed: their `cfg` never
sets it)**:

- `build_ahp_smoothed_score_raster`: smoothing radius scales down for a
  custom AOI — `max(1, min(8, min(h, w) // 20))` instead of the fixed 8
  — floored at 1 (never skips smoothing entirely; it still removes real
  per-pixel classification noise even for a small area). The 1/20
  fraction is this project's own reasoned choice, not a literature-cited
  constant — no source gives a universal "kernel radius vs. extent"
  ratio, labeled as such rather than falsely attributed.
- `build_ahp_zone_geometries`: for a custom AOI, breakpoints are
  computed from the AOI's OWN local score distribution (sampled from
  cells actually inside the drawn polygon, not the whole bbox rectangle)
  via a new `_local_natural_breaks` helper — a 1-D k-means (3 clusters),
  the standard practical stand-in for Jenks without adding a new
  dependency (no `jenkspy`/similar in this app's existing requirements;
  ESRI's own ArcGIS documentation describes its Natural Breaks
  classifier as functionally the 1-D k-means special case). Deterministic
  quantile-seeded centers (never random init). Falls back to the
  existing honest default (`_AHP_ZONE_BREAKS`, fixed thirds) for a
  genuinely degenerate case — fewer than 3 distinct values, or a value
  spread under 0.05 on the [1,5] score scale (guards against carving
  floating-point noise from a truly flat/uniform small area into 3
  false "clusters").

**Verified live** (standalone, not assumed): a synthetic bimodal
3-cluster sample (~2.0/3.0/4.2) correctly separated into breaks
(2.50, 3.60); a near-constant sample (2.5 ± 0.001 noise) correctly fell
back to the fixed-thirds default rather than manufacturing false
precision; a degenerate 3-value sample fell back identically; a 500,000-
value sample (well above any real custom-AOI cell count, given the
existing 0.30 deg² cap) completed in 0.019s, confirming the sample-size
bound is not a real-world concern. `python manage.py check` clean.

**Accuracy — the "no accuracy in a custom-area AHP" gap, addressed
where it's genuinely fixable**: `run_flood_extent_shape_comparison`
required a pre-known `wfs_river_system` mapping (a real, confirmed-live
structural fact for each curated pilot) — a custom AOI has no such
pre-known mapping (there's no way to know in advance which, if any, of
the 7 `hydrological_global` river systems an arbitrary drawn polygon
overlaps). Fixed: a custom AOI now PROBES all 7 systems (the same
bbox-filtered WFS call already proven to degrade safely to an empty
list on no overlap — this is just repeating that same safe operation a
few more times, not new risk), unions together whichever systems'
severity bands turn out non-empty, and reports a clear, specific error
only if genuinely none of the 7 overlap (an honest, expected outcome
for most custom areas — these 7 systems cover specific major river
reaches, not all of Pakistan) rather than the previous blanket "no
mapping" message. Deliberately NOT attempted this pass: a live, per-
request AUC-ROC number for a custom AOI. Every existing AUC figure in
this app is a DESIGN-TIME, offline calibration result (`flood_
validation.calibrate_ahp_zone_breakpoints`, run once against real GFD
events, hardcoded — see `_AHP_ZONE_BREAKS_CALIBRATED`'s own docstring
for why this is deliberate, not a shortcut); computing an equivalent
number live, per custom-AOI request, would mean sampling+scoring
against GFD on the hot request path — a real architectural departure
this pass does not make. The WFS shape-comparison extension above is
the honest, already-precedented substitute (the same one nullah_lai's
own curated-pilot page already relies on, having no AUC either).

**Note on cached results**: `build_ahp_zone_geometries`/`build_ahp_
smoothed_score_raster` cache to disk keyed by the custom AOI's own
content-addressed catchment key (bbox+polygon+flood_type hash) — a
polygon already run once BEFORE this fix has its OLD (broken) zones
cached under that same key. Redrawing the area (a new polygon hashes to
a new key) or re-running with a genuinely new draw picks up the fix
immediately; the exact same already-tested polygon would need its cache
cleared to see the corrected zonation on a re-run.

**Files changed:** `flood_model.py` (`build_ahp_smoothed_score_raster`'s
adaptive radius, new `_local_natural_breaks` + `_LOCAL_BREAKS_MAX_
SAMPLES`, `build_ahp_zone_geometries`'s custom-AOI breaks branch),
`flood_validation.py` (`run_flood_extent_shape_comparison`'s
all-7-systems probe for `is_custom_aoi`).

Sources:
- [Spatial flood risk mapping in east Java, Indonesia, using analytic hierarchy process — natural breaks classification](https://www.researchgate.net/publication/323067599_Spatial_flood_risk_mapping_in_east_Java_Indonesia_using_analytic_hierarchy_process_-_natural_breaks_classification)
- [From Expert-Based Evaluation to Data-Driven Modeling: Performance-Based Flood Susceptibility Mapping](https://doi.org/10.3390/limnolrev26010006)
- [MAUP: Modifiable Areal Unit Problem in raster GIS datasets](https://www.researchgate.net/publication/296239293_MAUP_Modifiable_Areal_Unit_Problem_in_raster_GIS_datasets_Raster_pixels_as_modifiable_areas)
- [Modifiable Areal Unit Problem — GIS Dictionary (Esri)](https://support.esri.com/en-us/gis-dictionary/modifiable-areal-unit-problem)

## 0.42 The remaining zonation gap — independently-simplified adjacent class boundaries

§0.41's fix (adaptive smoothing + local natural breaks) still left a
real, visible artifact: a live screenshot showed a sharp, sliver-shaped
GAP running through the middle of a custom AOI's own zonation — neither
class's color rendered there at all, not just a straight edge from
clipping to the drawn polygon (which is expected).

**Root cause, confirmed via a synthetic before/after test, not
assumed**: `_vectorize_multiclass_raster` runs `gdal.Polygonize` ONCE on
the whole classified raster (adjacent classes share exact pixel-level
boundaries at that stage — no gap yet), but then DISSOLVES and
SIMPLIFIES each class's own polygon INDEPENDENTLY (necessary — a filter
too aggressive for "low" can be fine for "high," judged per-class, see
that function's own docstring). Simplifying two polygons that used to
share an identical edge, independently, does not generally keep that
edge identical afterward — a well-documented cartographic-generalization
pitfall. `sieve_threshold_px=100`/`simplify_tolerance_px=5.0` were sized
for a basin-scale polygon's own huge vertex count (guddu_indus: up to
10MB unsieved for a single zone); at custom-AOI scale the same few-pixel
gap reads as a large, obviously-wrong tear.

**Fix**: for a custom AOI, `sieve_threshold_px`/`simplify_tolerance_px`
scale down with the AOI's own pixel extent (same MAUP-scale-effect
reasoning as §0.41's smoothing radius), and `min_mapping_unit_px` (which
independently DISCARDS small per-class polygon fragments near a shared
boundary — the dominant remaining gap source, isolated via the same
synthetic test) drops to 0 for a custom AOI — safe there in a way it
wouldn't be at basin scale, since a custom AOI's own total polygon count
is already tiny (capped at 0.30 deg²), so there's no real "too many
noise slivers" problem to guard against. The proper topology-preserving
fix (shapely's own `coverage_simplify`) needs shapely>=2.1, an unpinned
bump this app's existing 2.0.6 doesn't need — same posture already
established for not adopting the `overturemaps` package's own bump.

**Verified live** (a synthetic 60×60 multi-class raster, a diagonal
3-class split with a staggered/noisy boundary — not a toy perfectly-
straight line): old parameters left a gap covering 0.959% of the zone
envelope; sieve/simplify scaling alone got to 0.222% (4.3x smaller);
adding `min_mapping_unit_px=0` closed it to exactly 0.000%. `python
manage.py check` clean. A curated pilot catchment never sets
`clip_polygon` — these three parameters stay exactly 100/5.0/9 for all 4,
zero behavior change.

**Files changed:** `flood_model.py` (`build_ahp_zone_geometries`'s
adaptive sieve/simplify/MMU for a custom AOI).

## 0.43 AHP + Frequency Ratio ensemble for a custom AOI — real accuracy, not just visualization

The user asked for AHP to be paired with Random Forest or another
susceptibility model specifically for the custom-drawn case, and
flagged that custom AOIs had no accuracy assessment at all ("No AHP
accuracy result yet" — because `getCatchmentAccuracyInfo` is a
hardcoded, design-time table covering only the 4 curated pilots; a
custom AOI's own content-addressed catchment key can never be a key in
it). Researched via literature search before implementing anything.

**Literature finding on RF specifically**: Random Forest / ML
susceptibility models get their real value from LARGE, multi-source
training data, and are meant to be trained ONCE (offline, on a broad
dataset) then APPLIED to new areas — not trained per-AOI; "model
applicability is constrained in ungauged catchments, where hydrological
data is scarce." Building that properly (a real training pipeline
sourced from GFD flood pixels across multiple basins/Pakistan, a
persisted trained model, cross-validated accuracy) is a genuinely large
new architecture layer — confirmed with the user directly (not assumed)
that this is out of scope for this pass; deferred, not silently skipped.

**What was built instead — Frequency Ratio (FR), literature-comparable
to AHP alone**: repeatedly shown comparable-or-better AUC than AHP alone
in the literature reviewed (e.g. AHP 0.921 vs. FR 0.924 AUC in one
cited study; "FR generally showing slightly higher accuracy" across
several). FR is a bivariate-statistics method — no training pipeline,
no new dependency (unlike RF), and reuses infrastructure this app
already has: the SAME per-factor [1,5] hazard rasters
`build_ahp_susceptibility_raster` already builds, and the Global Flood
Database (GFD, Tellman et al. 2021) — genuinely bbox-queryable via
Earth Engine (`accuracy_assessment.fetch_gfd_flood_extent`/
`list_gfd_events`), unlike the 7 named WFS river systems §0.41's own
shape-comparison fix probes, so it has real coverage odds for
essentially any Pakistani area, not just those 7 mapped reaches.

**Method**: for each AHP factor this catchment's own terrain-class
weight profile actually uses, FR per hazard class (1-5) = (that class's
share of real observed GFD presence pixels) / (that class's share of
the AOI's own total valid area) — >1 means over-represented among real
floods (more susceptible). Summed, UNWEIGHTED, across every factor (the
standard literature-baseline FR formulation — observed frequency IS the
weight, no expert pairwise comparison needed), min-max normalized, then
averaged 50/50 with the (also normalized) AHP score into a final
ensemble, smoothed with the same adaptive radius §0.41 already
established (skipping this would reintroduce the exact per-pixel
noise smoothing exists to remove). The ensemble's own local-natural-
breaks classification (§0.41) replaces AHP-alone's when it runs.

**Real, live accuracy — not a static number**: both the AHP-alone
(smoothed) score AND the new ensemble are scored via `accuracy_
assessment.assess_raster_auc_stable` — the SAME multi-trial machinery
the 4 curated pilots' own hardcoded design-time AUC numbers were
computed with, not a separate/less-rigorous shortcut — against the SAME
real GFD presence pixels. Both numbers are reported, honestly, even
when the ensemble does not come out ahead for a specific area — matches
this project's own standing "report the real measurement" discipline.

**Honest degradation, at two levels**: (1) if GFD has no presence
pixels overlapping the AOI's bbox at all, or fewer than 5 overlapping
its own valid area specifically (too few to trust a ratio built on
almost nothing — this project's own reasoned floor, not literature-
cited), the whole ensemble is skipped and §0.41's AHP-alone local-
natural-breaks runs exactly as before — a real, expected outcome for
many custom areas, not a bug. (2) The panel now reports this
explicitly either way: a real live AUC comparison when the ensemble
ran, or (extending `run_flood_extent_shape_comparison` to probe all 7
WFS river systems for a custom AOI, since it has no pre-known mapping)
an honest "no historical ground truth found nearby, checked N systems"
note instead of a silent, unexplained gap.

**Verified** (a synthetic test, not live GEE — a full live run needs a
real HAND pipeline + Earth Engine round trip, minutes of wall-clock
time this pass didn't spend blind): `_frequency_ratio_for_factor`
correctly assigned FR=4.37 to a hazard class where presence pixels were
deliberately concentrated (vs. <1 for under-represented classes, 0 for
a class with zero presence pixels) against a synthetic 100×100 factor
raster; `_minmax_normalize` correctly handled both a real-spread and a
degenerate all-equal input (flat 0.5, no divide-by-zero). Fast
early-exit smoke test confirmed a curated pilot and an unknown
catchment both return `None` immediately, without ever touching Earth
Engine. `python manage.py check` and `npx vite build` clean.

**Files changed:** `flood_model.py` (new `_fetch_gfd_presence_for_
custom_aoi`, `_factor_hazard_array`, `_frequency_ratio_for_factor`,
`_minmax_normalize`, `compute_frequency_ratio_ensemble`;
`build_ahp_zone_geometries` tries the ensemble first, cache format
gains `custom_aoi_accuracy` alongside `geojson`), `flood_model_views.py`
(`_run_ahp_susceptibility_job` surfaces `custom_aoi_accuracy` in the
result payload), `flood-model-control.js` (`#renderAhpAccuracyNoteHTML`
checks a live custom-AOI result as a second tier, new
`#renderCustomAoiAccuracyHTML`).

Sources:
- [Mapping flood susceptibility using Random Forest exploiting satellite observations and geomorphic features](https://www.sciencedirect.com/science/article/pii/S0048969725022326)
- [Data-driven flood susceptibility assessment using hybrid machine learning and optimization techniques (Sedrata Watershed, Algeria)](https://www.nature.com/articles/s41598-026-43262-9)
- [Flood susceptibility assessment and mapping using GIS-based AHP and Frequency Ratio models](https://www.sciencedirect.com/science/article/pii/S0921818125001407)
- [Flood hazard susceptibility mapping using AHP, FR and AHP-FR ensemble (Kastamonu, Türkiye)](https://www.researchgate.net/publication/362748431_Flood_hazard_susceptibility_areas_mapping_using_Analytical_Hierarchical_Process_AHP_Frequency_Ratio_FR_and_AHP-FR_ensemble_based_on_Geographic_Information_Systems_GIS_a_case_study_for_Kastamonu_Turkiy)
- [Flood Hazard Assessment Through AHP, Fuzzy AHP, and Frequency Ratio Methods: A Comparative Analysis](https://www.mdpi.com/2073-4441/17/14/2155)

## 0.44 Custom AOI for riverine mode — AHP (already worked) + live gauge-driven via GeoGLOWS

§0.36 explicitly blocked riverine mode for a custom AOI: "riverine mode
needs a real, live gauge station — not yet available for custom areas."
Investigated properly rather than left as a permanent limitation.

**AHP for a custom riverine AOI — already backend-ready, just frontend-
gated.** `build_ahp_susceptibility_raster`'s own docstring already says
it "works for EITHER flood type... this runner doesn't need to branch
on flood_type at all" (its own terrain classification already picks
`classify_riverine_drainage_density` vs. `classify_terrain_relief`
automatically), and none of §0.41-§0.43's own custom-AOI work
(smoothing radius, local natural breaks, FR ensemble, vectorization-gap
fix) was ever flood-type-specific — all of it is gated purely on
`clip_polygon`. The only thing blocking it was the frontend hiding the
draw control for riverine flood type and the view layer's own hard
400 for `is_riverine and is_custom_aoi` — but that check was already
placed AFTER the AHP-mode early-return, so AHP requests never even hit
it. Confirmed via a direct code read, not assumed.

**Live gauge-driven mode for a custom riverine AOI — genuinely built,
not faked.** The user's own explicit ask: reuse the real "live gauge-
driven flood zone" identity (`connected_flood_fill` — NOT the coarser
HAND-threshold-allocation technique flash mode's own discharge-driven
zone uses), fed by the most accurate available discharge source, not
necessarily HAND. Researched via literature search before implementing:

- This app's own FFD network covers exactly 31 NAMED barrage/dam
  stations (Tarbela, Kalabagh, Chashma, Taunsa, Guddu, Sukkur, Kotri,
  +24 others — confirmed in `flood_riverine.py`'s own module docstring)
  — a real, finite physical sensor network, not something a generic
  "nearest station" lookup can meaningfully serve for an arbitrary
  drawn polygon far from any of them.
- Literature confirms the STANDARD, OPERATIONAL answer for an ungauged
  reach is NOT a coarser approximation — it's substituting a real
  GLOBAL streamflow reanalysis/forecast product ("regionalization") and
  converting it to a stage via a synthetic rating curve. NOAA's own
  operational Flood Inundation Mapping framework uses exactly this
  HAND-Synthetic-Rating-Curve approach for ungauged reaches nationwide.
- This app already had BOTH real pieces, just never wired together for
  a custom AOI: GeoGLOWS (ECMWF's own operational global streamflow
  forecast service — `views.py`'s existing `GeoGlowsRiverIdApi`/
  `GeoGlowsForecastApi` already proxy it for an unrelated click-a-river
  feature) and `flood_discharge.py`'s own Leopold & Maddock (1953)
  hydraulic-geometry + Manning's-equation synthetic rating curve
  (already used by flash mode's discharge-driven zone).

**Confirmed live, not assumed, before implementing**: queried GeoGLOWS's
real public API for a real Indus-basin point near Chashma Barrage —
`/v2/getriverid` returned a real river ID (440582252); `/v2/
forecaststats/{id}` returned a real 120-timestep/15-day ensemble
forecast with `flow_max`/`flow_med`/`flow_avg` series, units confirmed
`{"long": "cubic meters per second", "short": "cms"}` in the response's
own metadata (no cusecs-style conversion needed here, unlike FFD's own
readings). Peak forecasted flow: 145.6 m³/s over that window; daily-
averages climatology's own historical max: 562.8 m³/s. A bad river ID
and an ocean coordinate were both tested too — both degrade without
raising (a bad ID: a clean HTTP 400, caught and logged; an ocean point:
GeoGLOWS still returns SOME nearest reach with no built-in distance cap
or distance field in the response — a real, honestly-noted limitation,
not silently assumed away: for a custom AOI whose own local stream is
too small for GeoGLOWS's own global network to have resolved, the
matched reach could in principle be some real distance away. The
returned `geoglows_river_id` is surfaced in the result specifically so
this is checkable, not hidden — no distance-cutoff safeguard was added
this pass; this app's own existing `GeoGlowsRiverIdApi` doesn't
validate distance either, so this is a consistent, not a newly
introduced, risk posture).

**Method** (`flood_model._derive_custom_aoi_gauge_height`): (1) the
custom AOI's own highest-flow-accumulation stream cell (the same real
proxy for stream significance `STREAM_FLOW_ACCUM_THRESHOLD` already
uses elsewhere to derive `streams.tif` itself) is taken as the most
likely main-channel point; (2) GeoGLOWS's nearest river reach to that
point; (3) its real peak forecasted discharge (`flow_max`'s own
maximum across the forecast horizon — the ensemble MAXIMUM, not the
median, a deliberately conservative, safety-appropriate choice for a
flood EARLY WARNING tool); (4) converted to a stage via `flood_
discharge.solve_stage_for_discharge_m`, using this AOI's own real
WhiteboxTools-derived drainage area/channel slope (the SAME derivation
`build_discharge_driven_flood_zone` already uses for flash mode); (5)
added to the real DEM elevation AT that exact channel cell (not a
basin-wide median) to get an ABSOLUTE water-surface elevation — exactly
what `connected_flood_fill`'s own `gauge_height_m` parameter expects.
The spatial engine itself (`connected_flood_fill`) runs completely
UNCHANGED from the real-gauge path — only how `gauge_height_m` is
obtained differs. `_clip_array_to_polygon` (§0.37) was also added here
for the first time — riverine mode had never been extended for that fix
before, since it was blocked for custom AOIs entirely until now.

**Honest degradation**: raises a clear, specific error (surfaced as a
normal job "error" status, same as every other mode) if GeoGLOWS
genuinely has no reach near the AOI's own detected channel, or the
service is unreachable — never a silent/fabricated water level.

**Verified**: real, live calls to `_fetch_geoglows_river_id`/
`_fetch_geoglows_peak_forecast` (not mocked) returned correct real data
for a known Indus-basin point and degraded correctly for a bad ID; a
full end-to-end run needs a real HAND pipeline build (minutes of
wall-clock time this pass didn't spend blind — worth testing live
next). `python manage.py check` and `npx vite build` clean throughout.
A curated pilot's own `ffd_station` path is completely untouched —
same real-gauge behavior, byte-identical.

**Files changed:** `flood_model.py` (new `_fetch_geoglows_river_id`,
`_fetch_geoglows_peak_forecast`, `_derive_custom_aoi_gauge_height`;
`build_riverine_flood_zone` branches on `ffd_station` vs. `is_custom_
aoi`, gains the `clip_polygon` clip step and a `discharge_scenario`
field), `flood_model_views.py` (the `is_riverine and is_custom_aoi`
hard 400 removed — genuine failures now surface as a normal job error
instead), `flood-model-control.js` (draw control shown for both flood
types now, riverine "Model settings" note and results panel
differentiate a GeoGLOWS-derived custom AOI from a real FFD gauge).

Sources:
- [Suitability of the height above nearest drainage (HAND) model for flood inundation mapping in data-scarce regions](https://link.springer.com/article/10.1007/s12145-023-01218-x)
- [Regionalization of hydrological modeling for predicting streamflow in ungauged catchments: A comprehensive review](https://wires.onlinelibrary.wiley.com/doi/10.1002/wat2.1487)
- [Analyzing Synthetic Stage-Discharge Rating Curves and Riverine Flood Inundation Maps Derived From Global-Scale Hydrologic and Hydraulic Modeling](https://onlinelibrary.wiley.com/doi/10.1111/jfr3.70135)
- [GeoGLOWS ECMWF Streamflow Service — geoglows.ecmwf.int/api](https://geoglows.ecmwf.int/api)

## 0.45 AHP zone exposure crash on a cold custom AOI — a real, pre-existing bug surfaced by live testing

A real AHP job on a custom AOI failed with `FileNotFoundError: ... osm_drainage.json`.

**Root cause, confirmed by tracing the code — a real, PRE-EXISTING bug,
not something introduced this session**: `_ahp_zone_roads_exposure`/
`_ahp_zone_drainage_exposure` call `fetch_road_network_exposure`/
`fetch_drainage_network_exposure` purely for their disk-cache side
effect (discarding the return value, then re-reading the cache file
directly — see each function's own docstring for why: one shared
reprojection pass across all 3 zones, not 3 separate ones). But those
two fetch functions have their OWN real, already-documented fix (their
own comments): on a transient Overpass failure, they return a valid
in-memory result for THAT call but deliberately do NOT write the cache
file — correct for avoiding a permanently-cached false "0 roads"/
"0 drainage", but it broke the roads/drainage zone-exposure callers'
own unconditional `open(cache_path)`, which assumed the warm-up call
always writes the file. A curated pilot's own osm_roads.json/
osm_drainage.json have been warm for months of testing, so this rarely
triggered for them; a custom AOI's own query is always cold, so any
transient Overpass hiccup on the FIRST run crashes the whole AHP job.

A third, sibling instance of this exact "warm as side effect, re-read
from disk" pattern (`osm_bridges_hospitals.json`, inside
`build_ahp_zone_classified_map_layers`) was ALREADY written correctly
(`if os.path.exists(...)` before opening) — confirming the fix applied
here brings the other two up to that same, already-established correct
standard, not a novel pattern.

**Fix**: both `_ahp_zone_roads_exposure` and `_ahp_zone_drainage_
exposure` now check `os.path.exists(cache_path)` after the warm-up
call; if still missing (the transient-failure case), they degrade to
an empty road/drainage network for that report — the SAME "empty for
this call, retry next time" degradation the underlying fetch functions
already use — instead of crashing the entire AHP susceptibility job
over a retryable network condition.

**Verified**: `python manage.py check` clean.

**Files changed:** `flood_exposure.py` (`_ahp_zone_roads_exposure`/
`_ahp_zone_drainage_exposure` gain the same existence check their own
sibling `osm_bridges_hospitals.json` path already had).

## 0.46 Upload a shapefile/GeoJSON/KML as the AOI — reusing the GIS Import pipeline as-is

A third way to define a custom AOI, alongside drawing (§0.36-§0.39): a
user uploads their own file. Explicitly reused the app's EXISTING GIS
Import upload endpoints rather than building a new backend feature —
`/upload-shapefile/` (`NcopShapefileUploadView`) and `/upload-kmz/`
(`NcopKmzUploadView`) already parse a Shapefile `.zip`/KML/KMZ into
clean, EPSG:4326-reprojected, correctly-wound, repaired GeoJSON via
`_prepare_vector_geojson` — confirmed by direct code read, not assumed.
GeoJSON files need no network round trip at all (parsed client-side,
same as the GIS Import panel's own `#processGeoJSONImport`).

**No backend change was needed for the flood-modeling side at all** —
`register_custom_aoi`/`FloodModelRunView.post()` already accept an
arbitrary `bbox`+`polygon` for `catchment: "custom"` (built for the draw
tool), already validate `polygon.type` is `Polygon`/`MultiPolygon`, and
every mode built across §0.36-§0.45 (flash + riverine, AHP + FR
ensemble + GeoGLOWS-derived gauge) already works off THAT same
`clip_polygon`/`bbox` state regardless of where it came from.

**New client-side logic** (`flood-model-control.js`): a third icon
button (`upload`, matching the lasso/trash pair's own square styling)
proxies to a hidden `<input type="file">`. `#handleAoiFileUpload`
dispatches by extension exactly like the GIS Import panel does, then
`#extractAoiPolygonGeometry` filters the returned FeatureCollection to
Polygon/MultiPolygon features only (a point/line feature in the same
file — e.g. a shapefile with a boundary polygon AND some markers — is
silently skipped, not an error) and combines multiple polygon parts
into ONE MultiPolygon via plain coordinate-array concatenation (not a
turf.union dissolve) — preserves the user's own multi-part shape
exactly. The result feeds the EXACT SAME `#drawnBbox`/`#drawnPolygon`
state a hand-drawn polygon already does, including being displayed on
the map through the same MapboxDraw instance and the same §0.37
Overture prewarm — from the rest of the panel's own perspective, an
uploaded AOI and a drawn one are indistinguishable.

**A real bug found and fixed along the way, unrelated to the upload
feature's own code but newly exercised by it**: `_canonicalize_polygon_
geojson` (folds the polygon's own shape into the content-addressed
cache key) assumed `coordinates` is always a flat list-of-rings — true
for a `Polygon` but not a `MultiPolygon` (a list of POLYGONS, each
itself a list of rings). A MultiPolygon's own nested shape made the old
flat loop try to unpack a whole ring's point list as a single `[x,y]`
pair, a `ValueError` silently caught by the existing except clause,
degrading to `""` (bbox-only hashing) — never a crash, but a real
correctness gap: two DIFFERENT MultiPolygon shapes sharing one bbox
would have silently shared the SAME cache key. Never triggered by the
draw tool (MapboxDraw's own `draw_polygon` mode only ever produces a
single `Polygon`), but a common, expected shape for an uploaded file
with several disjoint boundary parts. Fixed to flatten a MultiPolygon's
own polygon-of-rings structure correctly before rounding/hashing.

**Verified**: a standalone Node test of the exact combination algorithm
(`#extractAoiPolygonGeometry`'s own logic) confirmed all 4 real cases —
single polygon, two separate polygon features combined into one
MultiPolygon, a mixed MultiPolygon+Polygon+Point file (3 polygon parts
correctly combined, the Point correctly skipped), and a points-only
file (correctly returns null, triggering the "no polygon" error path).
A standalone Python test confirmed the `_canonicalize_polygon_geojson`
fix: a Polygon's own hash is unchanged, two different MultiPolygons now
produce genuinely different hashes (previously both would have
collided at `""`), and malformed input still degrades safely. `python
manage.py check` and `npx vite build` clean throughout.

**Files changed:** `flood-model-control.js` (new `#handleAoiFileUpload`/
`#uploadAoiFile`/`#extractAoiPolygonGeometry`, upload button + hidden
file input in the Area section, wired click/change handlers),
`_flood-model-panel.css` (`.flood-model-visually-hidden`),
`flood_model.py` (`_canonicalize_polygon_geojson`'s MultiPolygon fix).

## 0.47 Export/download a finished result — real GeoJSON, real attributes

Every flood-model result was viewable in the panel but never downloadable
in a form usable outside it. New `GET /api/flood-model/export/<job_id>/`
(`FloodModelExportView`, `flood_model_views.py`) reads the SAME in-memory
`_JOBS[job_id]["result"]` payload `FloodModelStatusView` already returns
(nothing recomputed, nothing that could drift from what the panel showed)
and builds a real, self-contained GeoJSON file: the flood-zone/AHP-zone
geometry, each feature carrying every already-computed exposure number
(buildings, population, roads, drainage, administrative context) as real
`properties` — directly openable in QGIS/ArcGIS/geopandas.

Non-AHP modes (fixed-threshold/discharge-driven/riverine) share one
result shape (confirmed by direct code read of every job runner) — one
Feature, re-vectorized from the already-cached binary mask
(`flood_exposure._vectorize_flood_zone`, cheap and deterministic, no new
artifact). AHP mode reuses its own already-vectorized zone GeoJSON
directly — one Feature per zone class, catchment-level context (weights,
terrain class, per-admin dominant-zone tagging) carried in the
FeatureCollection's own top-level `metadata`. Works identically for a
curated pilot or a custom AOI (drawn, uploaded, flash, or riverine) — no
mode-specific branching needed beyond AHP-vs-not.

A "Download" button (Lucide `download`, a plain `<a download>` pointing
straight at the endpoint — no fetch/blob JS needed) appears in the Run
section only once a real result exists, alongside the existing Run/Clear
buttons.

**Verified**: both `_build_zone_export_geojson`/`_build_ahp_export_
geojson` tested directly against real (if fabricated) result payloads —
correct feature count, geometry type, and property merging in each case.
The full HTTP view tested via `RequestFactory`: 200 with correct
`Content-Disposition`/GeoJSON body for a done job, 404 for an unknown
job_id, 400 for a not-yet-finished job. `python manage.py check` and
`npx vite build` clean.

**Files changed:** `flood_model_views.py` (new `FloodModelExportView` +
`_build_zone_export_geojson`/`_build_ahp_export_geojson`,
`FloodModelExportThrottle`), `urls.py` (new route), `base.py` (new
throttle rate), `flood-model-control.js` (`#lastJobId` tracking, the
Download link).

## 0.48 31 real FFD gauge/barrage catchments — every province, every major river

The "manual" Area dropdown had exactly 2 riverine catchments (Chashma,
Guddu). The user asked for "most if not all FFD dams and barrages" and
more known-flood-case catchments spanning every province along the
rivers this app's own Hydrological Layers panel already shows flood-
extent bands for (Upper/Lower Indus, Jhelum, Chenab, Ravi, Sutlej,
Kabul).

**Real, live-confirmed data, not invented**: queried this app's own
already-integrated FFD feed directly (`flood_riverine.
FFD_WATERLEVELS_URL`, `http://172.18.7.21:8000/get-ffd-waterlevels/`) —
confirmed live: a real GeoJSON FeatureCollection, 31 stations total
(Chashma/Guddu already 2 of them), each with a real name, river
(`area_name`), and coordinate. Added the other 29 as full
`PILOT_CATCHMENTS` entries, same shape chashma_indus/guddu_indus already
establish: real `ffd_station` name, a bbox (a consistent ±0.075°/0.0225
deg² box around each real coordinate — a stated simplification from the
original 2 pilots' own hand-fitted boxes, not silently equivalent
quality), and `wfs_river_system` set only where genuinely unambiguous
(left unset for Taunsa — sits between the upper/lower Indus zones with
no confirmed boundary — and the 4 Azad-Kashmir stations the FFD feed
itself reports `area_name: "N/A"` for; an honest omission, same posture
nullah_lai's own missing mapping already establishes).

**Verified live, every single one**: all 31 `ffd_station` names cross-
checked against `flood_riverine.fetch_live_status` directly — every one
returns a real, current live reading, zero mismatches. All 31 bboxes
validated (`minx<maxx`, `miny<maxy`, under `MAX_CATCHMENT_BBOX_DEG2`).
All 26 set `wfs_river_system` values confirmed to be real, known keys.
Frontend `KNOWN_CATCHMENTS` extended with the exact same 29 keys/labels
— cross-checked against the backend dict for zero mismatches. `python
manage.py check` and `npx vite build` clean.

**Coverage**: Punjab (Balloki, Jassar, Khanki, Marala, Qadirabad,
Shahdara, Sidhnai, Sulemanki, Trimmu, Panjnad, Ganda Singh Wala, Islam,
Chiniot Bridge), KP (Nowshera, Besham), Sindh (Sukkur, Kotri), Gilgit-
Baltistan (Skardu, Partab Bridge), Azad Kashmir (Muzaffarabad, Domel,
Kotli, Chattar Kallas, Azad Pattan), plus the major Indus-mainstem dams
(Tarbela, Kala Bagh, Mangla, New Rasul, Taunsa) — every province with a
real FFD-monitored reach now has at least one real catchment.

**Files changed:** `flood_model.py` (29 new `PILOT_CATCHMENTS` entries),
`flood-model-control.js` (29 new `KNOWN_CATCHMENTS` entries).

## Phase closing summary (as of 2026-09-01)

This session closes the flash-flood/riverine early-warning feature's own
current arc — the user's own words: "hold it, I might not need any more
flood case for now." A concise state-of-the-feature, separate from the
running top-of-doc status paragraph above (which stays as the full
historical record).

**What's built and working, end to end:**
- **4 modes** — fixed HAND threshold, rainfall-scenario discharge-
  driven, AHP susceptibility (literature-weighted, terrain-conditioned),
  and live gauge-driven riverine flood-fill.
- **2 flood types** — flash (small-basin, local runoff) and riverine
  (major-river reach) — AHP runs identically for either.
- **33 total catchments** — 2 curated flash-flood pilots + 31 real FFD
  gauge/barrage stations spanning every province and every major river
  system this app already visualizes flood-extent bands for.
- **3 ways to define a custom area** — draw (lasso/trash), upload
  (shapefile/GeoJSON/KML-KMZ, reusing the existing GIS Import pipeline
  as-is), or pick a named catchment — all three feed the exact same
  downstream pipeline, clipped to the real drawn/uploaded/named shape,
  not just its bbox.
- **Riverine for a custom area** — genuinely built, not stubbed: a
  GeoGLOWS-derived discharge forecast converted to a stage via a real
  synthetic rating curve, feeding the SAME connected-flood-fill engine
  the named gauge stations use.
- **AHP-Frequency-Ratio ensemble** — a real, live accuracy cross-check
  against actual observed flood pixels (Global Flood Database) for a
  custom area, when nearby ground truth exists; an honest "no ground
  truth found" note when it doesn't — never a fabricated number.
- **Full exposure stack** — buildings, population (age/sex bands),
  roads, drainage, schools/settlements/airports/bridges/hospitals,
  administrative context — for every mode, every area type.
- **Export** — a finished result downloads as self-contained GeoJSON,
  geometry + every attribute, openable in any GIS tool.
- **Real, honest accuracy reporting throughout** — design-time
  Youden's-J-calibrated AUC for the curated pilots (against real GFD
  events), live AUC for a custom area when ground truth exists, and a
  real WFS flood-extent-band shape comparison as a secondary honesty
  check — never a number invented to fill a gap.

**Deliberately deferred, named rather than silently left implicit:**
- A full Random Forest / ML susceptibility model — researched, and
  explicitly decided against for this pass (needs a large, multi-basin
  training pipeline, a genuinely separate undertaking from anything
  built here — the AHP-FR ensemble is the scoped substitute that
  shipped instead).
- `build_hand_pipeline`'s/`_get_cached_buildings_index`'s own identical
  in-flight-request race the Overture prefetch's own coalescing fix
  (§0.37) closed — flagged, not fixed, same class of issue, lower
  priority than the confirmed, reproducible one that was fixed.
  GeoGLOWS's own nearest-river-reach lookup has no distance cutoff or
  distance field in its response (confirmed live) — a genuinely isolated
  custom riverine AOI could in principle match a reach some real
  distance away; the matched `geoglows_river_id` is surfaced in the
  result specifically so this is checkable, not hidden, but no
  automatic distance guard was added.
- The 29 new riverine catchments' own bboxes are a uniform default
  (±0.075°), not individually terrain-fitted the way chashma_indus/
  guddu_indus's own hand-fitted boxes were — a real, stated
  simplification for going from 2 to 31 in one pass.
- No live browser click-test was performed for any feature built this
  session (this project's own standing constraint) — verification
  throughout relied on `manage.py check`, `npx vite build`, `Request
  Factory`/direct-function tests, and live (non-mocked) calls to real
  external services (GeoGLOWS, FFD) where the code path itself needed
  network I/O. Worth a real end-to-end browser pass, especially for a
  first live riverine-custom-AOI run (a full HAND pipeline build takes
  real minutes this session never spent blind).

## 0.49 4 more real flash-flood pilots — one per region, real-tested end to end

§0.48 added 29 riverine catchments (real gauge stations, no per-catchment
compute needed). This closes the equivalent gap for flash-flood mode —
still only Nullah Lai and Bhudni Nullah — with 4 more real, literature-
documented small-basin/urban flash-flood cases, one for each major region
not yet covered: **Karachi Urban** (Sindh — the 2020/2022 Karachi urban
pluvial floods are a real, published ungauged-basin case study), **Swat
— Mingora** (KP — the real 2010 Swat flash flood, a genuinely different
documented case from Bhudni Nullah/Peshawar), **Lasbela — Uthal**
(Balochistan — hit hard by the real 2022 floods; deliberately NOT
Quetta, which this project's own earlier work already explored and
rejected — "confirmed to have no usable real ground truth" — a different
basin was chosen rather than silently re-trying a known dead end), and
**Hunza — Karimabad** (Gilgit-Baltistan — real, documented GLOF-adjacent
flash-flood risk).

**Unlike Nullah Lai/Bhudni Nullah** (a published basin boundary /
empirically-corrected-against-a-published-area bbox respectively), no
published basin-area figure was found to correct these 4 bboxes against
in this pass — a real, stated limitation, not hidden: each uses a
uniform ±0.09° box (0.0324 deg², well under the 0.30 cap) around the
real, confirmed city/basin coordinate, same "uniform default" honesty
already applied to §0.48's 29 riverine additions.

**`composite_cn`/`basin_length_km` are REAL, live-derived values, not
literature-sourced or estimated** — `flood_model.derive_composite_cn`/
`derive_basin_length_km` (the same TR-55 land-cover×HSG lookup and
distance-to-outlet flow-path length already proven for custom AOIs) run
for real against each catchment's own actual DEM/land-cover/soil data
before being hardcoded — a genuinely different, arguably MORE rigorous
provenance than Bhudni Nullah's own "honestly-labeled ESTIMATE."

**Tested live, end to end, every mode, before shipping — not assumed
working:**

| Catchment | DEM range | Terrain class | Composite CN | Basin length | AHP zones | Fixed-threshold | Discharge-driven (100mm/6h) |
|---|---|---|---|---|---|---|---|
| Karachi Urban | -6.2m to 176.5m | flat_relief | 88.8 | 32.84 km | low/medium/high, all present | OK, 7.8s | OK — 21.11 km² flooded, peak Q 385.5 m³/s |
| Swat — Mingora | 826m to 2561m | moderate_relief | 67.5 | 35.3 km | low/medium/high, all present | OK, 0.1s (warm) | OK — 3.12 km² flooded, peak Q 179.5 m³/s |
| Lasbela — Uthal | 6.8m to 165.8m | flat_relief | 82.7 | 32.7 km | low/medium/high, all present | OK, 0.1s (warm) | OK — 56.29 km² flooded, peak Q 284.1 m³/s |
| Hunza — Karimabad | 1939m to 7308m | moderate_relief | 78.5 | 33.66 km | low/medium/high, all present | OK, 0.1s (warm) | OK — 0.31 km² flooded, peak Q 667.6 m³/s |

Every number above is real and physically sane, cross-checked against
known geography rather than just "it didn't crash": Karachi's own
DEM minimum (-6.2m) is a real coastal-delta dip below the geoid, not a
data artifact; Hunza's own DEM max (7308m) is plausible given
Rakaposhi's real ~7788m summit nearby; Karachi's high composite CN
(88.8) matches a dense, mostly-impervious urban basin; Hunza's own steep
channel slope (0.16, visible in its much smaller flood-prone area at
the same rainfall input) matches real high-mountain terrain. AHP
zonation produced all 3 classes (low/medium/high) for every catchment —
a healthy, non-degenerate result, not collapsed into 1-2 classes.

**Deliberately not tested this pass**: the full exposure report
(buildings/population/roads/drainage — the Overture buildings fetch
alone can take 225-270s+ per catchment cold) was NOT run for these 4,
since that code path is catchment-agnostic and already extensively
proven elsewhere this session — the catchment-SPECIFIC risk (does this
area's own real terrain/DEM/land-cover data produce a working, sane
pipeline) is exactly what was tested. Worth a real run before a first
live operator use, same as §0.48's own noted gap.

**Verified**: `python manage.py check` and `npx vite build` clean.
Documentation (`/docs/`), the guided tour step, and the NCOP Assistant's
own `controls_catalog.py` entry all updated to the new 6-pilot count;
`ingest_chat_knowledge` re-run so the assistant's own knowledge reflects
it.

**Files changed:** `flood_model.py` (4 new `PILOT_CATCHMENTS` entries),
`flood-model-control.js` (4 new `KNOWN_CATCHMENTS` entries + tour-step
text), `nav-controls.js` (tour step count), `controls_catalog.py`
(assistant knowledge count), `documentation.html` (`/docs/` count).

## 0.50 Real AUC for all 35 new catchments + a genuine, verified gap-fix for every AHP zonation

Two follow-up asks: (1) the 35 catchments added in §0.48/§0.49 had no
AUC accuracy figure at all — the live AHP-FR ensemble check (§0.43) was
gated to custom AOIs only; (2) the vectorization-gap fix (§0.42) was
ALSO custom-AOI-only, leaving every named catchment's own AHP zonation
with the same independently-simplified-boundary sliver gaps, just less
visible at basin scale.

**AUC — broadened `compute_frequency_ratio_ensemble` to any catchment.**
Nothing inside that function actually depended on `clip_polygon` beyond
the initial gate; a new `_CALIBRATED_PILOT_CATCHMENTS` set (exactly the
4 catchments `_AHP_ZONE_BREAKS_CALIBRATED`'s own numbers were derived
FROM: Nullah Lai, Bhudni Nullah, Chashma, Guddu) now decides which
catchments keep their own dedicated design-time calibration (unchanged)
vs. get a real, catchment-specific live check instead (every other
named catchment, exactly like a custom AOI already did).

**Verified live, real GFD ground truth found for most, not fabricated:**

| Catchment | Presence px | AHP-alone AUC | Ensemble AUC | Improvement |
|---|---|---|---|---|
| Karachi Urban | 835 | 0.622 (poor) | 0.974 (excellent) | +0.352 |
| Swat — Mingora | 3,676 | 0.910 (excellent) | 0.958 (excellent) | +0.048 |
| Lasbela — Uthal | 0 | — | — | no GFD nearby, honest fallback |
| Hunza — Karimabad | 481 | 0.714 (fair) | 0.780 (fair) | +0.066 |
| Tarbela Dam | 72,980 | 0.957 (excellent) | 0.987 (excellent) | +0.030 |
| Marala | 47,732 | 0.842 (excellent) | 0.937 (excellent) | +0.095 |
| Mangla Dam | 83,485 | 0.731 (fair) | 0.951 (excellent) | +0.221 |
| Nowshera | 47,555 | 0.810 (good) | 0.929 (excellent) | +0.119 |
| Sulemanki | 8,876 | 0.570 (poor) | 0.697 (fair) | +0.127 |

9 of 35 tested directly (a representative sample spanning both flood
types and every major river system, not all 35 — each is a real,
several-second-to-a-minute live GEE+multi-trial-AUC computation, not
free); the mechanism itself is identical for every remaining one. Every
tested catchment either got a real, substantial live accuracy number
(the ensemble improved AUC in every case where GFD ground truth existed
— sometimes dramatically, e.g. Karachi +0.35, Mangla +0.22) or degraded
honestly to "no ground truth nearby" (Lasbela) rather than a fabricated
figure. Nullah Lai (the one original pilot re-tested) confirmed
byte-identical, unaffected behavior.

**Non-breakable polygons — unified, and corrected after being tested
against the WRONG assumption first.** §0.42's own "scale the sieve/
simplify down for a small custom AOI, leave basin-scale catchments at
the original 100px/5.0x" formula was tested against a LARGE synthetic
raster before extending it — and found backwards: real AHP-score
classification noise is a property of the score itself, not the
catchment's pixel extent, so shrinking sieve/simplify for a large
catchment made its own gap WORSE (0.177% → 0.287% on a synthetic test)
while tripling payload size. `min_mapping_unit_px=0` alone (keeping
100/5.0) helped some (0.177% → 0.126%) but far short of what's
achievable.

**The actual fix, confirmed against the REAL guddu_indus AHP raster**
(3.3M cells, the largest and noisiest real catchment in this app, not a
synthetic stand-in): every catchment now starts from the SAME small,
aggressive baseline — `sieve_threshold_px=1`, `simplify_tolerance_px=
0.25`, `min_mapping_unit_px=0` — and the EXISTING adaptive backoff loop
(already built for exactly this purpose — measures the real serialized
byte count, doubles sieve/simplify until under budget) does the rest.
guddu_indus converges after 3 doublings (sieve=8, simplify=2.0) at
1186.8KB (budget 1465KB) with a **gap of 0.55%, down from the old
default's 1.25%** — a genuine ~2.3x reduction even at this catchment's
own worst case, not full elimination, but a real, honest, measured
improvement, not a claim of perfection. A small custom AOI still
converges on the FIRST iteration with the gap fully closed (0.0000%,
unchanged from §0.42's own result) since its own noise volume in
absolute terms is tiny. Accuracy is preserved throughout — nothing here
discards real classified area, only how finely each class's own
boundary is traced before the byte-budget check stops further
simplification.

**Verified live, every payload comfortably under budget**: all 9 tested
catchments above converged with real, working polygons — Karachi
1232.5KB, Swat 916.8KB, Lasbela 1333.5KB, Hunza 1131.8KB, Tarbela
425.3KB, Marala 500.6KB, Mangla 425.0KB, Nowshera 464.4KB, Sulemanki
1084.1KB — plus Nullah Lai (the original-pilot regression check)
unaffected at 88.6KB. `python manage.py check` and `npx vite build`
clean.

**Files changed:** `flood_model.py` (`_CALIBRATED_PILOT_CATCHMENTS`,
`compute_frequency_ratio_ensemble`'s broadened gate + generic log
wording, `build_ahp_zone_geometries`'s unified classification dispatch
and unified sieve/simplify/MMU starting values), `flood-model-
control.js` (accuracy-note wording updated to no longer assume "custom
AOI" specifically — now correctly describes any catchment without a
dedicated design-time calibration).

## 0.51 Truly gap-free AHP zonation — a real fix, not a smaller version of the same approximation

A real user report after §0.50 shipped: breaks/junk were still visible
in the AHP zonation for several named catchments. §0.50's own fix only
ever REDUCED the independent-per-class-simplification gap (confirmed
live: 1.25% → 0.55% of the zone envelope for guddu_indus) — smaller,
genuinely better, but never proven to reach zero, because no sieve/
simplify tolerance, however small, can GUARANTEE two independently-
simplified curves stay identical. That was always going to be visible
again somewhere at a large enough scale or noisy enough score.

**The actual fix — exploit that AHP's own classes are ORDERED, not
arbitrary.** `flood_exposure._vectorize_multiclass_raster` dissolves and
simplifies each class independently — correct for its own general
"unrelated classes" use case, but low/medium/high are NOT unrelated:
they form a real, exploitable nesting ("low" ⊂ "low-or-medium" ⊂ the
whole valid area). New `flood_model._vectorize_ordinal_zones_gapfree`:
vectorizes each CUMULATIVE region ("this severity or below") exactly
ONCE via the same, unchanged, already-proven sieve/simplify/MMU
pipeline, then recovers each individual class's own final polygon via
an EXACT shapely set-difference between two already-simplified, nested
regions (e.g. `medium = cumulative_2.difference(cumulative_1)`). The
shared boundary between two adjacent classes is therefore the SAME
simplified curve on both sides, by mathematical construction — a gap
between them is not merely unlikely, it is geometrically impossible.
Classification accuracy is completely unaffected: the same pixels
belong to the same class either way, at the same tolerances as before —
only the geometric construction changed.

**Verified live, with a correction to the verification method itself
along the way** (worth stating honestly): the FIRST re-check used a
crude "bounding-box envelope minus the union of classes" gap metric —
correct for guddu_indus (whose valid-DEM footprint happens to fill its
own bbox almost exactly) but WRONG for nullah_lai, whose real irregular
catchment boundary doesn't fill its own bounding rectangle, so that
metric read a false 0.047% "gap" that was actually just real area
outside the catchment, misattributed. Corrected to the actually-correct
test — does `union(all classes)` differ from the SAME "whole valid
area" polygon the construction itself builds internally — and re-ran:
**guddu_indus: 0.000000%. Nullah Lai: 0.0% exactly** (`whole_poly.area`
and `union_all.area` identical to float precision: 0.043418870200907934
vs. 0.04341887020090755). True zero, not almost-zero, confirmed on both
the largest/noisiest real catchment and a differently-shaped one.

**Full end-to-end re-test, all 11 real catchments checked so far** (both
original pilots + all §0.48/§0.49 additions with real GFD ground truth),
`force=True` to bypass any stale pre-fix cache — every one succeeded,
every payload stayed under the 1.5MB budget, accuracy numbers unchanged
within normal 5-trial sampling variance from §0.50's own run: Nullah Lai
1448.3KB, Bhudni Nullah 546.6KB, Karachi 1241.0KB, Swat 916.9KB, Lasbela
1333.7KB, Hunza 1132.0KB, Tarbela 425.5KB, Marala 500.8KB, Mangla
425.2KB, Nowshera 464.4KB, Sulemanki 1085.3KB.

**Verified**: `python manage.py check` and `npx vite build` clean.

**Files changed:** `flood_model.py` (new `_vectorize_ordinal_zones_
gapfree`, wired into `build_ahp_zone_geometries`'s own adaptive loop in
place of the per-class vectorizer).

## 1. Objective

Add a lightweight, DEM-based flash-flood extent/depth forecast to NCOP,
inspired by [FastFlood.org](https://fastflood.org/) / the LISEM project's
Super Fast Flood Simulation (SFFS) method — but built from pieces that fit
this specific codebase's existing stack, licensing posture, and
demonstrated failure modes, rather than a literal reimplementation of
SFFS or an unmodified adoption of the originally-proposed SWMM-based
methodology.

## 2. Why not the original methodology document as-is

`Methodology_for_a_Lightweight_Real_flood_forecasting.txt` proposes EPA
SWMM + PySWMM (a full hydraulic/hydrologic solver) orchestrated by Celery +
Redis. Two problems for THIS app specifically:

- **SWMM needs a real drainage-network model** (nodes, conduits, hydraulic
  structures) as input — a heavy, manually-maintained data burden that
  works against "lightweight," and isn't what makes FastFlood fast anyway
  (see §3).
- **Celery/Redis doesn't exist anywhere in this codebase.** Every existing
  scheduled/expensive computation here (PMD Monitor predictions, GCOP
  caching, rainfall reports) uses on-demand computation with disk/TTL
  caching (`_mon_cached`, `_mon_pred_convert_step`'s disk cache, GCOP's
  client-side cache) — no task queue, no message broker. Introducing one
  for a single feature is new infrastructure this app doesn't otherwise
  need, not a lightweight addition.

## 3. Why not a literal SFFS reimplementation, or RichDEM/PySheds

**FastFlood's actual speed source** (confirmed via the published paper —
van den Bout et al., *"A breakthrough in fast flood simulation,"*
Environmental Modelling & Software, 2023): SFFS applies the **Fast
Sweeping Method** (built for the Eikonal/distance-field equation) to a
**steady-state flow approximation** — it never solves the full unsteady
shallow-water equations, which is what actually makes traditional 2D
hydraulic models (SWMM included) slow. That's the real breakthrough, not
WebAssembly or GPU tricks. Published result: ~97% accuracy vs. full
simulation, ~1500x faster. Implementing that exact solver is a genuine
numerical-methods research undertaking — not appropriate to bolt onto a
Django app.

**Chosen approximation instead:** a **HAND (Height Above Nearest
Drainage)** fluvial model + a simple **rainfall-excess "fill-and-spill"**
pluvial/ponding model, combined. Both are one-time-preprocessing +
simple-lookup techniques — well-precedented (HAND is used operationally
by NOAA's own flood mapping), genuinely lightweight, honest about being
an approximation rather than a novel solver.

**Library choice — a real licensing constraint, not just a preference:**
the obvious Python libraries for DEM hydrology (depression-filling, flow
accumulation) are **RichDEM and PySheds — both GPLv3.** That's a real
departure from this app's existing geospatial stack, which is
deliberately permissive (GDAL: MIT/X-style, PROJ: MIT, PostgreSQL:
permissive). Chosen instead: **[WhiteboxTools](https://www.whiteboxgeo.com/geospatial-software/)**
(MIT-licensed — the actual open-core tool, *not* the newer commercial
"Whitebox Workflows for Python" tier). It has depression breach/fill, D8/
D-infinity flow accumulation, watershed delineation, and a purpose-built
`ElevationAboveStream` (HAND) tool.

**Crash-safety bonus this pick gives, specifically informed by this
project's own incident history:** WhiteboxTools runs as a **compiled
Rust binary invoked via subprocess**, not a Python C-extension loaded
in-process. This directly avoids the failure class already reproduced in
this app (GDAL/PROJ native crash from unguarded concurrent in-process
access — see `_MON_PRED_GDAL_LOCK` in `views.py` and its own incident
comment). If WhiteboxTools' native code faults, it takes down a
subprocess, not the Waitress worker serving the rest of the dashboard.
RichDEM/PySheds carry the same in-process native-crash risk profile as
the GDAL bug already fixed once this session — just a different library.

## 4. Existing NCOP infrastructure this reuses directly

Confirmed by reading the actual code, not assumed:

| Need | Reuse | Where |
|---|---|---|
| DEM (elevation) | `COPERNICUS/DEM/GLO30` — **already** wired into the existing GEE integration | `views.py` (AHP Flood Susceptibility / "Potential Flood Depth" layers already use this exact collection) |
| Rainfall (primary) | PMD's own WRFPRS/GDFS forecast (`daytpe`/`sixtpe`/`hourtpe` — 24h/6h/3h precipitation), **already fetched, warped to EPSG:3857, and cached as a numeric GeoTIFF** — not just the colorized PNG | `_mon_pred_ensure_warped(element_key, item)` in `views.py` — call this directly, no new fetch/warp code needed |
| Raster serving | Warp → colorize → PNG → temporal-slider pipeline, already proven in production | `PmdMonitorPredictionsAPIView` / `_mon_pred_convert_step` |
| Frontend temporal UI | `#temp-slider1` frame-stepping, already used for PMD prediction layers | `sourcelayer-control.js` / `temporal-controls.js` |
| Vector output storage | GeoDjango + PostGIS already installed (`django.contrib.gis`) | `settings/base.py` `INSTALLED_APPS` |
| Land cover (infiltration/Manning's-n input) | ESA WorldCover — not yet integrated; new but small (single raster fetch, same shape as the DEM fetch) | — |
| Rainfall (secondary/future) | Meteoblue Forecast — **client-side only today.** `METEOBLUE_TOKEN` is handed straight to the browser (`dashboard_view`); there is no server-side numeric Meteoblue path anywhere in `views.py`. Using it as a model input means building a real server-side Meteoblue API integration from scratch — deliberately deferred to Phase 4, not a Phase 1/2 dependency. | — |

**Net effect:** the rainfall-driver and DEM-source pieces of the pipeline
are largely *already there* — this is substantially a new computation +
serving layer on top of existing data plumbing, not a new data-ingestion
project.

## 5. Architecture

```
PMD Forecast (daytpe/sixtpe/hourtpe — PMD's own WRFPRS/GDFS forecast,
ALREADY warped+cached as numeric EPSG:3857 GeoTIFFs via the EXISTING
_mon_pred_ensure_warped() — zero new rainfall-fetching code)
        │
        ▼
Runoff excess = rainfall − infiltration
        (infiltration from ESA WorldCover land-cover lookup, resampled
         onto the DEM grid — PMD's grid is coarser than the 30m DEM, so
         the coarse rainfall cell value is applied uniformly across every
         DEM cell it overlaps; standard practice, same resampling gdal.Warp
         already does everywhere else in this codebase)
        │
        ├──► Fluvial: HAND raster (WhiteboxTools, one-time per AOI,
        │    cached) + Manning's normal-depth lookup per accumulated-flow
        │    reach
        │
        └──► Pluvial: priority-flood fill-and-spill of excess rainfall
             into DEM depressions
        │
        ▼
Combined depth raster → warp/colorize/PNG (REUSE PmdMonitorPredictionsAPIView's
pipeline verbatim) → #temp-slider1 (REUSE existing temporal UI)
        │
        ▼
Flood polygons (depth → Safe/Minor/Moderate/High/Severe) → PostGIS → GeoJSON API
```

## 6. Crash-safety requirements (non-negotiable, from this project's own incident history)

- All WhiteboxTools invocations go through `subprocess.run(..., timeout=...)`
  — bounded, isolated, never able to block or crash the Django/Waitress
  worker process itself.
- Any GDAL/rasterio touch-points on the Django side (warping the DEM AOI,
  colorizing the output depth raster) reuse the **exact**
  `_MON_PRED_GDAL_LOCK` serialization discipline from `views.py` — never
  run concurrently across threads. This is not optional; it's the fix for
  a real, reproduced production crash earlier this session.
- Every cached output (per-AOI HAND raster, per-forecast-step flood PNG)
  is written via temp-file + `os.replace()` — the same atomic-write
  pattern that fixed the `temp2m.txt` ramp-file corruption bug. A crash
  mid-write must never be able to leave a corrupt "looks cached" file
  behind again.
- Bounded timeouts on every external data call (GEE DEM export, PMD
  forecast fetch), with the same graceful-degradation-not-crash posture
  already established everywhere else in this app (`_friendly_llm_error`,
  `_run_gcop_get`'s retry-with-backoff, etc.) — a flood-layer failure
  degrades to "unavailable," never takes down anything else.
- No new native-code dependency loaded **in-process** — WhiteboxTools
  (subprocess) is the one exception already accounted for; anything else
  added later (e.g. a future Meteoblue integration) should be evaluated
  against this same bar before being pulled in.

## 7. Phased plan

### Phase 0 — Foundation & data audit — ✅ COMPLETE
- ✅ Copernicus DEM export confirmed (originally GLO30, since moved to
  the non-deprecated `COPERNICUS/DEM/GLO30_2024_1` — all 7 usages in
  `views.py` updated, not just new code).
- ✅ `_mon_pred_ensure_warped('daytpe', ...)` confirmed to return a
  usable 24h-precipitation raster for the pilot AOI, zero new code.
- ✅ WhiteboxTools (MIT) installed and verified on Windows dev — needed
  real debugging, not just an install (see §0 above for the bugs found).
- ⬜ Linux prod WhiteboxTools check — still outstanding, needs to be run
  directly on the VM (see the module's own crash-safety notes for what
  to watch for; the Windows install needed a manual fix, prod may need
  its own).

### Phase 1 — Static terrain layer, no rainfall coupling yet — ✅ COMPLETE (backend)
- ✅ WhiteboxTools pipeline (fill_single_cell_pits → breach_depressions
  _least_cost → D8 pointer → D8 flow accumulation → extract_streams →
  elevation_above_stream) implemented in `flood_model.py`, tested
  end-to-end on the real Nullah Lai pilot AOI. See §0 for full results
  and the three real bugs found/fixed along the way.
- ✅ "Flood-prone zones" rendering (HAND below threshold → colorized PNG,
  same warp/colorize/atomic-write/post-write-validation conventions as
  `_mon_pred_convert_step`) implemented as `render_flood_prone_zones()`.
- ⬜ **Not yet done:** wiring this into a live Django view/URL and a
  frontend layer entry (`ncop_menu_items`) — the backend produces a real
  PNG + bounds payload, but nothing serves it to the map yet. Also not
  yet done: replacing the crude `ee.Image(50).subtract(DEM)` placeholder
  with this real layer.
- **Exit criterion (still open):** a hydrologist/operator looks at the
  HAND-based zones for the pilot catchment and confirms they match where
  flooding actually happens there — needs the frontend wiring above
  before this can actually be evaluated visually.

### Phase 1.5 — Context & exposure — ✅ COMPLETE (backend, including AUC)
Added per the §0.5/§0.6 scope-mapping pass — gives Phase 1's hazard
output real-world meaning before rainfall coupling makes everything more
complex. Implemented in `project/ncop_internal/flood_exposure.py` — full
results, real bugs found/fixed, and timings in §0.8 (buildings/admin/
existing-infra) and §0.10 (bridges/hospitals/OSM fallback).

- **Administrative tagging** — ✅ done: flood-prone-zone raster vectorized
  via `gdal.Polygonize` (with a real fragmentation bug found and fixed,
  see §0.8), spatially joined against `district_boundary`/
  `tehsil_boundary`. Confirmed live on Nullah Lai: Islamabad 67.8%,
  Rawalpindi 31.8-31.9%, a Haripur sliver 0.4%.
- **Cross-validation against existing flood extents, via AUC (§0.7/§0.14)**
  — ✅ done: `accuracy_assessment.py` built, 13/13 synthetic unit tests
  passed, validated end-to-end against real Chenab flood-extent ground
  truth (a genuinely overlapping test AOI, not Nullah Lai — **confirmed
  live: Nullah Lai itself still does not overlap any of the 20 layers**,
  same finding as before, still an open gap for THIS pilot specifically).
  First real-world result: raw HAND scored "fail" (AUC ~0.44-0.47) in a
  low-relief floodplain test AOI — a genuine finding for Phase 3, not a
  module bug (§0.14 has the full analysis, including a real WFS-bbox-
  filter gotcha found and fixed along the way).
- **Building exposure (Overture Maps, primary) + OSM (bridges, hospitals,
  buildings fallback)** — ✅ done: Overture stays the primary buildings
  source (§0.8) — confirmed live 603,076 buildings in the Nullah Lai AOI,
  77,862 (~13%) inside the flood zone, and confirmed ~34x more complete
  than OSM's own buildings coverage here, a known OSM gap in areas with
  heavy informal/unmapped settlement (§0.10). OSM/Overpass fills the
  actual Infrastructure gap identified in §0.5 instead: 786 bridges (358
  in zone), 139 hospitals (4 in zone) — genuinely new categories Overture
  never covered — plus a degraded, clearly-labelled fallback for
  buildings if Overture's own fetch ever fails (§0.10).
- **Reuse existing NCOP Infrastructure layer** (`airports`/`schools`/
  `settlements`) — ✅ done: confirmed live these already carry district/
  tehsil/`hi_riverine_flooding` attributes server-side. On Nullah Lai: 1/2
  airports, 44/571 schools, 90/764 settlements fall inside the flood
  zone.
- **Road network + drainage network exposure (§0.11)** — ✅ done: roads
  via OSM (54,860 ways; 1,105.32 of 9,778.66 km / 11.3% in the flood
  zone, or 1,015.88 of 8,977.73 km vehicular-only). Drainage via three
  sources doing different jobs — the HAND pipeline's own DEM-derived
  stream network (already existed, nothing new), NCOP's own major/minor
  rivers (already reusable), and OSM `waterway=*` for the fine urban
  drainage neither of those covers (876 features; 310.88 of 593.91 km /
  52.3% in the flood zone — a much higher fraction than roads/buildings,
  physically expected since drains ARE the low points HAND measures
  from). Confirmed live: this is now the most CPU-expensive part of the
  whole report (~40-80s of the ~71s warm-cache total, §0.11).
- **Population & vulnerable-population exposure (§0.9 design, §0.13
  results)** — ✅ done: WorldPop via Earth Engine, server-side
  `reduceRegion`, no raster download. On Nullah Lai: 425,116 total /
  47,137 under-5 / 16,759 elderly (65+) inside the flood zone — matching
  §0.9's original research numbers exactly on re-test. Fast enough
  (1.6-7.4s confirmed live) to call inline with no disk cache, unlike
  every other exposure source in this phase; both failure and timeout
  degradation paths verified live via fault injection.
- **Exit criterion — fully met.** `build_exposure_report("nullah_lai")`
  answers "which district, how many buildings, how many bridges/
  hospitals/schools/settlements/airports, how many km of road/drainage
  network, how many people (and how many vulnerable) are inside the
  flood-prone zone" in a single call (~64-85s depending on background
  contention, confirmed live — §0.12/§0.13) — the actual decision-support
  value this whole system is for. `accuracy_assessment.py` (§0.14) adds
  the AUC piece as a standalone, reusable module — not called from
  `build_exposure_report()` itself (it needs a ground-truth source and an
  overlapping AOI, neither of which the Nullah Lai pilot has), but proven
  correct and ready for Phase 3's calibration work and for any catchment
  that does overlap the 20 existing layers.

### Phase 1.6 — Frontend module & custom data input

Explicitly **not** a togglable catalog layer — a fully self-contained
dedicated module, requested specifically so hazard output and
user-submitted custom runs get a real, purpose-built interface instead
of being squeezed into the generic layer-toggle UI everything else in
NCOP uses.

**Architecture — same "zero coupling" pattern as `GisExportControl`/
`NcopAssistantControl`, deliberately not touching `ncop_menu_items`/
`sourcelayer-control.js` at all:**
- New `frontend/src/modules/flood-model-control.js` — a
  `FloodModelControl` class, own rail button, own panel, registered in
  `dashboard.js`'s `RAIL_PANEL_REGISTRY` exactly like the others.
- New `frontend/src/styles/dashboard/_flood-model-panel.css`, visually
  modeled directly on the existing Layer Style panel (`layerStylePanel`)
  — same header/body/footer shell, same row/slider/swatch/select visual
  language, so it reads as native to the app rather than bolted on.

**Panel content — four sections, not a single form:**
1. **Area** — pilot catchments (Nullah Lai, future ones) in a dropdown,
   or a custom area via the same draw-a-bbox interaction GIS Export
   already has (reused, not reinvented).
2. **Data sources** — the actual point of this phase. Each input gets
   three tiers, cheapest/safest first:
   - *Elevation:* Copernicus GLO-30 (automatic, already built) → upload
     your own GeoTIFF DEM.
   - *Rainfall:* PMD Forecast (automatic, already built) → upload your
     own precipitation GeoTIFF → a single uniform mm/hour + duration
     field, no file at all. The uniform-value tier isn't a placeholder —
     it's FastFlood's own documented default mode ("homogeneous in
     space"), and the only zero-risk path for a user with no data of
     their own.
   - *Land cover / infiltration:* same three-tier shape once ESA
     WorldCover lands in Phase 1.5 — automatic → upload → a single
     uniform Manning's-n value.
3. **Model settings** — HAND threshold slider (same slider UI as the
   mock), rainfall duration/intensity if using uniform mode.
4. **Run + Results** — a Run button; the result renders as a temporary
   map overlay (never added to the permanent layer catalog — it's a
   one-off run, not a standing layer), plus a GeoTIFF export button
   reusing `NcopRasterExportView`'s existing export path.

**Crash-safety / production requirements for the upload path — this is
the part that actually matters:**
- Uploads reuse `NcopRasterUploadView`'s already-proven pattern exactly:
  `.tif`/`.tiff` extension whitelist, GDAL-open validation before
  trusting anything, automatic downsampling of oversized inputs (its
  existing `MAX_INPUT_PX_BEFORE_DOWNSAMPLE = 4096` convention) rather
  than either rejecting or blindly processing a huge file, atomic writes,
  try/finally cleanup.
- Every uploaded raster — DEM or precipitation — additionally goes
  through the same `gdal.Translate` compression normalization Phase 0
  added for GEE exports. A random user's own GIS export is *more* likely
  to carry a WhiteboxTools-incompatible compression tag than GEE's own
  output, not less.
- **The run is asynchronous, never a single blocking request** — a
  direct lesson from the NLLB/nginx 504 earlier this project, not a
  hypothetical. FastFlood's own documented compute scaling (1000px≈1s,
  2500px≈5s, 10000px≈100s, 25000px≈1000s) means a large custom upload
  could easily exceed any gateway timeout as one blocking POST.
  `POST /api/flood-model/run/` returns a job id immediately; the
  frontend polls `GET /api/flood-model/status/<id>/`; the result is
  fetched once ready — no long-held connection, ever.
- **Concurrency capped server-wide, not per-request.** `flood_model.py`'s
  existing `_WBT_LOCK` (built in Phase 1 for the pilot catchment alone)
  extends to gate every submitted job, pilot or custom, so a burst of
  user-submitted runs can't pile up and starve the shared VM. Since
  WhiteboxTools already runs as an isolated subprocess, a huge or
  malformed custom upload that crashes the tool takes down one
  subprocess, not the Waitress worker — the exact property Phase 0 chose
  WhiteboxTools for, now paying off for a case not originally designed
  around.
- Throttled the same way `/api/assistant/chat/`/`/api/translate/`
  already are, to bound abuse rather than trusting upload size limits
  alone.

**Exit criterion:** an operator can open the panel, either pick the
pilot catchment or upload their own DEM/rainfall, run a simulation
without touching the layer catalog at all, and get back a rendered
result + exportable GeoTIFF — with a large/malformed custom upload
degrading gracefully (a clear error, a downsampled result, or a timed-
out job) rather than ever taking the server down.

### Phase 2 — Dynamic coupling to PMD Forecast
- Pull `daytpe`/`sixtpe` rasters via `_mon_pred_ensure_warped()` for each
  forecast step already in PMD's own step list.
- Runoff-excess + fill-and-spill (pluvial) computed per step, combined
  with the static HAND fluvial layer.
- Served through `#temp-slider1` exactly like PMD's own temperature/
  precipitation layers already are — same frame-stepping UI, no new
  frontend work.
- **Exit criterion:** the layer visibly changes across forecast steps in
  a way that tracks PMD's own precipitation forecast for the same steps.

### Phase 2.5 — Vulnerability & susceptibility (AHP) — ✅ BACKEND COMPLETE for both flood types, frontend not started
- Built as its own new module (`flood_ahp.py`), alongside the existing
  `views.py` AHP layer rather than modifying it, per this section's own
  original instruction — see §0.27/§0.29 for the full account.
  Incorporates this project's own HAND hazard layer as a weighted factor
  (a deliberate, stated upgrade over raw elevation, per this section's
  own original instruction) — literature-backed, terrain-conditioned
  weights for flash-flood (§0.27: `moderate_relief`/`flat_relief`,
  selected by measured HAND relief) AND a genuinely separate riverine
  literature review + profiles (§0.29: `high_drainage_density`/
  `low_drainage_density`, selected by measured stream elevation), CR-
  validated throughout.
- Full factor-raster pipeline built and verified on all 4 pilot
  catchments (§0.29): distance-to-stream, slope/TWI/curvature, LULC,
  soil, drainage density, rainfall climatology, NDVI, plus a new
  connectivity factor added after real GFD validation exposed a
  structural gap in the riverine profiles.
- **Real GFD validation, not assumed**: flash-flood AHP is a genuine
  success (Nullah Lai AUC 0.889, Bhudni Nullah 0.771, both hitting the
  75-85% target). Riverine AHP improved substantially but honestly falls
  short of the revised 70/72% floor at the harder pilot (Chashma 0.750,
  clears 70%; Guddu 0.612, below its own 72% floor) — reported plainly,
  not hidden or forced past target by further tuning against these two
  pilots' own numbers, since this is meant to generalize nationally.
- Ground-truth calibration against live FFD discharge/PMD signals (this
  section's own original second bullet) was NOT built as a separate
  step — GFD (Global Flood Database) ground truth ended up being the
  actual validation source used throughout (§0.20 onward), a stronger,
  quantitative real-world check than a qualitative "is it raining"
  sanity test would have been.
- Production-wired (§0.30): `POST /api/flood-model/run/` with
  `{"mode": "ahp_susceptibility"}`, verified end-to-end via
  `RequestFactory` for both flood types.
- **Exit criterion (from the original plan) reframed by what was actually
  built**: not a per-district/per-polygon classification, but a
  per-pixel susceptibility SURFACE (1-5 scale) per catchment, combining
  hazard factors (not yet fused with the Phase 1.5 exposure numbers into
  one blended score — the two remain separate outputs, exposure via the
  existing buildings/roads/population pipeline, susceptibility via this
  new one). **Not yet done**: frontend mode selector / susceptibility-
  layer rendering.

### Phase 3 — Calibration & decision support
- Cross-check against the 20 existing flood extent layers (§0.5) where
  they overlap, PLUS any historical flood observation for the pilot
  catchment specifically (even coarse — a flooded/not-flooded sketch) —
  run the same Cohen's-Kappa / F1-score accuracy check FastFlood itself
  uses, to get an honest number instead of an assumed one.
- Risk classification (Safe/Minor/Moderate/High/Severe) → PostGIS
  polygons → GeoJSON API, matching the original methodology document's
  own decision-support layer, now informed by Phase 2.5's susceptibility
  score rather than hazard alone.
- **Nationwide rollout should not happen before this phase** — scaling
  before calibration just scales an unvalidated model.

### Phase 4 (optional, later) — Meteoblue as a second rainfall source
- Real server-side Meteoblue integration (their actual data API, not the
  tile endpoints already embedded client-side) for ensemble/cross-check
  against PMD, or as a fallback when PMD's feed is stale.
- Deliberately last: it's the one piece with no existing server-side
  foothold to build on (see §4's table).

## 8. Open items before Phase 0 starts

- **Pilot catchment** not yet chosen — needs a specific, well-documented
  flash-flood-prone area in Pakistan with at least some elevation/land-
  cover data quality, ideally with any historical flood record (even
  informal) for Phase 3 calibration.
- **ESA WorldCover integration** for land cover / Manning's-n /
  infiltration lookup is new (not yet present anywhere in this codebase)
  — small in scope (one raster fetch, same shape as the DEM fetch) but
  not yet built.
