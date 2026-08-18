// ncop-assistant.js
// ---------------------------------------------------------------------------
// NCOP Assistant — a self-contained rail button + panel, following the same
// pattern GisExportControl already established for a standalone control
// (own wrapper appended to #map, own render/wire methods, no shared state
// with other panels). Deliberately separate from navigation-panel.js's
// existing "#gee-chat-modal" (GEE Data Assistant, narrowly scoped to Earth
// Engine dynamic layers) — same visual chrome *shape* (message list + input
// wrapper, display-toggled panel) copied for consistency, but zero shared
// code/state, so this can never regress that feature. Talks to
// POST /api/assistant/chat/ (ncop_internal/chatbot.py).
//
// Phase 1: RAG Q&A. Phase 2 (this file): the backend may return an
// `actions` array alongside a reply — `navigate_to` with target_type
// "layer" | "subcategory" | "category" | "control". Pure NAVIGATION
// (opening the sidebar, expanding/scrolling to a layer row, a subcategory,
// or a whole category accordion, pulsing a rail control) fires
// AUTOMATICALLY the instant the message renders — no click, no
// confirmation, matching the operational requirement that the assistant
// "has the authority" to do this itself. A click/Yes-No IS still required
// for the two things that actually change UI/map state: turning a LAYER
// on, and opening a CONTROL's own panel — those alone are gated. The panel
// is display-toggled (`style.display`), matching the "display" kind in
// dashboard.js's RAIL_PANEL_REGISTRY (the same mechanism #gee-chat-modal
// uses) so the existing MutationObserver-based mutual-exclusion
// (setupStrictRailMutualExclusion) picks it up automatically — this module
// never has to know about any other panel.
// ---------------------------------------------------------------------------

import lottie from "lottie-web";
import { ncopNavigateToLayerItem, ncopToggleLayerOn, ncopNavigateToSubcategory, ncopNavigateToCategory } from "./sidebar-menu.js";
import chatbotLottieData from "../assets/images/chatbot/chatbot_normall.json";

const CHAT_ENDPOINT = "/api/assistant/chat/";
const MODELS_ENDPOINT = "/api/assistant/models/";
const MODEL_PREF_KEY = "ncop-assistant-model-pref";
const TTS_PREF_KEY = "ncop-assistant-tts-pref";

const WELCOME_MESSAGE =
  "👋 **Hi! I'm the NCOP Assistant.**\nAsk me about NCOP itself, what a layer shows, " +
  "how a part of the dashboard works, or where to find something.";

// Narration icons — identical markup to story-provincial-forecast.js's own
// .pf-mute button (same SVGs, same is-muted/aria-label convention), reused
// here so the assistant panel's narration control reads as the same
// established UI language rather than inventing a new one.
const ICON_TTS_ON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
const ICON_TTS_OFF = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;

// ---- Small, safe markdown renderer -----------------------------------------
// The Groq model is now explicitly asked (see chatbot.py's SYSTEM_PROMPT_HEADER)
// for headers/**bold**/lists/emoji — rendering it as plain textContent would
// dump literal "**" characters into the chat, so this converts that markdown
// to real HTML. Escapes entities FIRST, then only ever re-introduces tags via
// fixed, hand-written templates around already-escaped text — the model's
// own output can never inject a raw tag, no matter what it returns.
function _escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

