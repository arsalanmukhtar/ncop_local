// story-report-export.js
// --------------------------------------------------------------------------
// "Export Report" for NCOP's cinematic briefings (Food Security & Agriculture
// Watch, National Flood Watch, National Air Quality Watch): PDF and Word.
//
// Architecture (after GCOP's Story Mode export, adapted to NCOP):
//   story  --(sections)-->  renderer  -->  PDF (browser print) | Word (.doc)
// A story never touches the output format; it only produces an array of
// plain "sections". Both renderers only know the section contract below.
//
// No new dependencies: the PDF is the browser's own print-to-PDF of the
// report page (correct Urdu shaping, fonts, CSS page breaks, table headers
// repeated on every page); Word is a single-file web archive (MHTML) with
// every image embedded as a JPEG part — the same proven approach as
// gefs-outlook-export.js.
//
// SECTION CONTRACT (every key optional; a renderer draws only what is present)
//   glance     {bottomLine, kpis, level, chapters:[{n,name,text}]}  page-1 summary
//   chapter    {n, name}                    chapter banner (new page)
//   heading    string                       plain section heading (References …)
//   subheading string                       scene heading
//   level      {label, color, steps?:[{label,color,on}]}  watch-level scale
//   callout    {tag, text, color?}          "bottom line" box
//   kpis       [{value, label}]             stat tiles (max 4 per row)
//   body       string                       plain prose (escaped by the renderer)
//   bullets    string[]                     plain bullet list
//   cards      [{title, text, source}]      research / reason cards
//   chart      {svg, title?, legend?}       inline SVG chart (rasterised to JPEG)
//   bars       {label, rows:[{name,value,n}]}  ranked list drawn as a bar infographic
//   image      {src|null, caption}          map capture; null = placeholder
//   table      {head: string[], rows: string[][]}
//   refs       string[]                     numbered reference list
//
// Optimisation: map captures wait for the map to finish loading, are
// downscaled BEFORE JPEG encoding (max 1400 px) and blank frames are
// replaced by a placeholder; charts are rasterised once; the print window
// is opened inside the click so pop-up blockers allow it.
// --------------------------------------------------------------------------

const STYLE_ID = "ncop-report-export-style";
const MAX_EDGE = 1400;
const JPEG_Q = 0.82;
const CHART_BG = "#151a22";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ==========================================================================
// Map capture
// ==========================================================================
/** Resolve once the map has finished loading what it shows (or after timeout). */
export function waitForMapIdle(map, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try {
      const ready = map.loaded?.() && (map.areTilesLoaded ? map.areTilesLoaded() : true);
      if (ready) setTimeout(finish, 60);
      else map.once?.("idle", finish);
    } catch (_) { setTimeout(finish, 300); }
    setTimeout(finish, timeoutMs);
  });
}
function _nextRender(map) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { map.once?.("render", finish); map.triggerRepaint?.(); } catch (_) {}
    setTimeout(finish, 500);
  });
}
// Rec. 709 luma on a tiny thumbnail: a flat image is a failed (blank) frame.
function _looksUsable(canvas) {
  try {
    const t = document.createElement("canvas");
    t.width = 48; t.height = 27;
    const ctx = t.getContext("2d");
    ctx.drawImage(canvas, 0, 0, t.width, t.height);
    const px = ctx.getImageData(0, 0, t.width, t.height).data;
    let sum = 0, sq = 0;
    const n = px.length / 4;
    for (let i = 0; i < px.length; i += 4) {
      const y = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      sum += y; sq += y * y;
    }
    const mean = sum / n;
    const variance = sq / n - mean * mean;
    return !(variance < 6 || mean < 3);
  } catch (_) {
    return true; // unreadable thumbnail: trust the capture
  }
}
/**
 * JPEG data URL of the map as currently shown, or null (blank / unreadable).
 * The frame is centre-cropped to 3:2 so every map in the report has the same
 * shape whatever the operator's window size (the stories fit Pakistan to the
 * centre of the map before capturing).
 */
export const MAP_ASPECT = 1.5;
export async function captureMap(map, { timeoutMs = 8000, settleMs = 0 } = {}) {
  if (!map?.getCanvas) return null;
  try {
    if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
    await waitForMapIdle(map, timeoutMs);
    await _nextRender(map);
    const src = map.getCanvas();
    if (!src?.width || !src?.height) return null;
    let sx = 0, sy = 0, sw = src.width, sh = src.height;
    if (sw / sh > MAP_ASPECT) { const nw = sh * MAP_ASPECT; sx = (sw - nw) / 2; sw = nw; }
    else { const nh = sw / MAP_ASPECT; sy = (sh - nh) / 2; sh = nh; }
    const scale = Math.min(1, MAX_EDGE / sw);
    const out = document.createElement("canvas");
    out.width = Math.max(2, Math.round(sw * scale));
    out.height = Math.max(2, Math.round(sh * scale));
    const ctx = out.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
    if (!_looksUsable(out)) return null;
    return out.toDataURL("image/jpeg", JPEG_Q);
  } catch (e) {
    console.warn("[report-export] map capture failed", e);
    return null;
  }
}

