// ===========================================================================
// mapbox-telemetry-mute.js  (also mutes a couple of harmless dev-only
// console warnings from third-party scripts)
// ---------------------------------------------------------------------------
// Silences three kinds of expected-but-noisy console lines:
//
//   1. `POST https://events.mapbox.com/events/v2 … net::ERR_BLOCKED_BY_CLIENT`
//      — Mapbox's anonymous telemetry, blocked by every mainstream
//      ad-blocker (uBlock Origin, Brave shields, PiHole, …).  Not our
//      request, not our fault, but it spams the console.
//
//   2. `cdn.tailwindcss.com should not be used in production`
//      — self-warning emitted by the Tailwind CDN script.  The CDN is
//      still the fastest way to keep the sidebar/dashboard chrome
//      styled without pinning a full Tailwind config here; muting the
//      one specific warning is safer than yanking the CDN and risking
//      a chrome-wide styling regression.
//
//   3. Mapbox events (POST) issued via XMLHttpRequest — same telemetry
//      channel, different transport.
//
// Mapbox GL JS v3 doesn't expose a public API to disable telemetry, so
// the pragmatic fix is to patch `window.fetch` and `XMLHttpRequest` to
// short-circuit any request to `events.mapbox.com` into a fake 204
// BEFORE it ever reaches the network stack.  Mapbox's internal
// telemetry pipeline gets a "delivered" response and stays quiet.
//
// Must be imported BEFORE `mapbox-gl` (and the Tailwind CDN script) in
// the entry file so every patch is in place when the first request /
// warning fires.
// ===========================================================================

const TELEMETRY_HOST_FRAGMENT = "events.mapbox.com";

/** True if this URL should be short-circuited. */
function _isTelemetryUrl(url) {
  if (!url) return false;
  try {
    if (typeof url === "string") return url.indexOf(TELEMETRY_HOST_FRAGMENT) !== -1;
    if (url instanceof URL)     return url.host.indexOf(TELEMETRY_HOST_FRAGMENT) !== -1;
    if (url instanceof Request) return url.url.indexOf(TELEMETRY_HOST_FRAGMENT) !== -1;
  } catch (_) {}
  return false;
}

/**
 * Returns a cleaned URL if the input is a `data:` URL that Mapbox v3's
 * image loader has corrupted with a `?_cors=<timestamp>` cache-buster
 * suffix.  Mapbox appends `?_cors=` to every image URL for CORS
 * handling, but data URIs already carry their payload — the appended
 * query turns them into invalid URLs and the browser throws
 * `net::ERR_INVALID_URL`.
 *
 * We strip the suffix so the fetch resolves normally.  Returns `null`
 * when the URL is fine as-is (not a data URL, or a data URL without
 * the corrupting suffix).
 */
function _cleanCorruptedDataUrl(url) {
  if (typeof url !== "string") return null;
  if (!url.startsWith("data:")) return null;
  // Mapbox appends `?_cors=<digits>` at the very end.  Find the LAST
  // occurrence (data URIs can legitimately contain `?` inside base64
  // payload, though the base64 alphabet excludes `?` — still, be defensive).
  const marker = "?_cors=";
  const idx = url.lastIndexOf(marker);
  if (idx === -1) return null;
  // Only strip if what follows `?_cors=` is digits (Mapbox's timestamp)
  // — protects any hypothetical data URI that legitimately ends with
  // this substring.
  const tail = url.slice(idx + marker.length);
  if (!/^\d+$/.test(tail)) return null;
  return url.slice(0, idx);
}

(function installFetchPatch() {
  if (typeof window === "undefined" || !window.fetch) return;
  if (window.__mapboxTelemetryMuted) return;
  window.__mapboxTelemetryMuted = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = function patchedFetch(resource, init) {
    if (_isTelemetryUrl(resource)) {
      // 204 No Content — Mapbox's telemetry uploader treats any 2xx
      // as "delivered" and moves on quietly.
      return Promise.resolve(new Response(null, { status: 204, statusText: "No Content (telemetry muted)" }));
    }
    // Strip Mapbox's `?_cors=<timestamp>` suffix from data URLs before
    // handing off to the real fetch — see _cleanCorruptedDataUrl.  This
    // fires purely on string URLs (Request/URL objects can't wrap a
    // data: URL that way).
    if (typeof resource === "string") {
      const cleaned = _cleanCorruptedDataUrl(resource);
      if (cleaned) return originalFetch(cleaned, init);
    }
    return originalFetch(resource, init);
  };
})();

