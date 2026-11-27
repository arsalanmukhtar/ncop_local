// MapControls.js
import { openPrintWindow, exportInProgress } from "./story-report-export.js";

/**
 * Handles the Mapbox map instance and core map interactions (labels, projection, terrain).
 */
export class MapControls {
    #map;

    constructor(mapInstance) {
        this.#map = mapInstance;
    }

    /**
     * Toggles the visibility of symbol layers, typically used for map labels.
     * @param {boolean} enabled - True to show labels, false to hide.
     */
    toggleMapLabels(enabled) {
        const style = this.#map.getStyle();
        if (style && style.layers) {
            style.layers.forEach((layer) => {
                // Target symbol layers with a text-field property
                if (
                    layer.type === "symbol" &&
                    layer.layout &&
                    layer.layout["text-field"]
                ) {
                    this.#map.setLayoutProperty(
                        layer.id,
                        "visibility",
                        enabled ? "visible" : "none"
                    );
                }
            });
        }
        // console.log(`🗺️ Map labels toggled: ${enabled ? "visible" : "none"}`);
    }

    /**
     * Changes the map's projection and saves the preference.
     * @param {string} projectionName - The Mapbox GL JS projection name.
     */
    changeMapProjection(projectionName) {
        try {
            this.#map.setProjection(projectionName);
        } catch (error) {
            console.error("Error changing projection:", error);
            this.#map.setProjection("mercator");
        }
    }

    /**
     * Adds Mapbox GL JS DEM source and enables 3D terrain.
     */
    enableTerrain() {
        // console.log("🏔️ Enabling 3D Terrain mode...");
        const DEM_SOURCE_ID = "mapbox-dem";

        if (!this.#map.getSource(DEM_SOURCE_ID)) {
            try {
                this.#map.addSource(DEM_SOURCE_ID, {
                    type: "raster-dem",
                    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
                    tileSize: 512,
                    maxzoom: 14,
                });
            } catch (error) {
                console.warn("Error adding terrain source:", error);
            }
        }

        try {
            this.#map.setTerrain({ source: DEM_SOURCE_ID, exaggeration: 1.5 });
        } catch (error) {
            console.warn("Error setting terrain:", error);
        }

        this.#map.easeTo({
            pitch: 80,
            bearing: -17.6,
            duration: 1000,
        });
    }

    /**
     * Removes 3D terrain and returns to 2D view.
     */
    disableTerrain() {
        // console.log("🗺️ Switching to 2D mode...");

        try {
            this.#map.setTerrain(null);
        } catch (error) {
            console.warn("Error removing terrain:", error);
        }

        setTimeout(() => {
            try {
                if (this.#map.getSource("mapbox-dem")) {
                    this.#map.removeSource("mapbox-dem");
                }
            } catch (error) {
                console.warn("Error removing terrain source:", error);
            }
        }, 200);

        this.#map.easeTo({
            pitch: 0,
            bearing: 0,
            duration: 1000,
        });

        setTimeout(() => {
            try {
                this.#map.setProjection("mercator");
            } catch (error) {
                console.warn("Error setting projection:", error);
                this.#map.setProjection("mercator");
            }
        }, 1200);
    }
}

// --- StoryManager: minimal, non-invasive story runner/editor ---
export class StoryManager {
  constructor({ map, sourceLayerControl, storyRoot, fetchBase = "" }) {
    this.map = map; // window.ncop_map
    this.slc = sourceLayerControl; // instance of SourceLayerControl
    this.root = storyRoot; // DOM node (#story-root)
    this.fetchBase = fetchBase; // Django base ('' = same origin)
    this.state = {
      isPlaying: false,
      currentStory: null,
      currentIndex: 0,
      stories: [],
      temporalActiveKey: null,
      activeLayerKeys: new Set(),
    };
    this._renderShell();
    this._bind();
    this.loadStories(); // 🔴 this is the method you were missing
  }

