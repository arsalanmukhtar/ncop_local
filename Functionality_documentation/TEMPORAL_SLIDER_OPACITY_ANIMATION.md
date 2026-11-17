# The temporal (time-slider) widget: why it animates by opacity, not visibility

Scope note: this is a narrow, mechanism-focused document about **one thing** —
how `#temp-slider1` (`frontend/src/modules/temporal-controls.js`) plays through
its timesteps by toggling `raster-opacity`/`fill-opacity`/etc. rather than
Mapbox GL's `visibility` layout property. It does not touch the landslide
susceptibility work, which remains the main thread of this project.

All line numbers below are `frontend/src/modules/temporal-controls.js`, read
directly from the file — not inferred.

---

## 1. The one-sentence version

**Every timestep's layer is added to the map once, up front, as
`visibility: "visible"`, and stays that way for the whole session; "playing"
the slider is nothing but flipping one paint property — `*-opacity` — between
`0` (previous frame) and `0.75` (current frame) on a `setInterval` tick.**
Nothing is ever added, removed, shown, or hidden at the layout level during
playback.

## 2. Two phases: build once, then only repaint

### Phase A — build (`updateTempSlider`, L685–878; rebuilt on style reload by `_rebuildLayersFromDef`, L603–672)

When a temporal item is selected in the sidebar, `updateTempSlider(layers, …)`
receives the **full array of every timestep** for that variable (one entry per
date/frame) and loops over **all of them**, not just the first:

```js
// L737-795 (build loop) — runs once, for every entry in `layers`
layers.forEach((entry, index) => {
  const group = [];
  // ...add each entry's own source(s) if not already present...
  entry.layers.forEach((layerDef) => {
    group.push(layerDef.id);
    const opacityProp = getOpacityProperty(layerDef.id) || /* raster-opacity / fill-opacity / ... */;

    let initialOpacity = 0;
    if (index === 0) {                      // ONLY frame 0 starts visible
      initialOpacity = layerDef.paint?.[opacityProp] ?? 0.75;
    }

    if (!map.getLayer(layerDef.id)) {
      const cfg = {
        ...layerDef,
        layout: { ...layerDef.layout, visibility: "visible" },   // <-- ALWAYS visible
        paint: { ...layerDef.paint, [opacityProp]: initialOpacity },
      };
      _ncopAddLayerInOrder(map, cfg);        // map.addLayer(), once
      if (initialOpacity > 0) setLayerOpacity(layerDef.id, initialOpacity);
    } else {
      map.setLayoutProperty(layerDef.id, "visibility", "visible");
      setLayerOpacity(layerDef.id, initialOpacity);
    }
  });
  sliderLayers.push(group);                  // sliderLayers[index] = [layerId, ...]
});
```

Result: `sliderLayers` (module-level, L14) is an array of arrays — one entry
per timestep, each holding the Mapbox layer id(s) for that frame. **Every one
of those layers already exists on the map** by the time the build loop
finishes, with `layout.visibility` fixed at `"visible"` forever. Only frame
`0`'s opacity is non-zero; every other frame's paint opacity starts at `0`.
`map.once("idle", () => showTimeStepLayers(0))` (L848) then does the real
first paint once the style has settled.

### Phase B — play (`showTimeStepLayers`, L575–592; driven by `playAnimation`, L894–903)

Stepping the slider — by the play loop, the range `<input>`, or clicking a
date label — never touches layout. It calls one function:

```js
// L575-592
function showTimeStepLayers(stepIndex) {
  if (_lastStepIndex === null || !sliderLayers[_lastStepIndex]) {
    hideAllSliderLayers();                                   // first call only
  } else if (_lastStepIndex !== stepIndex) {
    sliderLayers[_lastStepIndex].forEach((id) => {
      if (map.getLayer(id)) setLayerOpacity(id, 0);           // fade OUT old frame
    });
  }
  if (sliderLayers[stepIndex]) {
    sliderLayers[stepIndex].forEach((id) => {
      if (map.getLayer(id)) setLayerOpacity(id, 0.75);        // fade IN new frame
    });
  }
  _lastStepIndex = stepIndex;
  updateActiveYearLabel(stepIndex);                           // just a CSS class toggle on the date pill
}
```

