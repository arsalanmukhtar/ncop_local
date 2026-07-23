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
