// rainviewer-player.js
// RainViewer player that mirrors NCOP slider UI AND uses "visibility swap" (not only opacity)
// to reduce tile requests & avoid 429.
// NOW WITH INTEGRATED LEGEND SUPPORT

import { legends } from "./temporal-layer-legends.js";

const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";

const RV = {
    host: null,
    data: null,

    mode: "radar", // "radar" | "satellite"
    lockedMode: false,

    frames: [], // [{time, path, type, tileUrl, label}]
    index: 0,

    timer: null,
    playing: false,
    speedIndex: 0,
    speeds: [1, 2, 3],
    baseIntervalMs: 2000,

    map: null,

    ids: {
        layerPrefix: "rvplayer_layer",
        sourcePrefix: "rvplayer_source",
    },

    debounceTimer: null,
};

// ------------------------- fetch + helpers
function rvFetchSync() {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", RAINVIEWER_API, false);
    try { xhr.send(null); } catch (e) { console.error("RV fetch failed", e); return null; }
    if (xhr.status < 200 || xhr.status >= 300) { console.error("RV bad status", xhr.status); return null; }
    try { return JSON.parse(xhr.responseText); } catch (e) { console.error("RV parse failed", e); return null; }
}

function rvFormatPKT(unixSeconds) {
    const pktTime = new Date(unixSeconds * 1000 + 5 * 60 * 60 * 1000);
    const day = String(pktTime.getUTCDate()).padStart(2, "0");
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mon = MONTHS[pktTime.getUTCMonth()];
    const h = pktTime.getUTCHours();
    const m = pktTime.getUTCMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${mon} ${day} - ${String(h12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
}

function rvBuildTileUrl(host, path, type) {
    const size = 256;
    const tail = type === "radar" ? "2/1_1" : "0/0_0";
    // IMPORTANT: no ?t=... (keeps caching)
    return `${host}${path}/${size}/{z}/{x}/{y}/${tail}.png`;
}

function rvBuildFrames(data, mode) {
    const frames = [];

    if (mode === "radar") {
        const past = Array.isArray(data?.radar?.past) ? data.radar.past : [];
        const items = [...past].sort((a, b) => a.time - b.time);

        const stride = Math.max(1, Math.floor(items.length / 6)) || 1;
        for (let i = 0; i < items.length; i += stride) {
            const it = items[i];
            frames.push({
                time: it.time,
                path: it.path,
                type: "radar",
                tileUrl: rvBuildTileUrl(data.host, it.path, "radar"),
                label: rvFormatPKT(it.time),
            });
            if (frames.length >= 6) break;
        }
    } else {
        const ir = Array.isArray(data?.satellite?.infrared) ? data.satellite.infrared : [];
        const items = [...ir].sort((a, b) => a.time - b.time);

        const stride = Math.max(1, Math.floor(items.length / 6)) || 1;
        for (let i = 0; i < items.length; i += stride) {
            const it = items[i];
            frames.push({
                time: it.time,
                path: it.path,
                type: "satellite",
                tileUrl: rvBuildTileUrl(data.host, it.path, "satellite"),
                label: rvFormatPKT(it.time),
            });
            if (frames.length >= 6) break;
        }
    }

    return frames;
}

// ------------------------- map ids
function rvSourceId(mode, i) { return `${RV.ids.sourcePrefix}_${mode}_${i}`; }
function rvLayerId(mode, i) { return `${RV.ids.layerPrefix}_${mode}_${i}`; }

// ------------------------- map layer mgmt
function rvRemoveAllMapLayers() {
    const map = RV.map;
    if (!map) return;

    const modes = ["radar", "satellite"];
    for (const mode of modes) {
        for (let i = 0; i < 30; i++) {
            const lid = rvLayerId(mode, i);
            const sid = rvSourceId(mode, i);
            try { if (map.getLayer(lid)) map.removeLayer(lid); } catch { }
            try { if (map.getSource(sid)) map.removeSource(sid); } catch { }
        }
    }
}

function rvEnsureMapLayers() {
    const map = RV.map;
    if (!map || !RV.frames.length) return;

    // clear old mode layers, then add new
    rvRemoveAllMapLayers();

    const MAXZ = 10; // free limit; lower to 8 if still 429

    RV.frames.forEach((f, i) => {
        const sid = rvSourceId(RV.mode, i);
        const lid = rvLayerId(RV.mode, i);

        map.addSource(sid, {
            type: "raster",
            tiles: [f.tileUrl],
            tileSize: 256,
            maxzoom: MAXZ,
        });

        map.addLayer({
            id: lid,
            type: "raster",
            source: sid,
            layout: { visibility: i === RV.index ? "visible" : "none" },
            paint: {
                "raster-opacity": 1,
                "raster-fade-duration": 0,
            },
            minzoom: 0,
            maxzoom: MAXZ,
        });
    });
}

function rvSetVisibleIndex(index) {
    const map = RV.map;
    if (!map) return;

    for (let i = 0; i < RV.frames.length; i++) {
        const lid = rvLayerId(RV.mode, i);
        try {
            if (map.getLayer(lid)) {
                map.setLayoutProperty(lid, "visibility", i === index ? "visible" : "none");
                map.setPaintProperty(lid, "raster-opacity", 1);
                map.setPaintProperty(lid, "raster-fade-duration", 0);
            }
        } catch { }
    }
}

// ------------------------- Legend Management
function rvUpdateLegend() {
    const legendsContainer = document.getElementById("rv-legends");
    if (!legendsContainer) return;

    // Clear existing legends
    legendsContainer.innerHTML = "";

    // Get the appropriate legend based on current mode
    let legendHTML = "";

    if (RV.mode === "radar") {
        legendHTML = legends.rainviewerRadar || "";
    } else if (RV.mode === "satellite") {
        legendHTML = legends.rainviewerSatInfra || "";
    }

    if (!legendHTML) return;

    // Create the legend container with the improved structure
    const legendContainer = document.createElement("div");
    legendContainer.className = "rv-legend-container";
    // Create legend items (the gradient bar goes here)
    const itemsDiv = document.createElement("div");
    itemsDiv.className = "rv-legend-items";
    itemsDiv.style.gridTemplateColumns = "1fr"; // Single column for gradient bar
    itemsDiv.innerHTML = legendHTML;

    // Assemble the legend
    legendContainer.appendChild(itemsDiv);
    legendsContainer.appendChild(legendContainer);

    // Re-initialize Lucide icons
    try {
        if (window.lucide?.createIcons) {
            window.lucide.createIcons();
        }
    } catch (e) {
        console.warn("Lucide icons not available:", e);
    }
}

// ------------------------- UI
function rvUpdateTopLabel() {
    const labelEl = document.getElementById("rv_time_label");
    if (!labelEl || !RV.frames.length) return;
    const f = RV.frames[RV.index];
    const prefix = RV.mode === "radar" ? "Radar" : "Satellite IR";
    labelEl.textContent = `${prefix} — ${f.label}`;
}

function rvUpdateLabelsBar() {
    const el = document.getElementById("rvLabels1");
    if (!el) return;
    el.innerHTML = "";
    if (!RV.frames.length) return;

    const start = RV.frames[0];
    const mid = RV.frames[Math.floor((RV.frames.length - 1) / 2)];
    const end = RV.frames[RV.frames.length - 1];

    const mk = (txt) => {
        const s = document.createElement("span");
        s.textContent = txt;
        return s;
    };

    el.appendChild(mk(start.label));
    el.appendChild(mk(mid.label));
    el.appendChild(mk(end.label));
}

function rvUpdateSliderRange() {
    const slider = document.getElementById("rvSlider1");
    if (!slider) return;
    slider.min = "0";
    slider.max = String(Math.max(0, RV.frames.length - 1));
    slider.value = String(RV.index);
}

function rvApplyLockModeUI() {
    const modeBtn = document.getElementById("rvModeButton");
    if (!modeBtn) return;
    modeBtn.style.display = RV.lockedMode ? "none" : "inline-block";
}

// ------------------------- player actions
function rvSetIndex(idx) {
    if (!RV.frames.length) return;
    RV.index = Math.max(0, Math.min(RV.frames.length - 1, idx));
    rvSetVisibleIndex(RV.index);
    rvUpdateTopLabel();
    rvUpdateSliderRange();
}

function rvStep(delta) {
    if (!RV.frames.length) return;
    const next = (RV.index + delta + RV.frames.length) % RV.frames.length;
    rvSetIndex(next);
}

function rvPlay() {
    if (RV.playing) return;
    RV.playing = true;

    const playBtn = document.getElementById("rvPlayButton");
    const pauseBtn = document.getElementById("rvPauseButton");
    if (playBtn) playBtn.style.display = "none";
    if (pauseBtn) pauseBtn.style.display = "inline-block";

    const speed = RV.speeds[RV.speedIndex] || 1;
    const interval = Math.max(1200, Math.floor(RV.baseIntervalMs / speed));

    RV.timer = setInterval(() => rvStep(+1), interval);
}

function rvPause() {
    RV.playing = false;
    if (RV.timer) clearInterval(RV.timer);
    RV.timer = null;

    const playBtn = document.getElementById("rvPlayButton");
    const pauseBtn = document.getElementById("rvPauseButton");
    if (playBtn) playBtn.style.display = "inline-block";
    if (pauseBtn) pauseBtn.style.display = "none";
}

function rvBindDragResize(panelId, dragBtnId, resizeBtnId) {
    const panel = document.getElementById(panelId);
    const dragBtn = document.getElementById(dragBtnId);
    const resizeBtn = document.getElementById(resizeBtnId);
    if (!panel || !dragBtn || !resizeBtn) return;

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    dragBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = parseInt(window.getComputedStyle(panel).left) || 0;
        startTop = parseInt(window.getComputedStyle(panel).top) || 0;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    function onMove(e) {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        panel.style.left = startLeft + dx + "px";
        panel.style.top = startTop + dy + "px";
    }

    function onUp() {
        isDragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
    }

    let isResizing = false;
    let rsX = 0, rsY = 0, rsW = 0, rsH = 0;

    resizeBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        isResizing = true;
        rsX = e.clientX;
        rsY = e.clientY;
        rsW = panel.offsetWidth;
        rsH = panel.offsetHeight;
        document.addEventListener("mousemove", onResize);
        document.addEventListener("mouseup", onResizeUp);
    });

    function onResize(e) {
        if (!isResizing) return;
        const dx = e.clientX - rsX;
        const dy = e.clientY - rsY;
        panel.style.width = Math.max(220, rsW + dx) + "px";
        panel.style.height = Math.max(80, rsH + dy) + "px";
    }

    function onResizeUp() {
        isResizing = false;
        document.removeEventListener("mousemove", onResize);
        document.removeEventListener("mouseup", onResizeUp);
    }
}

