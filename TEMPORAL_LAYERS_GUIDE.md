# NCOP Temporal Layer System

> Companion doc to CONTEXT.md, ingested by the NCOP Assistant's knowledge base
> the same way — written after reading `frontend/src/modules/time-functions.js`,
> `temporal-controls.js`, and `temporal-layer-legends.js` directly. Covers how
> TEMPORAL layers (itemType: "temporal" in the sidebar layer catalog — weather
> forecasts, satellite imagery, PMD predictions, RainViewer, etc.) are
> fundamentally different to activate than TOGGLE layers, which matters for
> anyone (human or the NCOP Assistant) trying to explain or drive layer
> activation correctly.

## 1. Single selection, not independent on/off

A TOGGLE layer (checkbox, or a raster multi-select row) turns on/off
independently of every other layer — any number can be active at once.

A TEMPORAL layer is different: only **one temporal layer can be active across
the whole app at a time**. Clicking a temporal item in the sidebar
(`.ncop-item-temporal`) automatically deselects whichever OTHER temporal item
was previously active (`temporal-controls.js`'s click handler explicitly clears
`.is-selected` off every other `.ncop-item-temporal` first) before selecting
the new one. Clicking the currently-active temporal item again turns it off
entirely (no temporal layer active). This is why switching from, say, "Weekly
Precipitation" to "DWD Satellite Infrared" doesn't require turning the first
one off manually — selecting the second does that automatically.

## 2. What activating a temporal layer actually builds

Selecting a temporal item calls `handleTemporalInteraction()`
(`mapbox-functions.js`), which resolves that layer's **frame list** — an
array of `{date, source(s), layers, images?}` entries, one per time-step,
built by a dedicated generator function per dataset in `time-functions.js`
(e.g. `generateMeteoblueNEMSCloudPrecipLayers`, `generateDWDSatelliteLayers`,
`generatePmdPredictionsLoader`, `generateRainViewerRadarLayers` — each
temporal layer in the sidebar catalog maps to exactly one such generator via
its `window[itemKey]` global). That frame list is handed to
`updateTempSlider()` (or its async counterpart `updateTempSliderAsync()`, for
generators whose frame list resolves from a live API call rather than being
built synchronously) in `temporal-controls.js`, which then:

- Adds each frame's Mapbox sources/layers to the map (only the FIRST frame
  starts visible — every other frame's opacity starts at 0), respecting the
  NCOP z-order rule (temporal layers always sit below normal vector layers,
  above the basemap).
- Shows and populates the **`#temp-slider1` timeline panel** — a draggable/
  resizable floating control with:
  - Play/pause (steps through frames automatically, speed cycles
    0.5x → 1x → 2x → 3x via the speed button).
  - A manual step slider plus a row of clickable date-tick labels along the
    bottom, auto-sized so labels never overlap regardless of frame count.
  - An opacity popover — a single 0-100% factor applied globally to
    whichever temporal layer is currently active (not per-frame).
  - A remove/trash button that mimics re-clicking the active sidebar item,
    unwinding through the exact same deactivation path a real click would.
- Looks up and shows that layer's **legend**, if one exists — a color-ramp
  gradient bar with tick values, keyed by the layer's own `itemKey` in
  `temporal-layer-legends.js`'s `legends` object (e.g. `legends.dwd_satellite_infrared`,
  `legends.weekly_precipitation_2m_above_ground`). Not every temporal layer
  has one; the legend panel just stays hidden if its key isn't present.

## 3. Why this means "just add the layer to the map" is wrong for temporal items

Directly adding a temporal layer's Mapbox sources/layers to the map (the way
a TOGGLE layer's activation works) would show the raster/vector data but skip
building `#temp-slider1` entirely — no play/pause, no step scrubbing, no
legend, and the sidebar item itself would never show as selected (its own
`.is-selected` class and single-selection bookkeeping live inside the SAME
click handler that builds the slider). The only correct way to activate a
temporal layer programmatically is to trigger that real click handler — e.g.
by dispatching a click on the sidebar row itself — never by calling a lower-
level "just add this layer" helper directly.

## 4. `getCurrentTemporalState()`

`temporal-controls.js` exposes `window.getCurrentTemporalState()`, a
read-only snapshot of whichever temporal layer is currently active: its
`layerKey`, the full `layersDef` frame array, the `currentIndex` (which frame
the slider is on), and that frame's own `date`. Several other NCOP features
(Weather Report, GIS Export, Story Mode) read this rather than re-deriving
temporal state themselves, since it's always in sync with what's actually on
the map and in the slider.