This is a **two-way toggle**, not a loop over every frame: it only ever touches
the *previous* active frame's layers (→ opacity 0) and the *new* active frame's
layers (→ opacity 0.75). With `N` timesteps loaded, stepping from frame 3 to
frame 4 is exactly 2 layers worth of `setPaintProperty` calls, not `N`.

The play button just calls `showTimeStepLayers` on a timer:

```js
// L894-903
function playAnimation() {
  interval = setInterval(() => {
    const nextVal = currentVal < maxVal ? currentVal + 1 : 0;   // wraps to 0 at the end
    slider.value = nextVal;
    _sliderRestore.currentIndex = nextVal;
    showTimeStepLayers(nextVal);
  }, 1000 / speedLevels[currentSpeedIndex]);   // speedLevels = [0.5, 1, 2, 3] (frames/sec)
}
```

`speedControlButton` cycles `currentSpeedIndex` through `speedLevels`
(0.5×/1×/2×/3×) and, if already playing, restarts the interval at the new tick
rate (L940–949). The interval is cleared on pause, on speed change, and on
`updateTempSlider` re-entry (L704), so there is never more than one timer
running.

## 3. Why opacity and not `visibility`

This isn't spelled out in a code comment, but it's the direct, necessary
consequence of the architecture above, and it's the standard reason this
pattern exists in Mapbox GL applications generally:

| | `setPaintProperty(id, "*-opacity", v)` | `setLayoutProperty(id, "visibility", v)` |
|---|---|---|
| What it triggers | A cheap GPU re-paint of an already-compiled layer | A layout re-evaluation: the layer re-enters Mapbox's placement/collision pass, and going `none → visible` can re-trigger tile requests for anything not already cached |
| Cost at animation speed (every 330 ms–2 s, per `speedLevels`) | Trivial — this is exactly what the property is for | Visibly more expensive; doing it every animation tick is the textbook way to make a Mapbox time-slider stutter |
| Interaction with symbol layers | Independent of collision/placement | Toggling visibility re-runs symbol placement, which can cause labels to jump/flicker |
| Source/tile lifecycle | Untouched — the source stays "hot" | `none` doesn't necessarily evict tiles, but re-showing after `none` isn't guaranteed as cheap as a paint-only change |

Because **every** frame's layer is added once at build time (Phase A) with
`visibility: "visible"` fixed, playback (Phase B) never has to pay the
layout-evaluation cost at all — it only ever pays the cheap paint cost, once
per frame transition, exactly twice per tick (old frame → 0, new frame →
0.75). This is *why* the build phase front-loads every timestep's layer
instead of lazily adding/removing a single layer and re-pointing its source
per frame: pre-adding trades a larger one-time setup cost (and more layers
resident on the map) for a playback loop that is cheap and jitter-free at
every speed the UI offers, including 3×.

## 4. The other moving parts that make this actually correct

- **Opacity property is type-aware, not hardcoded.** `getOpacityProperty(id)`
  (L402–413) maps the Mapbox layer type to the right paint property —
  `raster-opacity` / `fill-opacity` / `line-opacity` / `circle-opacity` /
  `icon-opacity` — and caches the answer per layer id (`_opacityPropCache`,
  L24) so this lookup isn't repeated every animation tick.
- **Symbol layers get a second property.** `setLayerOpacity` (L415–432) also
  sets `text-opacity` alongside `icon-opacity` for symbol layers (L427–431) —
  otherwise labels would stay fully opaque while their icons faded.
- **No-op writes are skipped.** `_layerOpacityState` (L25) remembers the last
  value written per layer; `setLayerOpacity` bails out before calling
  `setPaintProperty` at all if the new value rounds to the same number
  (L423–424) — real, measured GPU-call avoidance, not just a style nicety.