  // ---------- server I/O ----------
  async loadStories() {
    try {
      // prefer full objects so the dropdown can show titles
      const r = await fetch(`${this.fetchBase}/stories/?full=1`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      let arr = [];
      if (Array.isArray(data)) {
        arr = data;
      } else if (Array.isArray(data.stories)) {
        arr = data.stories.map((slug) => ({
          id: slug,
          title: slug,
          chapters: [],
        }));
      } else {
        arr = Object.entries(data).map(([slug, obj]) => ({
          id: slug,
          title: obj?.title || slug,
          ...obj,
        }));
      }

      this.state.stories = arr;
      this._renderList();
    } catch (e) {
      console.error("Failed to load stories:", e);
      this._renderList();
    }
  }

  async saveStory(payload) {
    const method = payload?.id ? "PUT" : "POST";
    const url = payload?.id
      ? `${this.fetchBase}/stories/${payload.id}/`
      : `${this.fetchBase}/stories/`;
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saved = await res.json();
    await this.loadStories();
    return saved;
  }

  // ---------- UI ----------
  _renderShell() {
    if (!this.root) return;
    this.root.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
        <select id="storySelect" style="flex:1; padding:6px 8px;border:1px solid #444;background:#101014;color:#eee;border-radius:8px"></select>
        <button id="storyEdit" class="custom-nav-btn" title="Edit Story"><i data-lucide="pencil"></i></button>
      </div>
      <div id="storyMeta" style="font-size:12px;opacity:.9;margin-bottom:6px;"></div>
      <!-- report export: outside #storyChapters so it stays when a story hides the briefs -->
      <div id="storyExport" style="margin-bottom:8px;"></div>
      <!-- scrollable chapter list -->
      <div id="storyChapters" style="display:grid;gap:8px;max-height:50vh;overflow-y:auto;padding-right:4px;"></div>
      <div id="storyEditor" style="display:none;border-top:1px solid #2a2a2a;margin-top:10px;padding-top:10px"></div>
    `;
    if (window.lucide?.createIcons) window.lucide.createIcons();
    // The story briefs belong to "nothing picked" only: whenever any story
    // card is on screen they are hidden, whichever path showed the card
    // (picker, brief card, panel reopen). The export bar stays.
    if (!document.getElementById("ncop-story-picker-style")) {
      const st = document.createElement("style");
      st.id = "ncop-story-picker-style";
      const cards = ["ncop-provincial-forecast", "ncop-dynamic-weather-forecast", "ncop-air-quality-watch", "ncop-flood-watch", "ncop-food-security-watch"]
        .map((id) => `#${id}:not([style*="display: none"])`).join(", ");
      st.textContent = `#story-root:has(${cards}) .ncop-story-picker { display: none !important; }`;
      document.head.appendChild(st);
    }
  }

  // Placeholder/demo content (Glacier National Park, Pakistan Hydrological
  // Risk, Current Monsoon Condition) — kept in the backend catalog and
  // still fully loadable by id/editor, just no longer offered as picks
  // in the operational picker so it only lists the real cinematic
  // briefings (Dynamic Weather Report, 7-Day Weather Outlook — the
  // latter injected separately by story-provincial-forecast.js, same
  // pattern as Dynamic Weather Report's own injection).
  // One-line summaries of the cinematic briefings (each injected into
  // #storySelect by its own story-*.js module), shown when nothing is picked.
  static BRIEFINGS = [
    {
      value: "__provincial_forecast__", icon: "🗓️", title: "7-Day Weather Outlook", theme: "Weather", color: "#46b2ff",
      basis: "Province-by-province outlook for the coming week, with active PMD hazard warnings.",
      data: "NWFC weekly outlook · PMD warnings (polygons).",
      shows: "Each province's day-wise forecast and the warning areas affecting it.",
    },
    {
      value: "__dynamic_weather__", icon: "🌦️", title: "Dynamic Weather Report", theme: "Weather", color: "#38bdf8",
      basis: "What the weather did in the last 24 hours and what comes next.",
      data: "NWFC daily rainfall report & station observations · DWD satellite IR · 2m temperature · Heatwave Monitoring · Meteoblue precipitation.",
      shows: "Heaviest-rain districts, hottest stations, 8-day temperature and 24h precipitation outlook by province.",
    },
    {
      value: "__air_quality_watch__", icon: "🌫️", title: "National Air Quality Watch", theme: "Air quality", color: "#a78bfa",
      basis: "How unhealthy the air is: the AQI over the past week, right now, and the coming days, with the PM2.5 evidence behind it.",
      data: "Hawanama (PAQI) PM2.5 estimate, stations & forecast · WAQI stations · Open-Meteo weather · VIIRS crop fires.",
      shows: "AQI by day and city, why the air is bad (weather, crop burning, emissions), an AQI outlook and health advice.",
    },
    {
      value: "__flood_watch__", icon: "🌊", title: "National Flood Watch", theme: "Floods", color: "#14b8a6",
      basis: "How close the rivers are to flooding, what may come next, who could be affected, and what to do.",
      data: "FFD readings, limits, bulletins and dam levels (main source) · NCOP river outlook tested on 2016–2026 · GPM, SMAP, GFS, ECMWF · GloFAS & Google Flood Hub · NCOP flood extents 2010–2025.",
      shows: "Station and district levels, dam storage, a 3-day river outlook with its skill, people on land that floods, and actions with owners.",
    },
    {
      value: "__food_security_watch__", icon: "🌾", title: "National Food Security & Agriculture Watch", theme: "Food security", color: "#f59e0b",
      basis: "Which districts are at Watch, Warning or Alert, why, what may come next, and what to do.",
      data: "IPC · FEWS NET · WFP prices (5 cities) · PBS and USDA crops · CHIRPS rain, NASA soil moisture and MODIS crops · NOAA El Niño · ACLED · World Bank/FAO · bias-corrected GEFS.",
      shows: "District warning levels, hunger counts with their dates, wheat supply, prices & wages, water, a tested flour outlook, past performance and actions with owners.",
    },
  ];