function rvSetMode(mode) {
    RV.mode = mode === "satellite" ? "satellite" : "radar";

    const modeBtn = document.getElementById("rvModeButton");
    if (modeBtn) modeBtn.textContent = RV.mode === "radar" ? "Radar" : "Satellite";

    RV.frames = rvBuildFrames(RV.data, RV.mode);
    RV.index = 0;

    rvPause();
    rvEnsureMapLayers();
    rvUpdateLabelsBar();
    rvUpdateSliderRange();
    rvUpdateTopLabel();
    rvApplyLockModeUI();

    // ✅ UPDATE LEGEND WHEN MODE CHANGES
    rvUpdateLegend();
}

// ------------------------- Public API
export function showRainViewerPlayer(mode = "radar", lockMode = false) {
    const panel = document.getElementById("rv-slider1");
    const temp = document.getElementById("temp-slider1");
    if (temp) temp.style.display = "none";
    if (panel) panel.style.display = "block";

    RV.lockedMode = !!lockMode;
    window.__rvRequestedMode = mode;
    window.__rvLockMode = RV.lockedMode;

    // if already inited, apply immediately
    if (RV.map && RV.data) {
        rvSetMode(mode);
    }
}

export function hideRainViewerPlayer(map) {
    const panel = document.getElementById("rv-slider1");
    if (panel) panel.style.display = "none";
    rvPause();

    RV.map = map || RV.map;
    rvRemoveAllMapLayers();
}

