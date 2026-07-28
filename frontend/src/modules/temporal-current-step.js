// ==========================================================================
// temporal-current-step.js
// --------------------------------------------------------------------------
// Injects a dynamic "current timestep" line into the temporal slider's
// .ts-variable panel (the box that already shows the layer's title) and
// keeps it in sync with the slider position — text updates live as the
// user scrubs the range, plays the animation, or a new layer loads.
//
// Universal — works for any temporal layer that goes through the shared
// #temp-slider1 controller, not just PMD Predictions.  Reads each frame's
// `.dateFull` (always populated) with a fallback to `.date` (may be empty
// on thinned-label layers).  For layers whose frames have neither, the
// line stays hidden so the panel visual is unchanged.
//
// Split-compare Map B has its own step accessor (this.#state.layerBIndex
// + layerBSteps) inside split-compare-control.js — that side hooks in
// directly from #stepLayerBTo, not via this file, because the state lives
// on a private class field rather than the module-level _sliderRestore
// that getCurrentTemporalState() exposes.
// ==========================================================================

const SLIDER1_ID    = "slider1";
const VARIABLE_SEL1 = "#temp-slider1 .ts-variable";
const DATE_CLASS    = "ts-current-date";

let _wired = false;

function _pickDateFromEntry(entry) {
  if (!entry) return "";
  return String(entry.dateFull || entry.date || "");
}

function _ensureDateEl() {
  const panel = document.querySelector(VARIABLE_SEL1);
  if (!panel) return null;
  let el = panel.querySelector(`.${DATE_CLASS}`);
  if (!el) {
    el = document.createElement("p");
    el.className = DATE_CLASS;
    // Belongs after the existing title <p>.  Uses appendChild rather
    // than a fixed sibling insertion so any future restructure of
    // .ts-variable's children keeps working.
    panel.appendChild(el);
  }
  return el;
}

function _refresh() {
  const dateEl = _ensureDateEl();
  if (!dateEl) return;
  const slider = document.getElementById(SLIDER1_ID);
  if (!slider) { dateEl.textContent = ""; return; }

  // Prefer the state store — layersDef holds the frames array for the
  // active layer.  Fall back to reading the slider value directly for
  // the pre-state-set edge cases (first-load race).
  const state  = typeof window.getCurrentTemporalState === "function"
                 ? window.getCurrentTemporalState()
                 : null;
  const idx    = Number(slider.value) || 0;
  const frames = state?.layersDef;
  const entry  = Array.isArray(frames) ? frames[idx] : null;
  const text   = _pickDateFromEntry(entry);
  if (text) {
    dateEl.textContent = text;
    dateEl.classList.remove("is-empty");
  } else {
    dateEl.textContent = "";
    dateEl.classList.add("is-empty");
  }
}

// Robust step-source: prefer the currently-active label span's index inside
// its parent (temporal-controls.js's `updateActiveYearLabel` toggles the
// .is-active class + aria-current="true" on every step change — during BOTH
// manual drag AND the play-animation loop, which uses `slider.value = x`
// directly and never fires an input event we could listen to).  Falling back
// to slider.value covers the millisecond window between class flip and
// mutation callback.
function _currentStepIndex() {
  const labels = document.querySelectorAll("#temp-slider1 .year-labels1 span");
  if (labels.length) {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].classList.contains("is-active")) return i;
    }
  }
  const slider = document.getElementById(SLIDER1_ID);
  return slider ? (Number(slider.value) || 0) : 0;
}

// Override _refresh to source its index from the same signal that drives
// the visible active pill — this keeps the two in lock-step no matter how
// the step advances (drag / play / speed change / click-a-label).
function _refreshFromDom() {
  const dateEl = _ensureDateEl();
  if (!dateEl) return;
  const state  = typeof window.getCurrentTemporalState === "function"
                 ? window.getCurrentTemporalState()
                 : null;
  const idx    = _currentStepIndex();
  const frames = state?.layersDef;
  const entry  = Array.isArray(frames) ? frames[idx] : null;
  const text   = _pickDateFromEntry(entry);
  if (text) {
    dateEl.textContent = text;
    dateEl.classList.remove("is-empty");
  } else {
    dateEl.textContent = "";
    dateEl.classList.add("is-empty");
  }
}

export function initTemporalCurrentStep() {
  if (_wired) return;
  _wired = true;

  // Manual drag / click-to-jump — these dispatch `input`/`change` events
  // that bubble to document.  Capture-phase so we fire even if a handler
  // upstream calls stopPropagation() (temporal-controls.js:924 does).
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === SLIDER1_ID) _refreshFromDom();
  }, true);
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === SLIDER1_ID) _refreshFromDom();
  }, true);

  // Play-animation + programmatic step advances — these NEVER dispatch an
  // input event; they just flip the `.is-active` class + `aria-current`
  // attribute on the label spans (see updateActiveYearLabel in
  // temporal-controls.js:424).  MutationObserver on the labels container
  // catches every one of those updates, so drag and play both refresh.
  //
  // subtree:true walks new-layer-load reflows too (layers rebuild the whole
  // .year-labels1 innerHTML on switch), so we don't need a separate observer
  // for that case.
  const attachLabelsObserver = () => {
    const labels = document.querySelector("#temp-slider1 .year-labels1");
    if (!labels) return false;
    const mo = new MutationObserver(_refreshFromDom);
    mo.observe(labels, {
      attributes: true,
      attributeFilter: ["class", "aria-current"],
      subtree: true,      // catches spans that get re-created on layer switch
      childList: true,    // catches the innerHTML reset itself
    });
    return true;
  };
  if (!attachLabelsObserver()) {
    // Labels container not built yet — retry once the slider template mounts.
    const mo = new MutationObserver(() => {
      if (attachLabelsObserver()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
  }

  // Layer on/off toggles the slider bar's display style; refresh so a
  // freshly-shown layer paints its date immediately.
  const bar = document.getElementById("temp-slider1");
  if (bar) {
    const mo2 = new MutationObserver(_refreshFromDom);
    mo2.observe(bar, { attributes: true, attributeFilter: ["style"] });
  }

  // Initial paint (in case a layer is already active at boot).
  _refreshFromDom();
}

// Auto-init on DOMContentLoaded so callers don't need to remember to wire it.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTemporalCurrentStep);
  } else {
    initTemporalCurrentStep();
  }
}