  static HIDDEN_STORY_IDS = new Set(["demostory", "hydrological", "meteorological"]);

  // Briefings that can be exported straight from the picker (story value ->
  // the module's window hook exposing exportReport(format, win)).
  static EXPORT_HOOKS = {
    __provincial_forecast__: "ncopProvincialForecast",
    __dynamic_weather__: "ncopDynamicWeather",
    __flood_watch__: "ncopFloodWatch",
    __air_quality_watch__: "ncopAirQualityWatch",
    __food_security_watch__: "ncopFoodSecurityWatch",
  };

  _exportPanelHtml() {
    const rows = StoryManager.BRIEFINGS.filter((b) => StoryManager.EXPORT_HOOKS[b.value]).map((b) => `
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;background:rgba(255,255,255,0.03);border-left:3px solid ${b.color};">
                <span style="font-size:11.5px;font-weight:600;color:#eaeaea;">${b.icon} ${b.title}</span>
                <span style="display:flex;gap:5px;flex:none;">
                  <button type="button" data-rx-story="${b.value}" data-rx-format="pdf" title="Opens the print dialog — choose Save as PDF" style="all:unset;cursor:pointer;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;">PDF</button>
                  <button type="button" data-rx-story="${b.value}" data-rx-format="word" title="Downloads a .doc with maps and charts" style="all:unset;cursor:pointer;font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:6px;background:rgba(255,255,255,0.08);color:#fff;">Word</button>
                </span>
              </div>`).join("");
    return `
          <div class="ncop-pick-rx" style="display:flex;flex-direction:column;gap:6px;">
            <button type="button" class="ncop-pick-rx-btn" aria-expanded="false" title="Export a briefing as a report without playing it"
              style="all:unset;box-sizing:border-box;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 10px;border-radius:9px;background:rgba(70,178,255,0.12);border:1px solid rgba(70,178,255,0.35);color:#cfe9ff;font-size:12px;font-weight:700;">📄 Export a briefing as a report</button>
            <div class="ncop-pick-rx-menu" style="display:none;flex-direction:column;gap:5px;">
              ${rows}
              <div style="font-size:10.5px;line-height:1.45;color:rgba(234,234,234,.6);">Report is in English. The briefing opens paused while its maps are captured, then stays on its first scene.</div>
            </div>
          </div>`;
  }