- **A global opacity factor multiplies every frame's opacity, live.** The
  "blend" button opens `#opacityControlPopover`; its range input
  (`#opacityRange`) sets module-level `_opacityFactor` (L1020–1030), and
  `setLayerOpacity`'s actual write is `value * _opacityFactor` (L420–421), not
  the raw per-frame `0.75`. Moving the slider calls `_applyGlobalOpacityNow()`
  (L595–600), which just re-runs `showTimeStepLayers(_lastStepIndex)` — the
  *same* two-way-toggle function playback uses, so scrubbing the opacity
  popover while paused re-applies the factor to the current frame without any
  extra code path. `window.setTemporalOpacity(pct)` (L1039–1045) exposes the
  same control from the console.
- **First paint is deferred to `map.once("idle", …)`** (L848) rather than
  called synchronously right after the build loop — avoids painting frame 0
  before the style has actually settled from adding N layers/sources at once.
- **Style reloads are handled by rebuilding, not by replaying history.**
  `map.on("style.load", …)` (L859–877) re-runs the exact same "add every
  timestep once, visibility:visible, only current frame opacity>0" logic via
  `_rebuildLayersFromDef` (L603–672), restoring to whatever `_sliderRestore
  .currentIndex` was at the moment the style reloaded — not to frame 0.
- **Scrubbing via the range input uses the identical function as playback.**
  The `<input id="slider1">`'s `"input"` handler (L932–939) calls
  `showTimeStepLayers(val)` directly — manual dragging and automatic play are
  the same code path, so there's no separate "seek" implementation to keep in
  sync.
- **Removing the layer set tears down cleanly, and only then.**
  `hideAllSliderLayers()` (L453–458) zeroes every layer's opacity;
  `cleanupSliderLayers()` (L520–572) is the one place that actually calls
  `map.removeLayer`/`removeSource` and clears every per-id cache — this only
  runs when the temporal item is deselected or swapped for a different one
  (L707–728), never as part of normal stepping/playback.

## 5. What this trades away (briefly, not a redesign proposal)

- **Memory/GPU-resident cost scales with timestep count.** Every frame's
  layer (and its source, if per-frame) lives on the map simultaneously for
  the whole session, not just the visible one. For a dataset with very many
  timesteps this is a real, deliberate trade against the alternative (fewer
  resident layers, more per-tick layout churn) — the code has clearly chosen
  the smoother-playback side of that trade.
- **A raw `0.75` is a hardcoded default**, not derived from the dataset —
  used whenever a frame's own `layerDef.paint[opacityProp]` isn't already set
  (L644–645, L769–771). The multiplicative `_opacityFactor` popover is the
  intended way to adjust it after the fact, globally, live.

## 6. Quick reference

| Symbol | Role |
|---|---|
| `sliderLayers: Array<Array<layerId>>` | One entry per timestep; the whole list of layer ids that phase A pre-adds |
| `_lastStepIndex` | The one frame currently at opacity 0.75; drives the two-way toggle in `showTimeStepLayers` |
| `showTimeStepLayers(i)` | The single function both playback and manual scrubbing call — old frame → 0, new frame → 0.75 |
| `setLayerOpacity(id, v)` | Type-aware, factor-multiplied, no-op-skipping paint-property write |
| `getOpacityProperty(id)` | Maps Mapbox layer type → the correct `*-opacity` paint property, cached |
| `_opacityFactor` | Global multiplier (0–1) from the opacity popover, applied on top of every per-frame value |
| `playAnimation()` / `interval` | `setInterval` driving `showTimeStepLayers` at `1000 / speedLevels[currentSpeedIndex]` ms |
| `speedLevels = [0.5, 1, 2, 3]` | Playback speed options (frames/sec), cycled by `#speedControlButton` |
| `_rebuildLayersFromDef` | Re-runs Phase A after a `style.load`, restoring the frame that was active before the reload |