// ==========================================================================
// SVG chart -> JPEG (charts are drawn for the dark story popups, so they are
// rasterised onto the same dark panel colour and read as figure cards)
// ==========================================================================
export function svgToJpeg(svgText, { maxWidth = 1100, pad = 14 } = {}) {
  return new Promise((resolve) => {
    try {
      let s = String(svgText);
      // Size from the ROOT <svg> tag only (inner <rect width=…> must not leak in).
      const open = /<svg\b[^>]*>/i.exec(s)?.[0] || "<svg>";
      const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/i.exec(open);
      const w = Number(/\swidth="([\d.]+)(?:px)?"/.exec(open)?.[1] || vb?.[1] || 340);
      const h = Number(/\sheight="([\d.]+)(?:px)?"/.exec(open)?.[1] || vb?.[2] || 160);
      let tag = open;
      if (!/xmlns=/.test(tag)) tag = tag.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
      tag = tag.replace(/\s(width|height)="[^"]*"/g, "").replace("<svg", `<svg width="${w}" height="${h}"`);
      if (!/font-family=/.test(tag)) tag = tag.replace("<svg", '<svg font-family="Segoe UI, Arial, sans-serif"');
      s = s.replace(open, tag);
      const k = Math.max(1, maxWidth / (w + 2 * pad)); // ~3x for the stories' 340-px charts: crisp in print
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = Math.round((w + 2 * pad) * k); c.height = Math.round((h + 2 * pad) * k);
          const ctx = c.getContext("2d", { alpha: false });
          ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, pad * k, pad * k, w * k, h * k);
          resolve({ src: c.toDataURL("image/jpeg", 0.9), w: w + 2 * pad, h: h + 2 * pad });
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
    } catch (_) {
      resolve(null);
    }
  });
}