  _exportFromPicker(value, format) {
    const hook = window[StoryManager.EXPORT_HOOKS[value]];
    if (exportInProgress()) {
      const btn = this.root?.querySelector(".ncop-pick-rx-btn");
      if (btn) { btn.textContent = "⏳ A report is already being built…"; setTimeout(() => { btn.textContent = "📄 Export a briefing as a report"; }, 3000); }
      return;
    }
    // The print window must be opened inside the click, or it is blocked.
    const win = format === "pdf" ? openPrintWindow() : null;
    let ok = false;
    try { ok = !!hook?.exportReport?.(format, win); } catch (e) { console.warn("[story] export failed:", e); }
    if (!ok) { try { if (win && !win.closed) win.close(); } catch (_) {} }
  }

  _renderList() {
    const sel = this.root?.querySelector("#storySelect");
    const meta = this.root?.querySelector("#storyMeta");
    const chapters = this.root?.querySelector("#storyChapters");
    if (!sel || !chapters) return;

    sel.innerHTML = "";
    const optBlank = document.createElement("option");
    optBlank.value = "";
    optBlank.textContent = "Select story...";
    sel.appendChild(optBlank);

    this.state.stories
      .filter((s) => !StoryManager.HIDDEN_STORY_IDS.has(String(s.id)))
      .forEach((s) => {
        const o = document.createElement("option");
        o.value = String(s.id);
        o.textContent = s.title || `Story #${s.id}`;
        sel.appendChild(o);
      });

    if (meta) meta.textContent = "";
    chapters.innerHTML = `
        <div class="ncop-story-picker" style="padding:14px;border:1px dashed #444;border-radius:10px;display:flex;flex-direction:column;gap:10px;">
          <div style="font-weight:700;font-size:14px;color:#eaeaea;">Please pick a story</div>
          <div style="font-size:12px;line-height:1.5;opacity:.8;">
            Cinematic, data-driven briefings played on the map — live figures narrated scene by scene, nothing scripted. Pick one above, or click a card below; playback starts automatically.
          </div>
          ${StoryManager.BRIEFINGS.map((b) => `
            <button type="button" class="ncop-story-brief" data-story-value="${b.value}"
              style="all:unset;box-sizing:border-box;cursor:pointer;display:flex;flex-direction:column;gap:5px;padding:10px 11px;border-radius:9px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-left:3px solid ${b.color};">
              <span style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-weight:700;font-size:12.5px;color:#fff;">${b.icon} ${b.title}</span>
                <span style="font-size:9px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:${b.color}33;color:${b.color};white-space:nowrap;">${b.theme}</span>
              </span>
              <span style="font-size:11px;line-height:1.45;color:rgba(234,234,234,.85);">${b.basis}</span>
              <span style="font-size:10.5px;line-height:1.45;color:rgba(234,234,234,.6);"><b style="color:rgba(234,234,234,.75);">Data:</b> ${b.data}</span>
              <span style="font-size:10.5px;line-height:1.45;color:rgba(234,234,234,.6);"><b style="color:rgba(234,234,234,.75);">Shows:</b> ${b.shows}</span>
            </button>`).join("")}
        </div>
      `;
    const exportBar = this.root?.querySelector("#storyExport");
    if (exportBar) {
      exportBar.innerHTML = this._exportPanelHtml();
      if (!exportBar.dataset.rxWired) {
        exportBar.dataset.rxWired = "1";
        exportBar.addEventListener("click", (e) => {
          const rxToggle = e.target.closest?.(".ncop-pick-rx-btn");
          if (rxToggle) {
            const menu = exportBar.querySelector(".ncop-pick-rx-menu");
            if (menu) { const open = menu.style.display === "none"; menu.style.display = open ? "flex" : "none"; rxToggle.setAttribute("aria-expanded", String(open)); }
            return;
          }
          const rx = e.target.closest?.("[data-rx-story]");
          if (!rx) return;
          const menu = exportBar.querySelector(".ncop-pick-rx-menu");
          if (menu) menu.style.display = "none";
          this._exportFromPicker(rx.dataset.rxStory, rx.dataset.rxFormat);
        });
      }
    }
    // A card starts its briefing exactly as the selector does: set the
    // value and fire the same "change" event the story modules listen for.
    if (!chapters.dataset.briefsWired) {
      chapters.dataset.briefsWired = "1";
      chapters.addEventListener("click", (e) => {
        const card = e.target.closest?.(".ncop-story-brief");
        const select = document.getElementById("storySelect");
        if (!card || !select) return;
        select.value = card.dataset.storyValue;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  }
  // ADD this helper inside StoryManager
  _renderMedia(ch) {
    const parts = [];

    // Image (simple <img>)
    if (ch.image && typeof ch.image === "string" && ch.image.trim()) {
      parts.push(`
        <div style="margin-top:8px">
          <img src="${this._esc(ch.image)}" alt="" loading="lazy"
               style="width:100%;height:auto;border-radius:8px;border:1px solid #222;display:block;"/>
        </div>
      `);
    }

    // Video (mp4 or common embeds)
    if (ch.video && typeof ch.video === "string" && ch.video.trim()) {
      const v = ch.video.trim();

      // direct mp4
      if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(v)) {
        parts.push(`
          <div style="margin-top:8px">
            <video src="${this._esc(v)}" controls preload="none"
                   style="width:100%;border-radius:8px;border:1px solid #222;display:block;"></video>
          </div>
        `);
      } else if (/youtube\.com|youtu\.be|vimeo\.com/i.test(v)) {
        // basic YouTube/Vimeo iframe
        const url = this._esc(v);
        parts.push(`
          <div style="margin-top:8px;position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;border:1px solid #222;">
            <iframe src="${url}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture"
                    allowfullscreen
                    style="position:absolute;top:0;left:0;width:100%;height:100%;"></iframe>
          </div>
        `);
      } else {
        // fallback: link
        parts.push(`
          <div style="margin-top:8px">
            <a href="${this._esc(
              v
            )}" target="_blank" rel="noopener noreferrer" style="color:#9cd0ff;text-decoration:underline;">
              Open video
            </a>
          </div>
        `);
      }
    }

    return parts.join("");
  }

  _renderStory(story) {
    const meta = this.root?.querySelector("#storyMeta");
    const chapters = this.root?.querySelector("#storyChapters");
    if (!chapters) return;
    if (meta) meta.textContent = story?.subtitle || "";

    chapters.innerHTML = "";
    (story?.chapters || []).forEach((ch, idx) => {
      const div = document.createElement("div");
      div.className = "chapter-card";
      div.dataset.index = String(idx);
      div.style.cssText =
        "border:1px solid #2a2a2a;border-radius:10px;padding:10px;background:#0c0c10";
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div>
            <div style="font-weight:700">${this._esc(
              ch.title || `Chapter ${idx + 1}`
            )}</div>
            <div style="font-size:12px;opacity:.8">${this._esc(
              ch.alignment || ""
            )}</div>
          </div>
          <div>
            <button class="custom-nav-btn story-jump" data-index="${idx}" title="Fly to chapter"><i data-lucide="navigation-2"></i></button>
            <button class="custom-nav-btn story-show" data-index="${idx}" title="Show layers"><i data-lucide="layers"></i></button>
          </div>
        </div>
        <div style="font-size:12px;opacity:.9;margin-top:6px">${this._md(
          ch.description || ""
        )}</div>
        ${this._renderMedia(ch)}  <!-- 👈 media if provided -->
      `;
      chapters.appendChild(div);
    });
    if (window.lucide?.createIcons) window.lucide.createIcons();

    // keep scroll-driven activation
    this._attachScrollActivation();
  }

  _attachScrollActivation() {
    const container = this.root?.querySelector("#storyChapters");
    if (!container) return;

    const cards = Array.from(container.querySelectorAll(".chapter-card"));
    if (!cards.length) return;

    // Make sure we only react when chapter visibility is dominant in the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        // Sort by intersection ratio so the *most visible* card wins.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (!visible) return;

        const idx = Number(visible.target.dataset.index || 0);
        if (Number.isNaN(idx)) return;

        // Avoid thrashing the map if we're already on this chapter.
        if (idx === this.state.currentIndex && this.state.currentStory) return;

        const prev = this.state.currentIndex;
        const direction = idx > prev ? "down" : "up";

        // When scrolling, always “go to” the current visible chapter.
        // _showChapterLayers() already clears previously shown static layers,
        // and _clearTemporal() is called within that flow when switching.
        this.state.currentIndex = idx;

        // Fly and show layers for this chapter
        this._flyToChapter(idx, true);

        // If going UP and the earlier chapter has fewer/no layers,
        // the net effect is layers progressively “removed” as desired.
        // (No extra code needed because _showChapterLayers() clears previous.)
      },
      {
        root: container,
        threshold: [0.55, 0.7, 0.85], // act when a chapter is mostly in view
      }
    );

    cards.forEach((card) => io.observe(card));

    // Optionally, jump the observer to the first card as initial state
    // (Don’t auto-fly; let the user scroll to start)
  }

  _showEditor(story) {
    const ed = this.root?.querySelector("#storyEditor");
    if (!ed) return;
    ed.style.display = "block";
    ed.innerHTML = `
        <div style="display:grid;gap:8px">
          <input id="edTitle" placeholder="Title" value="${this._esc(
            story?.title || ""
          )}" style="padding:6px 8px;border:1px solid #444;background:#101014;color:#eee;border-radius:8px">
          <input id="edSubtitle" placeholder="Subtitle" value="${this._esc(
            story?.subtitle || ""
          )}" style="padding:6px 8px;border:1px solid #444;background:#101014;color:#eee;border-radius:8px">
          <textarea id="edJSON" rows="12" style="font-family:ui-monospace,Consolas,monospace;border:1px solid #444;background:#0e0e13;color:#eaeaea;border-radius:8px;padding:8px">${this._esc(
            JSON.stringify(
              story || {
                title: "Untitled",
                subtitle: "",
                theme: "dark",
                chapters: [],
              },
              null,
              2
            )
          )}</textarea>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="edSave" class="custom-nav-btn"><i data-lucide="save"></i></button>
            <button id="edCancel" class="custom-nav-btn"><i data-lucide="x"></i></button>
          </div>
        </div>
      `;
    if (window.lucide?.createIcons) window.lucide.createIcons();
    ed.querySelector("#edCancel")?.addEventListener("click", () => {
      ed.style.display = "none";
    });
    ed.querySelector("#edSave")?.addEventListener("click", async () => {
      try {
        const next = JSON.parse(ed.querySelector("#edJSON").value);
        next.id = story?.id;
        const saved = await this.saveStory(next);
        console.log("Saved story", saved);
        ed.style.display = "none";
        const sel = this.root?.querySelector("#storySelect");
        if (sel) {
          sel.value = String(saved.id);
          sel.dispatchEvent(new Event("change"));
        }
      } catch (e) {
        console.error("Save failed", e);
      }
    });
  }

  _bind() {
    const sel = this.root?.querySelector("#storySelect");
    const edit = this.root?.querySelector("#storyEdit");

    sel?.addEventListener("change", (e) => {
      const id = (e.target.value || "").trim();
      const story = this.state.stories.find((s) => String(s.id) === id);
      this.state.currentStory = story || null;
      this.state.currentIndex = 0;
      if (story) this._renderStory(story);
      else this._renderList();
    });

    edit?.addEventListener("click", () => {
      const s = this.state.currentStory || {
        title: "Untitled",
        subtitle: "",
        theme: "dark",
        chapters: [],
      };
      this._showEditor(s);
    });

    // delegate chapter buttons (unchanged)
    this.root?.addEventListener("click", (e) => {
      const jump = e.target.closest?.(".story-jump");
      const show = e.target.closest?.(".story-show");
      if (jump) {
        const idx = Number(jump.dataset.index || 0);
        this._flyToChapter(idx, false);
      }
      if (show) {
        const idx = Number(show.dataset.index || 0);
        this._showChapterLayers(idx);
      }
    });
  }

  // ---------- chapter actions ----------
  _flyToChapter(index, autoShow) {
    const ch = this.state.currentStory?.chapters?.[index];
    if (!ch?.location) return;
    this.state.currentIndex = index;

    const { center, zoom, pitch = 0, bearing = 0 } = ch.location;
    this.map.flyTo({ center, zoom, pitch, bearing, duration: 1800 });

    if (autoShow) {
      setTimeout(() => this._showChapterLayers(index), 500);
    }
  }

  _showChapterLayers(index) {
    const ch = this.state.currentStory?.chapters?.[index];
    if (!ch) return;

    const wantedKeys = [];
    (ch.layers || []).forEach((entry) => {
      if (typeof entry === "string") {
        if (!entry.startsWith("temporal:")) wantedKeys.push(entry);
      } else if (entry && entry.id) {
        wantedKeys.push(entry.id);
      }
    });

    // hide previously shown static layers (only what we added)
    this.state.activeLayerKeys.forEach((k) => this.slc.removeLayerByKey(k));
    this.state.activeLayerKeys.clear();

    // add new static layers + optional opacity
    (ch.layers || []).forEach((entry) => {
      if (typeof entry === "string") {
        if (!entry.startsWith("temporal:")) {
          const ok = this.slc.addLayerByKey(entry);
          if (ok) this.state.activeLayerKeys.add(entry);
        }
      } else if (entry && entry.id) {
        const ok = this.slc.addLayerByKey(entry.id);
        if (ok) {
          this.state.activeLayerKeys.add(entry.id);
          if (typeof entry.opacity === "number") {
            const info = this.slc.getLayerInfo?.(entry.id);
            const lid = info?.layerIds?.[0];
            if (lid && this.map.getLayer(lid)) {
              const t = this.map.getLayer(lid).type;
              const op =
                t === "raster"
                  ? "raster-opacity"
                  : t === "fill"
                  ? "fill-opacity"
                  : t === "line"
                  ? "line-opacity"
                  : t === "circle"
                  ? "circle-opacity"
                  : t === "symbol"
                  ? "icon-opacity"
                  : null;
              if (op) {
                this.map.setPaintProperty(
                  lid,
                  op,
                  Math.max(0, Math.min(1, entry.opacity))
                );
                if (t === "symbol") {
                  try {
                    this.map.setPaintProperty(
                      lid,
                      "text-opacity",
                      entry.opacity
                    );
                  } catch (_) {}
                }
              }
            }
          }
        }
      }
    });

    // temporal
    const temporalKey = (ch.layers || [])
      .filter((x) => typeof x === "string" && x.startsWith("temporal:"))
      .map((x) => x.split(":")[1])[0];

    this._clearTemporal();

    if (temporalKey) {
      const arr = window[temporalKey];
      if (Array.isArray(arr) && typeof window.updateTempSlider === "function") {
        window.updateTempSlider(arr, temporalKey, temporalKey, null);
        this.state.temporalActiveKey = temporalKey;
      }
    }
  }

  _clearTemporal() {
    if (typeof window.cleanupSliderLayers === "function")
      window.cleanupSliderLayers();
    const el = document.getElementById("temp-slider1");
    const leg = document.getElementById("legend-container-slider1");
    if (el) el.style.display = "none";
    if (leg) leg.style.display = "none";
    this.state.temporalActiveKey = null;
  }

  _hideAll() {
    this.state.activeLayerKeys.forEach((k) => this.slc.removeLayerByKey(k));
    this.state.activeLayerKeys.clear();
  }

  // ---------- utils ----------
  _esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])
    );
  }
  _md(md) {
    return String(md)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/^-\s(.*)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>)(?![\s\S]*<li>)/s, "<ul>$1</ul>")
      .replace(/\n/g, "<br>");
  }
}

// Mount helper (called from dashboard.js after #story-root exists)
export function initStoryManager({ map, sourceLayerControl, fetchBase = "" }) {
  const root = document.getElementById("story-root");
  if (!root) {
    console.warn("Story root not found");
    return null;
  }
  const mgr = new StoryManager({
    map,
    sourceLayerControl,
    storyRoot: root,
    fetchBase,
  });
  window.storyManager = mgr;
  return mgr;
}

// Optional: direct “play by slug” helper
export async function startStoryBySlug(slug, fetchBase = "") {
  if (!window.storyManager) {
    console.warn("StoryManager not ready yet");
    return;
  }
  const res = await fetch(`${fetchBase}/stories/${slug}/`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const obj = await res.json();

  const story = { id: slug, title: obj?.title || slug, ...obj };
  window.storyManager.state.currentStory = story;
  window.storyManager.state.currentIndex = 0;

  window.storyManager._renderStory(story);
  window.storyManager._flyToChapter(0, true);
}