function _renderInlineMarkdown(escapedText) {
  return escapedText
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+?)`/g, "<code>$1</code>");
}

function _renderMarkdownTable(lines) {
  const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const [header, sep, ...body] = rows;
  if (!sep || !/^:?-+:?$/.test(sep[0] || "")) return null; // not actually a table separator row
  const th = header.map((c) => `<th>${_renderInlineMarkdown(c)}</th>`).join("");
  const trs = body.map((r) => `<tr>${r.map((c) => `<td>${_renderInlineMarkdown(c)}</td>`).join("")}</tr>`).join("");
  return `<table class="ncop-assistant-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function _renderMarkdown(rawText) {
  const escaped = _escapeHtml(rawText);
  const lines = escaped.split("\n");
  const htmlBlocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const headerMatch = line.match(/^(#{1,4})\s+(.*)$/);
    if (headerMatch) {
      const level = Math.min(6, headerMatch[1].length + 3); // ## -> h5, # -> h4 — stays small inside a chat bubble
      htmlBlocks.push(`<h${level} class="ncop-assistant-md-h">${_renderInlineMarkdown(headerMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tableLines.push(lines[i]); i++; }
      const table = _renderMarkdownTable(tableLines);
      if (table) { htmlBlocks.push(table); continue; }
    }

    if (/^\s*[-•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-•]\s+/.test(lines[i])) {
        items.push(`<li>${_renderInlineMarkdown(lines[i].replace(/^\s*[-•]\s+/, ""))}</li>`);
        i++;
      }
      htmlBlocks.push(`<ul class="ncop-assistant-md-list">${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${_renderInlineMarkdown(lines[i].replace(/^\s*\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      htmlBlocks.push(`<ol class="ncop-assistant-md-list">${items.join("")}</ol>`);
      continue;
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-•]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    htmlBlocks.push(`<p class="ncop-assistant-md-p">${_renderInlineMarkdown(paraLines.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return htmlBlocks.join("");
}

export class NcopAssistantControl {
  #map;
  #isVisible = false;
  #busy = false;
  #messagesEl = null;
  #selectedModel = "";
  #ttsEnabled = false;
  #typingAnimation = null;

  constructor(map) {
    this.#map = map;
    this.#render();
    this.#renderMascot();
    this.#loadTtsPref();
    this.#setStatus(navigator.onLine ? "checking" : "offline");
    window.addEventListener("online", () => this.#setStatus("online"));
    window.addEventListener("offline", () => this.#setStatus("offline"));
    this.#loadModels(); // async, fire-and-forget — populates the picker once /api/assistant/models/ responds; also resolves initial connection status
    this.#wireEvents();
    window.ncopAssistantControl = this;
  }

  // ---- DOM ------------------------------------------------------------------
  // No rail-button entry point anymore — the standalone floating mascot
  // (#renderMascot) is the sole way to open this panel; a second, static
  // rail icon next to it was redundant.
  #render() {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    const panel = document.createElement("div");
    panel.id = "ncop-assistant-modal";
    panel.style.display = "none";
    panel.innerHTML = `
      <div class="ncop-assistant-header">
        <div class="ncop-assistant-title">
          <i data-lucide="bot" style="width:18px;height:18px"></i>
          <span>NCOP Assistant</span>
          <span class="ncop-assistant-status is-checking" id="ncopAssistantStatus" title="Checking connection…" aria-label="Checking connection…">
            <span class="ncop-assistant-status-dot"></span>
          </span>
        </div>
        <div class="ncop-assistant-header-actions">
          <select id="ncopAssistantModelPicker" class="ncop-assistant-model-picker" aria-label="Choose AI model" title="Choose AI model">
            <option value="">Loading models…</option>
          </select>
          <button id="ncopAssistantMute" class="ncop-assistant-mute is-muted" type="button" aria-label="Enable narration" title="Enable narration">${ICON_TTS_OFF}</button>
          <button id="ncopAssistantClose" type="button" aria-label="Close">
            <i data-lucide="x"></i>
          </button>
        </div>
      </div>
      <div class="ncop-assistant-messages" id="ncopAssistantMessages"></div>
      <div class="ncop-assistant-input-wrapper">
        <input type="text"
               id="ncopAssistantInput"
               placeholder="Ask about NCOP…"
               autocomplete="off"
               data-lpignore="true"
               data-form-type="other"
               data-1p-ignore="true">
        <button id="ncopAssistantSend" type="button" aria-label="Send">
          <i data-lucide="send"></i>
        </button>
      </div>
    `;
    mapEl.appendChild(panel);

    this.#messagesEl = panel.querySelector("#ncopAssistantMessages");
    try { window.lucide?.createIcons(); } catch (_) {}
  }

  // ---- Standalone floating mascot --------------------------------------------
  // A second, independent instance of the same animation, living in
  // Mapbox's own bottom-right controls corner (.mapboxgl-ctrl-bottom-right)
  // rather than the right rail — a second, more prominent entry point to
  // the assistant. That corner is already flex-column/align-items:flex-end
  // (see _map-panels.css, established for the scale bar) so inserting this
  // as the FIRST child stacks it visually ABOVE the scale bar through
  // normal flex flow — no fixed-pixel coordinates tied to the right rail's
  // own (variable) height. The corner container has pointer-events:none by
  // default (so it never blocks map drags); this element opts back into
  // pointer-events:auto itself, same as the scale bar already does.
  #renderMascot() {
    const corner = document.querySelector(".mapboxgl-ctrl-bottom-right");
    if (!corner) return;

    const mascot = document.createElement("div");
    mascot.className = "ncop-assistant-mascot";
    mascot.id = "ncopAssistantMascot";
    mascot.title = "Ask the NCOP Assistant";
    mascot.setAttribute("role", "button");
    mascot.setAttribute("aria-label", "Open NCOP Assistant");
    mascot.tabIndex = 0;
    mascot.innerHTML = `<div class="ncop-assistant-mascot-lottie" id="ncopAssistantMascotLottie"></div>`;
    corner.insertBefore(mascot, corner.firstChild);

    const lottieEl = document.getElementById("ncopAssistantMascotLottie");
    if (lottieEl) {
      try {
        lottie.loadAnimation({
          container: lottieEl,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: chatbotLottieData,
        });
      } catch (_) { /* decorative — never block the click target itself */ }
    }

    const open = () => {
      if (this.#isVisible) this.hidePanel();
      else this.showPanel();
    };
    mascot.addEventListener("click", open);
    mascot.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  }

  // ---- Connection status ------------------------------------------------------
  // Combines the browser-level network signal (instant, zero-cost —
  // window's own online/offline events) with the assistant's OWN actual
  // reachability (set from #loadModels'/#handleSend's real fetch
  // outcomes) — navigator.onLine being true only means the device has SOME
  // network, not that this app's backend is reachable, so both signals
  // matter.
  #setStatus(status) {
    const el = document.getElementById("ncopAssistantStatus");
    if (!el) return;
    el.classList.remove("is-online", "is-offline", "is-checking");
    el.classList.add(`is-${status}`);
    const label =
      status === "online" ? "Online — assistant is reachable" :
      status === "offline" ? "Offline — check your connection" :
      "Checking connection…";
    el.setAttribute("title", label);
    el.setAttribute("aria-label", label);
  }

  // ---- Show / hide ------------------------------------------------------------
  #wireEvents() {
    const closeBtn = document.getElementById("ncopAssistantClose");
    const sendBtn = document.getElementById("ncopAssistantSend");
    const input = document.getElementById("ncopAssistantInput");
    const modelPicker = document.getElementById("ncopAssistantModelPicker");
    const muteBtn = document.getElementById("ncopAssistantMute");

    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.hidePanel();
    });
    sendBtn?.addEventListener("click", () => this.#handleSend());
    input?.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.#handleSend();
    });
    modelPicker?.addEventListener("change", () => {
      this.#selectedModel = modelPicker.value;
      try { localStorage.setItem(MODEL_PREF_KEY, this.#selectedModel); } catch (_) {}
    });
    muteBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#ttsEnabled = !this.#ttsEnabled;
      try { localStorage.setItem(TTS_PREF_KEY, this.#ttsEnabled ? "on" : "off"); } catch (_) {}
      this.#syncMuteButton();
      if (!this.#ttsEnabled) { try { window.speechSynthesis?.cancel(); } catch (_) {} }
    });

    if (this.#messagesEl && !this.#messagesEl.childElementCount) {
      this.#addMessage("assistant", WELCOME_MESSAGE, undefined, undefined, /* speak */ false);
    }
  }

  // ---- Model picker -----------------------------------------------------------
  // Fetches the model list from the backend rather than hardcoding a copy
  // here — chat_engine.SUPPORTED_MODELS (chat_engine.py) is the single
  // source of truth, so the picker can never drift out of sync with what
  // the backend actually supports.
  async #loadModels() {
    const select = document.getElementById("ncopAssistantModelPicker");
    let reached = false;
    try {
      const res = await fetch(MODELS_ENDPOINT, { credentials: "same-origin" });
      reached = true; // fetch resolving at all means the backend was reachable, regardless of payload shape
      this.#setStatus("online");
      const data = await res.json();
      const models = Array.isArray(data.models) ? data.models : [];
      if (!models.length) throw new Error("empty model list");

      let pref = "";
      try { pref = localStorage.getItem(MODEL_PREF_KEY) || ""; } catch (_) {}
      this.#selectedModel = models.some((m) => m.id === pref) ? pref : (data.default || models[0].id);

      if (select) {
        select.innerHTML = models
          .map((m) => `<option value="${_escapeHtml(m.id)}" title="${_escapeHtml(m.description || "")}">${_escapeHtml(m.label)} — ${_escapeHtml(m.provider)}</option>`)
          .join("");
        select.value = this.#selectedModel;
      }
    } catch (_) {
      // Model list unreachable — hide the picker rather than show a broken
      // dropdown; an empty `model` in the chat request falls back to the
      // backend's own default (chatbot.py treats it identically to an
      // unrecognized id), so the assistant still works either way. Only
      // mark offline if the fetch itself never even reached the server —
      // a shape error AFTER a successful fetch (e.g. empty model list)
      // means the backend IS reachable, so status correctly stays "online".
      if (select) select.style.display = "none";
      if (!reached) this.#setStatus("offline");
    }
  }

  // ---- Narration (text-to-speech) ----------------------------------------------
  // Browser-native window.speechSynthesis — the same zero-dependency
  // approach story-provincial-forecast.js/story-dynamic-weather.js already
  // use for their own narration, reused here rather than adding a TTS
  // library/API. Off by default (matches the pasted button's own
  // "is-muted"/"Enable narration" starting state); persisted via
  // localStorage, same convention as MODEL_PREF_KEY / the stories' own
  // TTS_PREF_KEY.
  #loadTtsPref() {
    try { this.#ttsEnabled = localStorage.getItem(TTS_PREF_KEY) === "on"; } catch (_) { this.#ttsEnabled = false; }
    this.#syncMuteButton();
  }

  #syncMuteButton() {
    const btn = document.getElementById("ncopAssistantMute");
    if (!btn) return;
    btn.classList.toggle("is-muted", !this.#ttsEnabled);
    btn.innerHTML = this.#ttsEnabled ? ICON_TTS_ON : ICON_TTS_OFF;
    const label = this.#ttsEnabled ? "Mute narration" : "Enable narration";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }

  // `onBoundary(fraction)`/`onDone()` are optional — passed by
  // #animateBubbleTypingWithSpeech to sync the typing reveal to this
  // exact utterance. Every exit path (nothing to say, synth unavailable,
  // muted, an exception) still calls onDone so a caller relying on it can
  // never be left hanging.
  #speak(text, { onBoundary, onDone } = {}) {
    try {
      const ss = window.speechSynthesis;
      if (!ss || !this.#ttsEnabled || !text) { onDone?.(); return; }
      ss.cancel(); // never let two replies talk over each other
      const speech = String(text)
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/[#*_`]/g, "")
        .replace(/\|/g, " ")
        .replace(/\n+/g, ". ")
        .replace(/\s+/g, " ")
        .trim();
      if (!speech) { onDone?.(); return; }
      const utter = new SpeechSynthesisUtterance(speech);
      utter.rate = 1;
      utter.lang = "en-US";
      if (onBoundary) {
        utter.onboundary = (e) => {
          const idx = typeof e.charIndex === "number" ? e.charIndex : speech.length;
          onBoundary(Math.min(1, Math.max(0, idx / speech.length)));
        };
      }
      utter.onend = () => onDone?.();
      utter.onerror = () => onDone?.();
      ss.speak(utter);
    } catch (_) {
      onDone?.(); // narration is a nicety, never blocks the chat
    }
  }

  showPanel() {
    const panel = document.getElementById("ncop-assistant-modal");
    const mascot = document.getElementById("ncopAssistantMascot");
    if (!panel) return;
    panel.style.display = "flex";
    mascot?.classList.add("active-ncop-assistant");
    this.#isVisible = true;
    document.getElementById("ncopAssistantInput")?.focus();
  }

  hidePanel() {
    const panel = document.getElementById("ncop-assistant-modal");
    const mascot = document.getElementById("ncopAssistantMascot");
    if (!panel) return;
    panel.style.display = "none";
    mascot?.classList.remove("active-ncop-assistant");
    this.#isVisible = false;
    try { window.speechSynthesis?.cancel(); } catch (_) {} // narration shouldn't keep talking after the panel closes
  }

  // ---- Chat -----------------------------------------------------------------
  // `sources` is still accepted (and still returned by the API) but
  // deliberately not rendered — a flat dump of raw item_key/frontend_id/
  // section_heading values (e.g. "layerInfoToggle, 12. Code Graph
  // (graphifyy), pmd_pred_cloud_cover") reads as noise, not a citation, to
  // an end user who has no reason to recognize those internal ids. The
  // response text itself (see chatbot.py's system prompt) is now required
  // to actually describe whatever it's talking about, which is what a
  // "source" should have been doing in the first place.
  // `speak` defaults true — every assistant bubble is narrated when TTS is
  // enabled (see #speak), EXCEPT the initial page-load welcome message
  // (explicitly passed false at its one call site): auto-speaking on load
  // with no user gesture is the wrong first impression and some browsers
  // silently refuse it anyway before any user interaction has occurred.
  #addMessage(role, text, sources, actions, speak = true) {
    if (!this.#messagesEl) return;
    const row = document.createElement("div");
    row.className = `ncop-assistant-msg ncop-assistant-msg--${role}`;
    const bubble = document.createElement("div");
    bubble.className = "ncop-assistant-bubble";
    if (role === "assistant") {
      const html = _renderMarkdown(text);
      // When narration will actually play, the reveal is driven BY the
      // speech itself (see #animateBubbleTypingWithSpeech) rather than a
      // separate guessed duration, so the two can never visibly drift
      // apart. #speak is called from inside that path — never separately
      // — so there's exactly one place narration ever starts from.
      if (speak && this.#ttsEnabled && window.speechSynthesis) {
        this.#animateBubbleTypingWithSpeech(bubble, html, text);
      } else {
        this.#animateBubbleTyping(bubble, html);
      }
    } else {
      bubble.textContent = text;
    }
    row.appendChild(bubble);

    this.#messagesEl.appendChild(row);
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
    try { window.lucide?.createIcons(); } catch (_) {}

    // Navigation is authoritative, not opt-in — fires the instant the
    // message lands, no click required (see the header comment for why).
    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (action.type === "navigate_to") this.#autoNavigate(action);
        else if (action.type === "fly_to") this.#flyToLocation(action);
      }
    }
  }

  // A data tool (get_heatwave_monitoring/get_weather_forecast) resolved a
  // single, unambiguous city — chatbot.py decided this in code from that
  // tool's own coordinates, not something the model had to separately
  // remember to request, so it's authoritative the same way navigate_to
  // is: no click needed. City-scale zoom (not a street-level one) since
  // this is "which part of the country", not "which building".
  #flyToLocation(action) {
    if (!this.#map || typeof action.lat !== "number" || typeof action.lon !== "number") return;
    try {
      this.#map.flyTo({
        center: [action.lon, action.lat],
        zoom: 9,
        duration: 2000,
        essential: true,
      });
    } catch (_) { /* camera move is a nicety, never blocks the chat */ }
  }

  // ---- Typing animation (assistant replies) ----------------------------
  // A modern-chat-style progressive reveal, built on top of the ALREADY-
  // rendered markdown HTML rather than raw text — re-running
  // _renderMarkdown on every frame would re-parse the whole message
  // dozens of times a second for no visual benefit, and revealing
  // not-yet-complete markdown syntax (a half-typed "**bold" or a half-
  // built <table>) looks broken rather than charming. Instead the HTML
  // is parsed exactly once, its text nodes are walked in document order,
  // and how much of each node's text is visible grows over time — table/
  // list/heading STRUCTURE is complete and stable from the very first
  // frame; only the letters fill in.

  // Pure setup — parses `html` into `bubble`, empties its text nodes, and
  // returns a reveal(count) closure plus the total character count. No
  // timing of its own; shared by both variants below.
  #prepareTypingReveal(bubble, html) {
    bubble.innerHTML = html;
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let totalChars = 0;
    let node;
    while ((node = walker.nextNode())) {
      const full = node.nodeValue;
      if (full) {
        textNodes.push({ node, full });
        totalChars += full.length;
      }
    }
    for (const { node: n } of textNodes) n.nodeValue = "";
    const reveal = (count) => {
      let remaining = count;
      for (const { node: n, full } of textNodes) {
        if (remaining >= full.length) { n.nodeValue = full; remaining -= full.length; }
        else { n.nodeValue = remaining > 0 ? full.slice(0, remaining) : ""; remaining = 0; }
      }
    };
    return { reveal, totalChars };
  }

  // Registers `state` as the one active typing animation, cancelling and
  // instantly completing whatever was still running before it — so
  // replies can never finish out of order or leave a stray timer/RAF
  // loop behind when a new message arrives mid-animation.
  #startTyping(state) {
    if (this.#typingAnimation) {
      this.#typingAnimation.cancelled = true;
      this.#typingAnimation.finish();
    }
    this.#typingAnimation = state;
  }

  // Fixed-duration reveal — used whenever narration is off or
  // unavailable. A deliberately unhurried, legible typewriter pace
  // (~18 characters/second) rather than a near-instant flash, bounded so
  // a very long reply still finishes in a reasonable time instead of
  // crawling for a minute.
  #animateBubbleTyping(bubble, html) {
    const { reveal, totalChars } = this.#prepareTypingReveal(bubble, html);
    if (!totalChars) return; // nothing to type (e.g. an image-only reply) — HTML is already in place

    const durationMs = Math.min(6000, Math.max(600, totalChars * 55));
    const startedAt = performance.now();
    const state = { cancelled: false, finish: null };
    state.finish = () => {
      state.cancelled = true;
      reveal(totalChars);
      if (this.#typingAnimation === state) this.#typingAnimation = null;
    };
    this.#startTyping(state);

    const step = (now) => {
      if (state.cancelled) return;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      reveal(Math.round(totalChars * progress));
      if (this.#messagesEl) this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
      if (progress < 1) requestAnimationFrame(step);
      else state.finish();
    };
    requestAnimationFrame(step);
  }

  // TTS-synced reveal — text fills in step with the ACTUAL spoken audio
  // (SpeechSynthesisUtterance's onboundary event reports how far the
  // voice has progressed through the utterance) instead of a guessed
  // duration, so the two can never visibly drift apart. `rawText` (not
  // the rendered HTML) is what's actually spoken — see #speak for the
  // markdown-stripping that produces its char-index space. Falls back to
  // the same fixed, unhurried pace as #animateBubbleTyping if no
  // boundary event arrives shortly after speech starts (some engines/
  // voices only report per-sentence boundaries, or none at all), so the
  // bubble is never left empty for the length of the whole reply.
  #animateBubbleTypingWithSpeech(bubble, html, rawText) {
    const { reveal, totalChars } = this.#prepareTypingReveal(bubble, html);
    if (!totalChars) { this.#speak(rawText); return; }

    const state = { cancelled: false, finish: null, usingFallback: false };
    state.finish = () => {
      state.cancelled = true;
      reveal(totalChars);
      if (this.#typingAnimation === state) this.#typingAnimation = null;
    };
    this.#startTyping(state);

    const startFallback = () => {
      if (state.cancelled || state.usingFallback) return;
      state.usingFallback = true;
      const durationMs = Math.min(6000, Math.max(600, totalChars * 55));
      const startedAt = performance.now();
      const step = (now) => {
        if (state.cancelled) return;
        const progress = Math.min(1, (now - startedAt) / durationMs);
        reveal(Math.round(totalChars * progress));
        if (this.#messagesEl) this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    let sawBoundary = false;
    const graceTimer = setTimeout(() => { if (!sawBoundary) startFallback(); }, 400);

    this.#speak(rawText, {
      onBoundary: (fraction) => {
        if (state.cancelled || state.usingFallback) return;
        sawBoundary = true;
        clearTimeout(graceTimer);
        reveal(Math.round(totalChars * fraction));
        if (this.#messagesEl) this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
      },
      onDone: () => {
        clearTimeout(graceTimer);
        if (!state.cancelled) state.finish();
      },
    });
  }

  // ---- Navigation actions (Phase 2) ------------------------------------------
  // Pulses the rail button's own icon — controls are always visible in the
  // rail already (unlike sidebar items, nothing needs opening/scrolling for
  // them), so "point to it" just means a brief, obvious highlight.
  #pulseControl(frontendId) {
    const el = document.getElementById(frontendId);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ncop-assistant-highlight");
    setTimeout(() => el.classList.remove("ncop-assistant-highlight"), 2600);
    return true;
  }

  // Fires automatically the instant a navigate_to action arrives — no
  // click, no confirmation (see the file header for why). Only the two
  // sub-steps that actually CHANGE something — turning a layer on, opening
  // a control's panel — still stop and wait for an explicit Yes/No.
  async #autoNavigate(action) {
    if (action.target_type === "control") {
      // Pulses it wherever it currently lives — works whether its own
      // panel is open or closed, since the button itself (unlike a
      // sidebar layer row) is always present in the DOM regardless of
      // that panel's state; only a very narrow viewport that's actually
      // clipped the rail would make this miss.
      const ok = this.#pulseControl(action.target_id);
      if (ok) this.#offerControlOpen(action.target_id, action.label);
      else this.#addMessage("assistant", `Couldn't find "${action.label}" on screen right now — it may be hidden by your current window size.`);
      return;
    }

    if (action.target_type === "subcategory") {
      // Pure navigation, same as category — nothing to toggle at this
      // granularity, so no confirm step. target_id is "<categoryKey>::
      // <subcategory>" (see chatbot.py's NAVIGATE_TOOL schema).
      const [categoryKey, subcategoryKey] = action.target_id.split("::");
      const result = await ncopNavigateToSubcategory(categoryKey, subcategoryKey);
      this.#addMessage(
        "assistant",
        result.found
          ? `📍 Opened **${result.label}** in the sidebar.`
          : `Couldn't find "${action.label}" in the sidebar — it may have been renamed.`
      );
      return;
    }

    if (action.target_type === "category") {
      // Pure navigation, nothing to toggle — no confirm step needed at
      // all, unlike a single layer (which can be turned on/off) or a
      // control (which opens a panel).
      const result = await ncopNavigateToCategory(action.target_id);
      this.#addMessage(
        "assistant",
        result.found
          ? `📍 Opened the **${result.label}** category in the sidebar.`
          : `Couldn't find the "${action.label}" category in the sidebar — it may have been renamed.`
      );
      return;
    }

    if (action.target_type === "layer") {
      const result = await ncopNavigateToLayerItem(action.target_id);
      if (!result.found) {
        this.#addMessage("assistant", `Couldn't find "${action.label}" in the sidebar — it may have been renamed or removed.`);
        return;
      }
      this.#offerLayerToggle(action.target_id, result.label);
    }
  }

  // Generic "open it for you" for ANY rail/UI control — a plain `.click()`
  // on the real button, which is exactly what a user's own click would do,
  // so this can never drift from that control's actual behavior (no
  // per-control special-casing needed here). Works regardless of whether
  // that control's own panel is currently open or closed, since clicking
  // its toggle button is precisely how it opens in the first place.
  #offerControlOpen(frontendId, label) {
    if (!this.#messagesEl) return;
    const row = document.createElement("div");
    row.className = "ncop-assistant-msg ncop-assistant-msg--assistant";
    const bubble = document.createElement("div");
    bubble.className = "ncop-assistant-bubble";
    bubble.innerHTML = _renderMarkdown(`Want me to open **${label}** for you?`);
    row.appendChild(bubble);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "ncop-assistant-actions";
    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "ncop-assistant-action-btn ncop-assistant-action-btn--primary";
    yesBtn.textContent = "Yes, open it";
    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "ncop-assistant-action-btn";
    noBtn.textContent = "No thanks";

    yesBtn.addEventListener("click", () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      const el = document.getElementById(frontendId);
      if (el) {
        el.click();
        this.#addMessage("assistant", `✅ Opened **${label}**.`);
      } else {
        this.#addMessage("assistant", `Couldn't open ${label} — the control isn't on screen right now.`);
      }
    });
    noBtn.addEventListener("click", () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
    });

    actionsWrap.appendChild(yesBtn);
    actionsWrap.appendChild(noBtn);
    row.appendChild(actionsWrap);
    this.#messagesEl.appendChild(row);
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
  }

  // Explicit Yes/No, never auto-toggled — matches the original requirement
  // that the assistant must ask before turning a layer on. Uses
  // ncopToggleLayerOn (sidebar-menu.js), which simulates the REAL
  // click/change event a user's own interaction would fire — not
  // sourceLayerControl.addLayerByKey directly, which would add the layer
  // to the map but leave the sidebar checkbox unchecked, and for a
  // TEMPORAL layer would skip building the #temp-slider1 timeline/legend
  // UI entirely (temporal activation is a genuinely different, richer
  // path than a plain toggle — see temporal-controls.js).
  #offerLayerToggle(itemKey, label) {
    if (!this.#messagesEl) return;
    const row = document.createElement("div");
    row.className = "ncop-assistant-msg ncop-assistant-msg--assistant";
    const bubble = document.createElement("div");
    bubble.className = "ncop-assistant-bubble";
    bubble.innerHTML = _renderMarkdown(`Turn on **${label}**?`);
    row.appendChild(bubble);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "ncop-assistant-actions";
    const yesBtn = document.createElement("button");
    yesBtn.type = "button";
    yesBtn.className = "ncop-assistant-action-btn ncop-assistant-action-btn--primary";
    yesBtn.textContent = "Yes, turn it on";
    const noBtn = document.createElement("button");
    noBtn.type = "button";
    noBtn.className = "ncop-assistant-action-btn";
    noBtn.textContent = "No thanks";

    yesBtn.addEventListener("click", async () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
      try {
        const result = await ncopToggleLayerOn(itemKey);
        if (!result.found) {
          this.#addMessage("assistant", `Couldn't find ${label} in the sidebar — it may have been renamed or removed.`);
        } else if (result.alreadyOn) {
          this.#addMessage("assistant", `**${label}** is already on.`);
        } else {
          this.#addMessage("assistant", `✅ **${result.label}** is now on.`);
        }
      } catch (_) {
        this.#addMessage("assistant", `Couldn't turn on ${label} — please try toggling it from the sidebar directly.`);
      }
    });
    noBtn.addEventListener("click", () => {
      yesBtn.disabled = true;
      noBtn.disabled = true;
    });

    actionsWrap.appendChild(yesBtn);
    actionsWrap.appendChild(noBtn);
    row.appendChild(actionsWrap);
    this.#messagesEl.appendChild(row);
    this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;
  }

  #setBusy(busy) {
    this.#busy = busy;
    const sendBtn = document.getElementById("ncopAssistantSend");
    const input = document.getElementById("ncopAssistantInput");
    if (sendBtn) sendBtn.disabled = busy;
    if (input) input.disabled = busy;
  }

  // Live map-state snapshot, sent with every message so the assistant can
  // ground "what's on the map right now" answers in the ACTUAL current
  // state rather than guessing from documentation alone. Same ground-truth
  // split gis-export-control.js already established: TOGGLE items come
  // from sourceLayerControl.activeLayers (never the sidebar checkbox DOM
  // state), while the single active TEMPORAL item comes separately from
  // window.getCurrentTemporalState() (temporal-controls.js) — a temporal
  // layer is never also present in activeLayers, see TEMPORAL_LAYERS_GUIDE.md.
  #buildMapStateSnapshot() {
    const slc = window.sourceLayerControl;
    const activeLayers = slc?.activeLayers ? Array.from(slc.activeLayers.keys()) : [];
    const temporalState =
      typeof window.getCurrentTemporalState === "function" ? window.getCurrentTemporalState() : null;
    const temporal = temporalState?.layerKey
      ? {
          layer_key: temporalState.layerKey,
          date: temporalState.currentEntry?.date || temporalState.date || null,
          step_index: temporalState.currentIndex ?? null,
        }
      : null;
    return { active_layers: activeLayers, temporal };
  }

  async #handleSend() {
    if (this.#busy) return;
    const input = document.getElementById("ncopAssistantInput");
    const message = input?.value.trim();
    if (!message) return;

    this.#addMessage("user", message);
    input.value = "";
    this.#setBusy(true);

    const thinkingRow = document.createElement("div");
    thinkingRow.className = "ncop-assistant-msg ncop-assistant-msg--assistant ncop-assistant-msg--thinking";
    thinkingRow.innerHTML = `<div class="ncop-assistant-bubble"><span></span><span></span><span></span></div>`;
    this.#messagesEl?.appendChild(thinkingRow);
    if (this.#messagesEl) this.#messagesEl.scrollTop = this.#messagesEl.scrollHeight;

    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin", // session cookie round-trips so the backend can remember conversation history
        body: JSON.stringify({ message, map_state: this.#buildMapStateSnapshot(), model: this.#selectedModel }),
      });
      this.#setStatus("online"); // reaching the server at all (any HTTP status) means the connection itself is fine
      const data = await res.json().catch(() => ({}));
      thinkingRow.remove();
      if (!res.ok) {
        this.#addMessage("assistant", data?.error || "The assistant is unavailable right now — please try again shortly.");
      } else {
        this.#addMessage("assistant", data.reply || "(no reply)", data.sources, data.actions);
      }
    } catch (_) {
      thinkingRow.remove();
      this.#setStatus("offline"); // fetch() itself rejected — a genuine network/reachability failure, not an HTTP error status
      this.#addMessage("assistant", "Couldn't reach the assistant — check your connection and try again.");
    } finally {
      this.#setBusy(false);
      input?.focus();
    }
  }
}