// ==========================================================================
// Popup HTML -> sections (generic extraction; works on every story's popups,
// whatever its class prefix — aqwp-, nfwp-, fswp- …)
// ==========================================================================
function _text(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}
// Text with a space between child nodes ("9.2" + <small>million</small> -> "9.2 million").
function _spaced(el) {
  if (!el) return "";
  return [...el.childNodes].map((n) => (n.textContent || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
}
// The label element that introduces a block (closest preceding sibling *p-label).
function _labelBefore(el) {
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    if (/p-label/.test(p.className || "")) return _text(p);
  }
  return "";
}
export function popupToSections(html) {
  if (!html) return [];
  try {
    return _extract(html);
  } catch (e) {
    console.warn("[report-export] popup extraction skipped", e); // one unreadable popup never fails a report
    return [];
  }
}
function _extract(html) {
  const out = [];
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body><div id="rx-root">${html}</div></body></html>`, "text/html");
  const root = doc.getElementById?.("rx-root") || doc.querySelector?.("#rx-root");
  if (!root) return out;
  const level = root.querySelector('[class$="p-level"] .is-on');
  if (level) {
    const steps = [...level.parentElement.children].map((x) => ({
      label: _text(x), color: x.style?.background || x.getAttribute("style")?.match(/background:\s*([^;]+)/)?.[1] || "#9ca3af", on: x === level,
    })).filter((x) => x.label);
    out.push({ level: { label: _text(level), color: level.style?.background || "#E67800", steps } });
  }
  const kpis = [...root.querySelectorAll('[class$="p-stat"]')].map((s) => ({
    value: _spaced(s.querySelector("b")), label: _text(s.querySelector("span")),
  })).filter((k) => k.value);
  if (kpis.length) out.push({ kpis });
  const brief = [...root.querySelectorAll('[class$="p-brief"] > div')].map((d) => {
    const b = d.querySelector("b");
    const label = _text(b);
    return label ? `${label}: ${_text(d).slice(label.length).trim()}` : _text(d);
  }).filter(Boolean);
  if (brief.length) out.push({ bullets: brief });
  for (const svg of root.querySelectorAll("svg")) {
    if (!/p-chart/.test(svg.getAttribute("class") || "")) continue;
    const legendEl = svg.nextElementSibling && /p-legend/.test(svg.nextElementSibling.className || "") ? svg.nextElementSibling : null;
    const legend = legendEl ? [...legendEl.children].map(_text).filter(Boolean).join(" · ") : "";
    out.push({ chart: { svg: svg.outerHTML, title: svg.getAttribute("aria-label") || "", legend } });
  }
  // Population-by-category stacks: their legend line, as text.
  for (const st of root.querySelectorAll('[class$="p-stack"]')) {
    const lg = st.nextElementSibling && /p-legend/.test(st.nextElementSibling.className || "") ? st.nextElementSibling : null;
    const items = lg ? [...lg.children].map(_spaced).filter(Boolean) : [];
    if (items.length) out.push({ body: `${_labelBefore(st) || "Breakdown"}: ${items.join(" · ")}.` });
  }
  // Horizontal bar lists -> bar infographic (or a table if values are not numeric).
  for (const hb of root.querySelectorAll('[class$="p-hbars"]')) {
    const rows = [...hb.querySelectorAll('[class$="p-hbar"]')].map((r) => {
      const value = _spaced(r.querySelector('[class$="p-hbar-value"]'));
      const m = /([-−+]?)\s?(\d[\d,]*(?:\.\d+)?)/.exec(value);
      const n = m ? Number(m[2].replace(/,/g, "")) * (m[1] && m[1] !== "+" ? -1 : 1) : NaN;
      return { name: _text(r.querySelector('[class$="p-hbar-label"]')), value, n, signed: !!m?.[1] };
    }).filter((r) => r.name);
    if (!rows.length) continue;
    const label = _labelBefore(hb) || "";
    if (rows.every((r) => Number.isFinite(r.n))) out.push({ bars: { label, rows } });
    else out.push({ table: { head: [label || "Item", "Value"], rows: rows.map((r) => [r.name, r.value]) } });
  }
  for (const t of root.querySelectorAll("table")) {
    const head = [...t.querySelectorAll("thead th")].map(_text);
    const rows = [...t.querySelectorAll("tbody tr")].map((tr) => [...tr.children].map((td) => _spaced(td) || _text(td)));
    if (rows.length) out.push({ table: { head, rows, title: _labelBefore(t) } });
  }
  const cards = [...root.querySelectorAll('[class$="p-why"]')].map((c) => ({
    title: _text(c.querySelector('[class$="p-why-head"]')),
    text: _text(c.querySelector('[class$="p-why-data"]')),
    source: _text(c.querySelector('[class$="p-why-research"]')),
  })).filter((c) => c.title);
  if (cards.length) out.push({ cards });
  const advice = root.querySelector('[class$="p-advice"]');
  if (advice && _text(advice)) out.push({ callout: { tag: "ACTION", text: _text(advice) } });
  const refs = [...root.querySelectorAll('[class$="p-refs-all"] li')].map(_text).filter(Boolean);
  if (refs.length) out.push({ refs });
  return out;
}

// ==========================================================================
// Renderer (one HTML document for both formats). Layout uses tables and
// solid colours only, so Word draws it as faithfully as the browser does.
// ==========================================================================
const NAVY = "#0b3d6e";
const CHAPTER_COLORS = ["#0b3d6e", "#0f766e", "#b45309", "#6d28d9", "#be123c", "#1d4ed8", "#4d7c0f"];
const _chColor = (n) => CHAPTER_COLORS[(Math.max(1, Number(n) || 1) - 1) % CHAPTER_COLORS.length];

// Only plain colour values ever reach a style attribute.
function _safeColor(c, fallback = "#6b7280") {
  const v = String(c || "").trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\([\d.,\s%]+\)$/i.test(v) ? v : fallback;
}
function _rgb(c) {
  const v = _safeColor(c, "#6b7280");
  if (v[0] === "#") {
    const h = v.length === 4 ? v.slice(1).split("").map((x) => x + x).join("") : v.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  return v.replace(/[^\d.,]/g, "").split(",").slice(0, 3).map(Number);
}
// Pale tint of a colour on white (Word has no opacity).
function _tint(c, t = 0.78) {
  const [r, g, b] = _rgb(c);
  const m = (x) => Math.round(x + (255 - x) * t);
  return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
}
// Text colour that reads on a given background.
function _ink(c) {
  const [r, g, b] = _rgb(c);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? "#111827" : "#ffffff";
}
function _firstSentences(text, max = 240) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const i = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return i > 60 ? cut.slice(0, i + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
}

const CSS = `
  @page { size: A4; margin: 13mm 12mm 15mm; @bottom-left { content: "NCOP · FOR OFFICIAL USE"; font: 7.5pt Arial; color: #6b7280; } @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Arial; color: #6b7280; } }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 10pt; color: #1f2937; margin: 0; line-height: 1.5; background: #fff; }
  p { margin: 3pt 0 6pt; }
  .block, .fig, .card, .kpis, .lvl, .bars, .scene-head { break-inside: avoid; page-break-inside: avoid; }

  /* cover */
  table.cover { width: 100%; border-collapse: collapse; }
  table.cover td { background: ${NAVY}; color: #fff; padding: 18pt 20pt 16pt; }
  .kicker { font-size: 7.5pt; letter-spacing: 1.6pt; text-transform: uppercase; color: #9cc3ea; font-weight: 700; }
  .cover h1 { font-size: 23pt; line-height: 1.15; margin: 5pt 0 4pt; color: #fff; }
  .cover .sub { font-size: 10.5pt; color: #d6e4f3; }
  .cover .cls { display: inline-block; margin-top: 8pt; padding: 2pt 8pt; border: 1px solid #9cc3ea; color: #9cc3ea; font-size: 7.5pt; font-weight: 700; letter-spacing: 1pt; }
  table.meta { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 0 12pt; }
  table.meta td { border: 1px solid #d5dbe3; border-top: 0; padding: 5pt 7pt; font-size: 9pt; background: #f4f7fb; }
  table.meta b { display: block; color: ${NAVY}; font-size: 7pt; text-transform: uppercase; letter-spacing: .6pt; }

  /* section titles */
  h2.sec { font-size: 13pt; color: ${NAVY}; margin: 14pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.5pt solid ${NAVY}; break-after: avoid; page-break-after: avoid; }
  .label { font-size: 7.5pt; font-weight: 800; letter-spacing: 1.2pt; text-transform: uppercase; color: #6b7280; margin: 10pt 0 4pt; }
  table.chapter { width: 100%; border-collapse: collapse; margin: 0 0 10pt; page-break-before: always; break-before: page; }
  table.chapter td { padding: 10pt 12pt; color: #fff; }
  table.chapter td.num { width: 58pt; text-align: center; font-size: 24pt; font-weight: 800; }
  table.chapter .k { font-size: 7.5pt; letter-spacing: 1.4pt; text-transform: uppercase; opacity: .85; }
  table.chapter .t { font-size: 16pt; font-weight: 800; }
  .scene-head { margin: 14pt 0 4pt; padding: 0 0 0 8pt; border-left: 4pt solid; font-size: 11.5pt; font-weight: 800; color: #111827; break-after: avoid; page-break-after: avoid; }
  .lead { font-size: 10pt; color: #1f2937; }

  /* bottom line + callouts */
  table.bl { width: 100%; border-collapse: collapse; margin: 4pt 0 10pt; }
  table.bl td { background: #fff7e6; border-left: 5pt solid #f59e0b; padding: 9pt 12pt; font-size: 11pt; line-height: 1.5; color: #1f2937; }
  table.bl .tag { display: block; font-size: 7.5pt; font-weight: 800; letter-spacing: 1.2pt; color: #b45309; margin-bottom: 2pt; }
  table.callout { width: 100%; border-collapse: collapse; margin: 6pt 0; }
  table.callout td { background: #eef6ff; border-left: 4pt solid #1d4ed8; padding: 7pt 10pt; }
  table.callout .tag { font-size: 7.5pt; font-weight: 800; letter-spacing: 1pt; color: #1d4ed8; margin-right: 6pt; }

  /* watch-level scale */
  table.lvl { width: 100%; border-collapse: separate; border-spacing: 3pt 0; table-layout: fixed; margin: 4pt 0 2pt; }
  table.lvl td { text-align: center; padding: 6pt 2pt; font-size: 8.5pt; font-weight: 700; }
  table.lvl td.on { font-size: 10.5pt; font-weight: 800; border: 2pt solid #111827; }
  .lvl-note { font-size: 8.5pt; color: #4b5563; margin: 2pt 0 8pt; }

  /* key figures */
  table.kpis { width: 100%; border-collapse: separate; border-spacing: 5pt 5pt; table-layout: fixed; margin: 0 -5pt 4pt; }
  table.kpis td { background: #f4f7fb; border-top: 3pt solid; padding: 6pt 8pt; vertical-align: top; }
  table.kpis .v { font-size: 14pt; font-weight: 800; color: #111827; line-height: 1.2; }
  table.kpis .l { font-size: 8pt; color: #4b5563; margin-top: 1pt; }

  /* chapter summary */
  table.sum { width: 100%; border-collapse: collapse; margin: 2pt 0 8pt; }
  table.sum td { padding: 5pt 7pt; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 9.5pt; }
  table.sum td.n { width: 26pt; text-align: center; font-weight: 800; color: #fff; }
  table.sum td.c { width: 120pt; font-weight: 700; color: #111827; }
  table.how { width: 100%; border-collapse: collapse; margin: 6pt 0; }
  table.how td { background: #f9fafb; border: 1px solid #e5e7eb; padding: 7pt 10pt; font-size: 8.8pt; color: #374151; }

  /* figures */
  .fig { margin: 6pt 0 10pt; text-align: center; }
  .fig img { width: 100%; height: auto; display: block; border: 1px solid #d5dbe3; }
  .fig.chart img { width: 82%; margin: 0 auto; border: 0; }
  .cap { font-size: 8.3pt; color: #4b5563; margin-top: 3pt; text-align: left; }
  .cap b { color: #111827; }
  .fig.chart .cap { width: 82%; margin: 3pt auto 0; }
  .ph { border: 1.5px dashed #9ca3af; color: #6b7280; padding: 34pt 10pt; text-align: center; font-size: 9pt; background: #f9fafb; }

  /* bar infographic */
  table.bars { width: 100%; border-collapse: collapse; margin: 3pt 0 8pt; font-size: 8.8pt; }
  table.bars td { padding: 2.5pt 4pt; vertical-align: middle; }
  table.bars td.nm { width: 34%; color: #111827; }
  table.bars td.vl { width: 22%; text-align: right; font-weight: 700; color: #111827; white-space: nowrap; }
  table.bar { width: 100%; border-collapse: collapse; }
  table.bar td { height: 9pt; padding: 0; }

  /* tables */
  table.t { width: 100%; border-collapse: collapse; margin: 3pt 0 8pt; font-size: 8.6pt; }
  table.t thead { display: table-header-group; }
  table.t th { background: ${NAVY}; color: #fff; text-align: left; padding: 4pt 6pt; font-weight: 700; }
  table.t td { border-bottom: 1px solid #e5e7eb; padding: 3.5pt 6pt; vertical-align: top; }
  table.t tr:nth-child(even) td { background: #f8fafc; }
  table.t tr { break-inside: avoid; page-break-inside: avoid; }

  ul { margin: 3pt 0 6pt 16pt; padding: 0; } li { margin: 2pt 0; }
  .card { border: 1px solid #e5e7eb; border-left: 4pt solid; padding: 6pt 9pt; margin: 5pt 0; background: #fcfcfd; }
  .card b { color: #111827; } .card .src { font-size: 8pt; color: #6b7280; font-style: italic; margin-top: 2pt; }
  table.gl { width: 100%; border-collapse: collapse; font-size: 8.8pt; }
  table.gl td { padding: 4pt 6pt; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  table.gl td.term { width: 30%; font-weight: 700; color: ${NAVY}; }
  ol.refs { font-size: 8.3pt; color: #374151; padding-left: 16pt; }
  .foot { margin-top: 16pt; border-top: 1px solid #d5dbe3; padding-top: 5pt; font-size: 8pt; color: #6b7280; }
`;

function _kpis(kpis, color) {
  const per = kpis.length === 4 || kpis.length > 6 ? 4 : Math.min(3, kpis.length);
  const rows = [];
  for (let i = 0; i < kpis.length; i += per) rows.push(kpis.slice(i, i + per));
  return rows.map((r) => `<table class="kpis"><tr>${r.map((k) => `<td style="border-top-color:${color}"><div class="v">${esc(k.value)}</div><div class="l">${esc(k.label)}</div></td>`).join("")}${
    "<td style=\"background:none;border:0\"></td>".repeat(per - r.length)}</tr></table>`).join("");
}
function _levelScale(level) {
  const steps = level.steps?.length ? level.steps : [{ label: level.label, color: level.color, on: true }];
  const cells = steps.map((st) => {
    const c = _safeColor(st.color);
    return st.on
      ? `<td class="on" style="background:${c};color:${_ink(c)}">${esc(st.label)}<br><span style="font-size:7pt;letter-spacing:1pt">▲ NOW</span></td>`
      : `<td style="background:${_tint(c)};color:#4b5563">${esc(st.label)}</td>`;
  }).join("");
  return `<table class="lvl"><tr>${cells}</tr></table>`;
}
// Ranked list as bars. Signed values (changes) are coloured by direction and
// sized by how big the change is; plain values by how large they are.
const FALL = "#c2410c", RISE = "#1d4ed8";
function _bars(b, color, n) {
  const signed = b.rows.some((r) => r.signed || r.n < 0);
  const max = Math.max(...b.rows.map((r) => Math.abs(r.n)), 0) || 1;
  const rows = b.rows.map((r) => {
    const pct = Math.max(1, Math.round((Math.abs(r.n) / max) * 100));
    const c = signed ? (r.n < 0 ? FALL : RISE) : color;
    return `<tr><td class="nm">${esc(r.name)}</td><td><table class="bar"><tr><td style="width:${pct}%;background:${c}"></td>${pct < 100 ? `<td style="width:${100 - pct}%;background:#eef1f5"></td>` : ""}</tr></table></td><td class="vl">${esc(r.value)}</td></tr>`;
  }).join("");
  const how = signed ? "longer bar = bigger change; orange = fall, blue = rise" : "longest bar = highest";
  return `<div class="bars"><div class="cap"><b>Figure ${n}.</b> ${esc(b.label || "Ranking")} (${how})</div><table class="bars">${rows}</table></div>`;
}

function _renderSections(sections) {
  const out = [];
  let fig = 0, tab = 0, color = NAVY, scene = "";
  for (const s of sections) {
    if (s.glance) out.push(_glance(s.glance));
    if (s.chapter) {
      color = _chColor(s.chapter.n);
      // Word ignores CSS breaks on tables; its own page-break <br> is inline, so browsers ignore it.
      out.push(`<br clear="all" style="mso-special-character:line-break;page-break-before:always">`);
      out.push(`<table class="chapter"><tr><td class="num" style="background:${color}">${esc(s.chapter.n)}</td><td style="background:${_tint(color, 0.15)}"><div class="k">Chapter ${esc(s.chapter.n)}</div><div class="t">${esc(s.chapter.name)}</div></td></tr></table>`);
    }
    if (s.heading) out.push(`<h2 class="sec">${esc(s.heading)}</h2>`);
    if (s.subheading) scene = s.subheading;
    if (s.subheading) out.push(`<div class="scene-head" style="border-left-color:${color}">${esc(s.subheading)}</div>`);
    if (s.level) out.push(`<div class="label">Watch level</div>${_levelScale(s.level)}`);
    if (s.callout) out.push(`<table class="callout block"><tr><td${s.callout.color ? ` style="border-left-color:${_safeColor(s.callout.color)}"` : ""}><span class="tag">${esc(s.callout.tag || "NOTE")}</span>${esc(s.callout.text)}</td></tr></table>`);
    if (s.body) out.push(`<p class="lead">${esc(s.body)}</p>`);
    if (s.kpis?.length) out.push(_kpis(s.kpis, color));
    if (s.bullets?.length) out.push(`<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`);
    if (s.image) {
      fig += 1;
      const cap = `<div class="cap"><b>Figure ${fig}.</b> ${esc(s.image.caption || "")}</div>`;
      out.push(s.image.src
        ? `<div class="fig"><img src="${s.image.src}" width="600" height="${Math.round(600 / MAP_ASPECT)}" alt="">${cap}</div>`
        : `<div class="fig"><div class="ph">Map view unavailable this cycle</div>${cap}</div>`);
    }
    if (s.chartImg) {
      fig += 1;
      const w = 500, h = Math.round((w * s.chartImg.h) / s.chartImg.w);
      const what = [s.chart?.title, s.chart?.legend ? `Key: ${s.chart.legend}` : ""].filter(Boolean).map(esc).join(". ");
      out.push(`<div class="fig chart"><img src="${s.chartImg.src}" width="${w}" height="${h}" alt="${esc(s.chart?.title || "")}"><div class="cap"><b>Figure ${fig}.</b> ${what}</div></div>`);
    }
    if (s.bars?.rows?.length) { fig += 1; out.push(_bars(s.bars, color, fig)); }
    if (s.table?.rows?.length) {
      tab += 1;
      out.push(`<div class="cap"><b>Table ${tab}.</b> ${esc(s.table.title || (scene ? `${scene} — details` : "Details"))}</div><table class="t">${s.table.head?.length ? `<thead><tr>${s.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : ""}<tbody>${
        s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    }
    if (s.cards?.length) out.push(s.cards.map((c) => `<div class="card" style="border-left-color:${color}"><b>${esc(c.title)}</b><div>${esc(c.text)}</div>${c.source ? `<div class="src">${esc(c.source)}</div>` : ""}</div>`).join(""));
    if (s.glossary?.length) out.push(`<table class="gl">${s.glossary.map((g) => `<tr><td class="term">${esc(g.term)}</td><td>${esc(g.def)}</td></tr>`).join("")}</table>`);
    if (s.refs?.length) out.push(`<ol class="refs">${s.refs.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>`);
  }
  return out.join("\n");
}

function _glance(g) {
  const out = [`<h2 class="sec">At a glance</h2>`];
  if (g.bottomLine) out.push(`<table class="bl block"><tr><td><span class="tag">BOTTOM LINE</span>${esc(g.bottomLine)}</td></tr></table>`);
  if (g.level) {
    out.push(`<div class="label">National watch level</div>${_levelScale(g.level)}`);
    out.push(`<div class="lvl-note">The highlighted box is today's level. Levels run from left (calm) to right (most serious).</div>`);
  }
  if (g.kpis?.length) out.push(`<div class="label">Key figures</div>${_kpis(g.kpis, NAVY)}`);
  if (g.chapters?.length) {
    out.push(`<div class="label">What each chapter says</div><table class="sum">${g.chapters.map((c) => {
      const col = _chColor(c.n);
      return `<tr><td class="n" style="background:${col}">${esc(c.n)}</td><td class="c">${esc(c.name)}</td><td>${esc(c.text)}</td></tr>`;
    }).join("")}</table>`);
  }
  if (g.howToRead) out.push(`<table class="how"><tr><td><b>How to read this report.</b> ${esc(g.howToRead)}</td></tr></table>`);
  return out.join("\n");
}

/** Rasterise every chart once (shared by both formats). */
export async function prepareSections(sections) {
  return _prepare(sections);
}
async function _prepare(sections) {
  for (const s of sections) {
    if (s.chart?.svg && !s.chartImg) s.chartImg = await svgToJpeg(s.chart.svg);
  }
  return sections;
}

const HOW_TO_READ = "Every chapter opens with a map, then short scenes. Each scene gives the message in plain words first, followed by the figures, charts and tables behind it. Colours follow the traffic-light rule: green is normal, yellow means watch, orange means warning and red means severe. Technical terms are explained in the glossary at the end.";

export function renderReportHtml(meta, sections) {
  const strip = (meta.strip || []).map((m) => `<td><b>${esc(m.label)}</b>${esc(m.value)}</td>`).join("");
  const body = sections.map((s) => (s.glance && !s.glance.howToRead ? { ...s, glance: { ...s.glance, howToRead: meta.howToRead || HOW_TO_READ } } : s));
  if (meta.glossary?.length) body.push({ heading: "Glossary — terms in plain words", glossary: meta.glossary });
  return `<!doctype html><html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">
<title>${esc(meta.title)}</title><style>${CSS}</style></head><body>
<table class="cover"><tr><td><div class="kicker">${esc(meta.kicker || "National Common Operating Picture · Situation briefing")}</div><h1>${esc(meta.title)}</h1><div class="sub">${esc(meta.subtitle || "")}</div><span class="cls">FOR OFFICIAL USE</span></td></tr></table>
${strip ? `<table class="meta"><tr>${strip}</tr></table>` : ""}
${_renderSections(body)}
<div class="foot">${esc(meta.footer || "")} Generated ${esc(new Date().toLocaleString("en-GB"))} from the live NCOP briefing. FOR OFFICIAL USE.</div>
</body></html>`;
}

// ==========================================================================
// Output
// ==========================================================================
function _b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const _wrap76 = (b64) => b64.replace(/.{76}/g, "$&\r\n");

/** Word: MHTML web archive; every data: image becomes a JPEG part. */
export function buildWordArchive(html) {
  const parts = [];
  const body = html.replace(/src="data:image\/(jpeg|png);base64,([^"]+)"/g, (_, type, data) => {
    const loc = `file:///C:/ncop-report/img${String(parts.length + 1).padStart(3, "0")}.${type === "png" ? "png" : "jpg"}`;
    parts.push({ loc, type, data });
    return `src="${loc}"`;
  });
  const B = "----=_NCOP_STORY_REPORT";
  let out = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="${B}"; type="text/html"\r\n\r\n`;
  out += `--${B}\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\nContent-Location: file:///C:/ncop-report/report.htm\r\n\r\n${_wrap76(_b64utf8(body))}\r\n`;
  for (const p of parts) out += `--${B}\r\nContent-Type: image/${p.type}\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${p.loc}\r\n\r\n${_wrap76(p.data)}\r\n`;
  return `${out}--${B}--\r\n`;
}

function _download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener"; a.style.display = "none";
  document.body.appendChild(a);
  a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
}

/** Open the print window synchronously inside the click (pop-up blockers). */
export function openPrintWindow() {
  let win = null;
  try { win = window.open("", "_blank", "width=1000,height=800"); } catch (_) {}
  try { win?.document.write(`<p style="font:14px Segoe UI,Arial;padding:24px">Preparing the briefing report…</p>`); } catch (_) {}
  return win;
}
function _print(html, win) {
  if (win && !win.closed) {
    win.document.open(); win.document.write(html); win.document.close();
    const go = () => { try { win.focus(); win.print(); } catch (_) {} };
    if (win.document.readyState === "complete") setTimeout(go, 300);
    else win.addEventListener("load", () => setTimeout(go, 300), { once: true });
    return;
  }
  const frame = document.createElement("iframe");
  Object.assign(frame.style, { position: "fixed", left: "-10000px", top: "-10000px", width: "0", height: "0" });
  document.body.appendChild(frame);
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  setTimeout(() => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) {} setTimeout(() => frame.remove(), 2000); }, 500);
}

export function reportFilename(slug, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `ncop-${slug}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

// ==========================================================================
// Progress checklist (inside the story card) + Export button / format menu
// ==========================================================================
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    .ncop-rx-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,0.08); color: #f3f4f6; border: 1px solid rgba(255,255,255,0.18); font: 700 11px/1 inherit; white-space: nowrap; }
    .ncop-rx-btn:hover { background: rgba(255,255,255,0.16); }
    .ncop-rx-btn:disabled { opacity: 0.5; cursor: progress; }
    .ncop-rx-wrap { position: relative; display: inline-flex; }
    .ncop-rx-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 30; min-width: 170px; padding: 4px;
      background: #111827; border: 1px solid rgba(255,255,255,0.16); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .ncop-rx-menu[hidden] { display: none; }
    .ncop-rx-menu button { display: block; width: 100%; text-align: left; padding: 6px 8px; border: 0; border-radius: 6px; background: none;
      color: #f3f4f6; font: 12px/1.3 inherit; cursor: pointer; }
    .ncop-rx-menu button:hover { background: rgba(255,255,255,0.1); }
    .ncop-rx-menu small { display: block; color: rgba(243,244,246,0.6); font-size: 10px; }
    .ncop-rx-progress { margin: 6px 0; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.12); font-size: 11px; color: #e5e7eb; }
    .ncop-rx-progress b { display: block; margin-bottom: 4px; font-size: 11.5px; }
    .ncop-rx-row { display: flex; align-items: center; gap: 6px; padding: 1.5px 0; color: rgba(229,231,235,0.7); }
    .ncop-rx-row i { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,0.35); flex: none; }
    .ncop-rx-row.is-run { color: #fff; } .ncop-rx-row.is-run i { border-color: #f59e0b; border-top-color: transparent; animation: ncop-rx-spin 0.8s linear infinite; }
    .ncop-rx-row.is-ok i { background: #22c55e; border-color: #22c55e; }
    .ncop-rx-row.is-warn i { background: #f59e0b; border-color: #f59e0b; }
    .ncop-rx-row.is-fail { color: #fca5a5; } .ncop-rx-row.is-fail i { background: #ef4444; border-color: #ef4444; }
    @keyframes ncop-rx-spin { to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(s);
}

function _progress(card, title, steps) {
  _injectStyles();
  card.querySelector(".ncop-rx-progress")?.remove();
  const box = document.createElement("div");
  box.className = "ncop-rx-progress";
  box.setAttribute("role", "status");
  box.innerHTML = `<b>${esc(title)}</b>${steps.map((s) => `<div class="ncop-rx-row" data-rx="${esc(s.key)}"><i></i><span>${esc(s.label)}</span></div>`).join("")}`;
  const anchor = card.querySelector('[class$="-chapter-head"]') || card.firstElementChild;
  anchor?.insertAdjacentElement("afterend", box);
  const row = (key) => box.querySelector(`[data-rx="${CSS.escape ? CSS.escape(key) : key}"]`);
  return {
    run(key) { row(key)?.classList.add("is-run"); },
    mark(key, state = "ok") { const r = row(key); if (r) { r.classList.remove("is-run"); r.classList.add(`is-${state}`); } },
    close(delayMs = 2500) { setTimeout(() => box.remove(), delayMs); },
    fail(msg) { box.insertAdjacentHTML("beforeend", `<div class="ncop-rx-row is-fail"><i></i><span>${esc(msg)}</span></div>`); },
  };
}

/**
 * Add an "Export" button with a PDF / Word menu to a story card's header.
 * onExport(format, printWindow) runs the export; the print window is opened
 * here, synchronously inside the click.
 */
export function mountExportButton(card, onExport) {
  _injectStyles();
  if (!card || card.querySelector(".ncop-rx-wrap")) return;
  const actions = card.querySelector('[class$="-head-actions"]');
  if (!actions) return;
  const wrap = document.createElement("span");
  wrap.className = "ncop-rx-wrap";
  wrap.innerHTML = `<button type="button" class="ncop-rx-btn" title="Export this briefing as a report (works without playing it first)">📄 Export</button>
    <div class="ncop-rx-menu" role="menu" hidden>
      <button type="button" data-rx-format="pdf" role="menuitem">PDF<small>print dialog · choose "Save as PDF"</small></button>
      <button type="button" data-rx-format="word" role="menuitem">Word<small>.doc with maps & charts</small></button>
    </div>`;
  actions.insertBefore(wrap, actions.firstChild);
  const btn = wrap.querySelector(".ncop-rx-btn");
  const menu = wrap.querySelector(".ncop-rx-menu");
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (!btn.disabled) menu.hidden = !menu.hidden; });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
  menu.addEventListener("click", (e) => {
    const f = e.target.closest("[data-rx-format]")?.dataset.rxFormat;
    if (!f) return;
    e.stopPropagation();
    menu.hidden = true;
    const win = f === "pdf" ? openPrintWindow() : null;
    btn.disabled = true;
    Promise.resolve(onExport(f, win)).finally(() => { btn.disabled = false; });
  });
}

/**
 * Orchestrate one export. `build({run, mark})` returns sections (and is
 * responsible for restoring the map in its own finally). Never throws.
 */
let _running = 0;
/** True while any story's report is being built (guards the picker's Export). */
export const exportInProgress = () => _running > 0;

export async function runStoryExport({ format, win, card, meta, slug, steps, build }) {
  _running += 1;
  try { return await _runStoryExport({ format, win, card, meta, slug, steps, build }); } finally { _running -= 1; }
}

async function _runStoryExport({ format, win, card, meta, slug, steps, build }) {
  const allSteps = [...steps, { key: "compile", label: "Compiling report" }, { key: "output", label: format === "pdf" ? "Opening print dialog" : "Downloading Word file" }];
  const pr = _progress(card, `Exporting ${format === "pdf" ? "PDF" : "Word"} report`, allSteps);
  try {
    const sections = await build({ run: pr.run, mark: pr.mark });
    if (typeof globalThis.__ncopReportSink === "function") globalThis.__ncopReportSink(meta, sections); // test hook (unset in the app)
    pr.run("compile");
    await _prepare(sections);
    const html = renderReportHtml(meta, sections);
    pr.mark("compile");
    pr.run("output");
    if (format === "pdf") _print(html, win);
    else _download(buildWordArchive(html), "application/msword", reportFilename(slug, "doc"));
    pr.mark("output");
    pr.close();
    return true;
  } catch (e) {
    console.error("[report-export] export failed", e);
    pr.fail("Could not generate the report. Please try again.");
    try { if (win && !win.closed) win.close(); } catch (_) {}
    pr.close(6000);
    return false;
  }
}

// ==========================================================================
// Scenes -> sections (shared by every story)
// ==========================================================================
/**
 * scenes:       the story's own scene list (captions are the narration)
 * chapterNames: {n: name}
 * titleOf:      scene -> title (the story's _sceneTitle)
 * popupOf:      scene -> popup HTML (the story's own popup, captured)
 * shots:        {chapter: [{src|null, caption}]} map captures per chapter
 * glanceKinds:  scene kinds whose first two key figures lead page 1's tiles
 */
export function scenesToSections({ scenes, chapterNames, titleOf, popupOf, shots = {}, glanceKinds = [] }) {
  const sections = [];
  const refs = [];
  const intro = scenes[0];
  const items = new Map(scenes.map((sc) => [sc, popupToSections(popupOf(sc))]));
  // Page 1: bottom line, the (final) watch level, key figures, chapter messages.
  let level = null;
  for (const sc of scenes) for (const it of items.get(sc)) if (it.level) level = it.level;
  const chapters = [];
  for (const sc of scenes) {
    if (sc === intro || chapters.some((c) => c.n === sc.chapter)) continue;
    chapters.push({ n: sc.chapter, name: chapterNames[sc.chapter] || "", text: _firstSentences(String(sc.caption || "").replace(/^Chapter \d+\s*[:.—-]\s*/i, "")) });
  }
  sections.push({ glance: {
    bottomLine: intro?.caption || "",
    level,
    kpis: [
      ...glanceKinds.flatMap((k) => {
        const sc = scenes.find((x) => x.kind === k);
        return sc ? items.get(sc).flatMap((it) => it.kpis || []).slice(0, 2) : [];
      }),
      ...(intro ? items.get(intro) : []).flatMap((it) => it.kpis || []),
    ].slice(0, 8),
    chapters,
  } });
  let ch = null;
  for (const sc of scenes) {
    if (sc === intro) continue;
    if (sc.chapter !== ch) {
      ch = sc.chapter;
      sections.push({ chapter: { n: ch, name: chapterNames[ch] || "" } });
      for (const shot of shots[ch] || []) sections.push({ image: shot });
    }
    const title = String(titleOf(sc) || "");
    sections.push({ subheading: /^Chapter \d/.test(title) ? "Chapter overview" : title, body: sc.caption });
    for (const it of items.get(sc)) {
      if (it.refs) { refs.push(...it.refs); continue; }
      sections.push(it);
    }
  }
  if (refs.length) sections.push({ heading: "References", refs: [...new Set(refs)] });
  return sections;
}

/** Short notice in the card (e.g. data still loading). */
export function notifyCard(card, text, ms = 3500) {
  if (!card) return;
  const p = _progress(card, text, []);
  p.close(ms);
}