export function initRainViewerPlayer(map) {
    RV.map = map;

    const data = rvFetchSync();
    if (!data?.host) {
        console.error("RainViewer: API unavailable");
        return;
    }
    RV.data = data;
    RV.host = data.host;

    rvBindDragResize("rv-slider1", "rvDragControlButton", "rvResizeControlButton");

    // speed
    const speedBtn = document.getElementById("rvSpeedButton");
    if (speedBtn) {
        // Update speed button to show current speed with text
        const speedText = speedBtn.querySelector('.rv-speed-text');
        if (speedText) {
            speedText.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
        } else {
            speedBtn.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
        }

        speedBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            RV.speedIndex = (RV.speedIndex + 1) % RV.speeds.length;

            // Update speed text
            const speedText = speedBtn.querySelector('.rv-speed-text');
            if (speedText) {
                speedText.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
            } else {
                speedBtn.textContent = (RV.speeds[RV.speedIndex] || 1) + "x";
            }

            if (RV.playing) { rvPause(); rvPlay(); }
        });
    }

    // mode toggle (will be hidden when locked)
    const modeBtn = document.getElementById("rvModeButton");
    if (modeBtn) {
        modeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (RV.lockedMode) return; // IMPORTANT: lock when opened from layer toggles
            rvSetMode(RV.mode === "radar" ? "satellite" : "radar");
        });
    }

    // play/pause
    document.getElementById("rvPlayButton")?.addEventListener("click", (e) => {
        e.stopPropagation();
        rvPlay();
    });
    document.getElementById("rvPauseButton")?.addEventListener("click", (e) => {
        e.stopPropagation();
        rvPause();
    });

    // slider (debounced)
    const slider = document.getElementById("rvSlider1");
    if (slider) {
        slider.addEventListener("input", (e) => {
            e.stopPropagation();
            rvPause();
            const val = parseInt(slider.value || "0", 10);
            if (RV.debounceTimer) clearTimeout(RV.debounceTimer);
            RV.debounceTimer = setTimeout(() => rvSetIndex(val), 120);
        });
    }

    // pause when moving map
    map.on("movestart", () => { if (RV.playing) rvPause(); });

    // apply requested/default mode (BUT DON'T ADD LAYERS YET)
    RV.lockedMode = !!window.__rvLockMode;
    const requested = window.__rvRequestedMode || "radar";

    // ✅ IMPORTANT: Only build frames, don't add layers until showRainViewerPlayer is called
    RV.frames = rvBuildFrames(RV.data, requested);
    RV.mode = requested;
    RV.index = 0;

    // Update UI elements but don't add map layers
    rvUpdateLabelsBar();
    rvUpdateSliderRange();
    rvUpdateTopLabel();
    rvApplyLockModeUI();

    try { window.lucide?.createIcons(); } catch { }
}