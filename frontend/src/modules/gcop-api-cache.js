// gcop-api-cache.js
// ---------------------------------------------------------------------------
// Minimal in-browser cache for GCOP PMD / FFD REST endpoints.
//
// Two guarantees:
//   1. TTL cache — a URL fetched within its TTL window is served from
//      memory, no network round-trip, no server hit.  Server-side cache
//      windows are documented in GCOP_PMD_API_Integration.md (per-endpoint).
//   2. In-flight coalescing — if a fetch is already pending for a URL,
//      concurrent callers share the same Promise.  Prevents the "layer
//      toggled twice in a row triggers two parallel fetches" thrash.
//
// This module is deliberately dependency-free and side-effect free (the
// cache Maps are the only mutable state).  Import it anywhere in the
// frontend that needs a GCOP endpoint's payload.
// ---------------------------------------------------------------------------

export const GCOP_BASE_URL = "http://172.18.7.21:8000";

// Per-key cache entries: { data, expiresAt } (ms epoch)
const _cache = new Map();
// Per-key pending fetches — resolves with the same shape as _cache.data
const _pending = new Map();

/**
 * Fetch JSON from a GCOP endpoint, honouring a TTL cache.  Concurrent
 * callers for the same URL share the same in-flight Promise.
 *
 * @param {string} url         Fully-qualified URL (helpers below prepend GCOP_BASE_URL)
 * @param {number} ttlSeconds  Cache lifetime in seconds; matches upstream server cache
 * @returns {Promise<any>}     Parsed JSON payload
 */
// Gateway status codes that mean "upstream isn't responding right now" —
// almost always transient on the GCOP box (slow warm-up, upstream PMD
// scraper timing out on a cold cache).  A short retry with exponential
// backoff catches these without any backend change.
const _RETRYABLE_STATUSES = new Set([502, 503, 504]);
const _MAX_RETRIES        = 3;      // 3 total tries: initial + 2 retries
const _BACKOFF_BASE_MS    = 600;    // 600ms, then 1800ms

// Explicit Accept header keeps the request looking like a browser-issued
// JSON call instead of the fetch default `*/*` — some intranet reverse
// proxies (nginx WAFs, cloud LBs) refuse `*/*` from cross-origin XHR
// with a 502 while accepting the same URL from top-level navigation.
const _FETCH_HEADERS = { Accept: "application/json" };

async function _fetchWithRetry(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < _MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = _BACKOFF_BASE_MS * Math.pow(3, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const resp = await fetch(url, {
        credentials: "omit",
        headers: _FETCH_HEADERS,
      });
      if (resp.ok) return resp;
      if (!_RETRYABLE_STATUSES.has(resp.status)) {
        // 4xx or non-gateway 5xx — retry won't help, fail fast.
        throw new Error(`GCOP fetch ${url}: HTTP ${resp.status}`);
      }
      lastErr = new Error(`GCOP fetch ${url}: HTTP ${resp.status}`);
      // fall through to next retry iteration
    } catch (err) {
      // Network-level failure (server unreachable, DNS, TLS).  Retry
      // once or twice — sometimes the first hit primes the connection.
      lastErr = err;
    }
  }
  throw lastErr || new Error(`GCOP fetch ${url}: exhausted retries`);
}

export async function fetchGcopCached(url, ttlSeconds = 300) {
  const now = Date.now();
  const cached = _cache.get(url);
  if (cached && cached.expiresAt > now) return cached.data;

  const inflight = _pending.get(url);
  if (inflight) return inflight;

  const promise = (async () => {
    try {
      const resp = await _fetchWithRetry(url);
      const data = await resp.json();
      _cache.set(url, { data, expiresAt: Date.now() + ttlSeconds * 1000 });
      return data;
    } finally {
      _pending.delete(url);
    }
  })();
  _pending.set(url, promise);
  return promise;
}

/**
 * Convenience: FFD waterlevels (§2.1 in the integration doc).  Server
 * caches ~5 min so we mirror that TTL here.
 */
export function getFfdWaterlevels() {
  return fetchGcopCached(`${GCOP_BASE_URL}/get-ffd-waterlevels/`, 300);
}

