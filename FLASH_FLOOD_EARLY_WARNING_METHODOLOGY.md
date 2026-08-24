# Lightweight Flash-Flood Early Warning & Modeling — NCOP Methodology

Status: **Phase 0, Phase 1 (hazard-only backend), Phase 1.5 (full
exposure stack — admin/buildings/OSM/roads/drainage/population), AUC
(§0.7/§0.14), and Phase 1.6 (backend endpoints §0.15 + frontend panel
§0.16) are all implemented and NOW browser-tested (§0.17)** — closing
§0.16's own "verification gap." That first real browser pass found and
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

**⏸ Work stopped here, at the end of §0.17.** The pilot catchment's bbox
is now literature-corrected and cross-validated; the frontend panel is
real-browser-tested with a working progress checklist and catchment
marker; the HAND threshold and the "no accuracy report / no AHP" status
are both stated honestly in the UI itself, not just in code comments.
**The custom-AOI/upload path remains the one unbuilt piece of the
original Phase 1.6 scope** (needs a `flood_model.py` core-logic change —
accepting a user-drawn bbox or an uploaded DEM instead of only the
hardcoded pilot catchment — deliberately kept out of every pass so far).
Also open, not yet acted on: sourcing real ground truth for Nullah Lai
specifically (still the one catchment with no AUC coverage), and Phase
2's rainfall-scenario coupling, which is what the HAND threshold
research in §0.17 shows is actually needed for a genuinely calibrated
(not just literature-informed) flood-prone cutoff. This document is
the durable record of the architecture
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

### Phase 2.5 — Vulnerability & susceptibility (AHP)
- Extend the existing AHP Flood Susceptibility methodology already in
  `views.py` (elevation/slope/rainfall/proximity-to-water/soil-moisture
  weights) to incorporate this project's own HAND hazard layer and the
  Phase 1.5 exposure data as additional weighted factors, rather than
  building a parallel, disconnected susceptibility score.
- Ground the susceptibility weighting against live signals where
  possible: PMD weather stations / NWFC observations (is it actually
  raining near the catchment right now) and FFD historic discharge
  (`FfdHistoryAPIView`) as a real, if partial, calibration input —
  distinct from Phase 3's dedicated accuracy validation, more like a
  sanity check that the weights aren't obviously wrong.
- **Exit criterion:** a single susceptibility score/classification per
  district or per flood-prone-zone polygon, blending hazard + exposure +
  the existing AHP factors — not just the raw HAND threshold from Phase 1.

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
