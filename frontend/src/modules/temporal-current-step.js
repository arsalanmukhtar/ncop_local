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

export function initTemporalCurrentStep() {
  if (_wired) return;
  _wired = true;

  // Delegated slider listener — attach to document so we don't miss the
  // element on the first render race (the slider node exists in the
  // template but may not be reachable at import time in some flows).
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === SLIDER1_ID) _refresh();
  }, true);
  document.addEventListener("change", (e) => {
    if (e.target && e.target.id === SLIDER1_ID) _refresh();
  }, true);

  // A new layer load resets slider.max (in temporal-controls.js updateTempSlider).
  // Watch the attribute so we refresh on layer change without patching that
  // core code.  Also watches display-toggle to catch the layer-off case.
  const slider = document.getElementById(SLIDER1_ID);
  if (slider) {
    const mo = new MutationObserver(_refresh);
    mo.observe(slider, { attributes: true, attributeFilter: ["max", "value"] });
  }
  const bar = document.getElementById("temp-slider1");
  if (bar) {
    const mo2 = new MutationObserver(_refresh);
    mo2.observe(bar, { attributes: true, attributeFilter: ["style"] });
  }

  // Initial paint (in case the slider is already active at boot).
  _refresh();
}

// Auto-init on DOMContentLoaded so callers don't need to remember to wire it.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initTemporalCurrentStep);
  } else {
    initTemporalCurrentStep();
  }
}