/**
 * Convenience: FFD river-basin outline polygons (§2.2 in the integration
 * doc).  Static geometry — server marks it long-lived cache; we mirror
 * with a 24-hour TTL so subsequent toggles never re-fetch.
 */
export function getFfdRivers() {
  return fetchGcopCached(`${GCOP_BASE_URL}/get-ffd-rivers/`, 86400);
}

/**
 * Convenience: PMD Monitor stations feed (§3.1 in the integration doc).
 * SYNOP / METAR / AWS / FloodAWS network-wide, ~250–280 features.
 * Server caches ~5 min; we mirror the TTL.
 */
export function getPmdStations() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/stations/`, 300);
}

// ---------------------------------------------------------------------------
// FFD — remaining endpoints
// ---------------------------------------------------------------------------

/** §2.3 — Flood bulletins / advisories index (PDF links). Server caches 4h. */
export function getFfdBulletins() {
  return fetchGcopCached(`${GCOP_BASE_URL}/get-ffd-bulletins/`, 14400);
}

// ---------------------------------------------------------------------------
// PMD Monitor — remaining endpoints
// ---------------------------------------------------------------------------

/** §3.2 — Per-station time-series.  Cache keyed by (code, days, dataType). */
export function getPmdStationHistory(code, days = 7, dataType = "synop") {
  const q = new URLSearchParams({ code: String(code), days: String(days), data_type: dataType });
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/station-history/?${q}`, 300);
}

/** §3.3 — Early-warning polygons (blue/yellow/orange/red).  Server caches 2m. */
export function getPmdWarnings() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/warnings/`, 120);
}

/** §3.4 — Monsoon-specific warnings.  Server caches 5m. */
export function getPmdMonsoon(warningOnly = false) {
  const suffix = warningOnly ? "?warning_only=true" : "";
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/monsoon/${suffix}`, 300);
}

/** §3.5 — GLOF observations (~250 stations).  Server caches 2m. */
export function getPmdGlofObs() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/glof-obs/`, 120);
}

/** §3.6 — Recent lightning strikes.  Server caches 3m; `hours` in [1,48]. */
export function getPmdLightning(hours = 1) {
  const h = Math.max(1, Math.min(48, Number(hours) || 1));
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/lightning/?hours=${h}`, 180);
}

/** §3.7 — 12-period city forecast.  Server caches 30m. */
export function getPmdCityForecast() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/city-forecast/`, 1800);
}

/** §3.9 — Static glacier lake inventory (2018–2021).  Server caches 24h. */
export function getPmdGlacierLakes() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/monitor/glacier-lakes/`, 86400);
}

/** §3.10 — PMD public daily-forecast + press-release passthrough. 30m cache. */
export function getPmdPublicForecast() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/public-forecast/`, 1800);
}

// ---------------------------------------------------------------------------
// PMD NWFC — every stable endpoint
// ---------------------------------------------------------------------------

/** §4.1 — NWFC station observations (second-opinion vs §3.1). */
export function getNwfcObservations() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/observations/`, 300);
}

/** §4.2 — Daily city forecast (NWFC).  Server caches 6h. */
export function getNwfcForecast() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/forecast/`, 21600);
}

/** §4.3 — Rainfall + press-release PDF index.  Server caches 4h. */
export function getNwfcReports() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/reports/`, 14400);
}

/** §4.4 — Multi-day narrative weather outlook (prose per day). */
export function getNwfcWeeklyOutlook() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/weekly-outlook/`, 3600);
}

/**
 * §4.5 — Extract plain text from a PMD NWFC press-release PDF.
 * `url` must start with `https://weather.gov.pk/` (server enforces).
 * Cache keyed per URL, 1h TTL.
 */
export function getNwfcPressReleaseText(url) {
  if (!url) return Promise.resolve({ error: "url is required" });
  const q = `?url=${encodeURIComponent(url)}`;
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/press-release-text/${q}`, 3600);
}

/** §4.6 — Historical record maximum temperatures per station.  24h cache. */
export function getNwfcMaxTemperatures() {
  return fetchGcopCached(`${GCOP_BASE_URL}/api/pmd/nwfc/max-temperatures/`, 86400);
}

/**
 * Manual cache invalidation for a single URL (used by an admin/debug
 * escape hatch — not called during normal operation).
 */
export function invalidateGcopCache(url) {
  _cache.delete(url);
}