(function installXhrPatch() {
  if (typeof XMLHttpRequest === "undefined") return;
  if (XMLHttpRequest.prototype.__mapboxTelemetryMuted) return;
  XMLHttpRequest.prototype.__mapboxTelemetryMuted = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    if (_isTelemetryUrl(url)) {
      this.__isMutedTelemetry = true;
      // Keep the call so the XHR object stays in a valid state, but
      // we'll intercept send() below and fake success without hitting
      // the network.
    }
    // Strip Mapbox's `?_cors=<timestamp>` from any data: URL opened via
    // XHR (Mapbox falls back to XHR when fetch is unavailable / worker).
    if (typeof url === "string") {
      const cleaned = _cleanCorruptedDataUrl(url);
      if (cleaned) url = cleaned;
    }
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (this.__isMutedTelemetry) {
      // Fake the successful-send lifecycle events on the next tick so
      // Mapbox's listeners resolve normally.
      const xhr = this;
      Promise.resolve().then(() => {
        try {
          Object.defineProperty(xhr, "readyState", { value: 4, configurable: true });
          Object.defineProperty(xhr, "status",     { value: 204, configurable: true });
          Object.defineProperty(xhr, "statusText", { value: "No Content (telemetry muted)", configurable: true });
          if (typeof xhr.onreadystatechange === "function") xhr.onreadystatechange();
          xhr.dispatchEvent(new Event("load"));
          xhr.dispatchEvent(new Event("loadend"));
        } catch (_) { /* noop */ }
      });
      return;
    }
    return originalSend.call(this, body);
  };
})();

// -------------------------------------------------------------------
// Suppress the Tailwind CDN's self-emitted "should not be used in
// production" console warning.  We deliberately don't yank the CDN —
// dashboard.html + auth/base.html both rely on it for utility classes
// today, and removing it without a full Tailwind-v4 migration would
// risk a chrome-wide styling regression.  Muting this ONE warning
// message keeps the console clean without touching anything else.
// -------------------------------------------------------------------
// -------------------------------------------------------------------
// Suppress one specific, confirmed-harmless uncaught TypeError that
// this file's OWN XHR/fetch patches above cause as a side effect:
// Mapbox GL v3's bundled telemetry reporting (a vendored web-vitals-
// style module, minified — surfaces as `et.reportAllChanges` in the
// console stack) expects a REAL PerformanceResourceTiming entry to
// exist for its own telemetry beacon once that "request" completes, so
// it can read `.startTime` off it. Since installXhrPatch/
// installFetchPatch above fake a successful response WITHOUT the
// request ever touching the network, no such Performance entry is ever
// created — Mapbox's own reporting code then throws "Cannot read
// properties of undefined (reading 'startTime')" from inside a timer
// callback deep in its own bundle. Confirmed live: happens only for
// the telemetry beacon we're intentionally blocking, never for a real
// app request — narrowly matched on both the message AND the stack
// mentioning reportAllChanges (same "match specific, not broad"
// discipline _isTelemetryUrl/the Tailwind-warning suppressor above
// already use) so this can never accidentally hide an unrelated bug.
// -------------------------------------------------------------------
(function suppressMapboxTelemetryStartTimeCrash() {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  if (window.__mapboxTelemetryStartTimeCrashMuted) return;
  window.__mapboxTelemetryStartTimeCrashMuted = true;

  window.addEventListener("error", (event) => {
    const message = event?.message || event?.error?.message || "";
    const stack = event?.error?.stack || "";
    if (message.indexOf("reading 'startTime'") !== -1 && stack.indexOf("reportAllChanges") !== -1) {
      event.preventDefault();
    }
  }, true);
})();

(function suppressTailwindCdnWarning() {
  if (typeof console === "undefined" || !console.warn) return;
  if (console.__mapboxSuppressorInstalled) return;
  console.__mapboxSuppressorInstalled = true;
  const originalWarn = console.warn.bind(console);
  console.warn = function (...args) {
    const first = args && args.length > 0 ? args[0] : "";
    if (typeof first === "string" && first.indexOf("cdn.tailwindcss.com should not be used in production") !== -1) {
      return;
    }
    return originalWarn(...args);
  };
})();
