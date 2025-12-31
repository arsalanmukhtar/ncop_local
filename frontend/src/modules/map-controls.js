// MapControls.js

/**
 * Handles the Mapbox map instance and core map interactions (labels, projection, terrain, spinning globe).
 * Assumes mapboxgl and ncop_storage are available globally or managed by the caller.
 */
export class MapControls {
    #map;
    #storage;
    #spinEnabled = false;
    #userInteracting = false;

    constructor(mapInstance, storageInstance) {
        this.#map = mapInstance;
        this.#storage = storageInstance;
        this.#setupSpinGlobeListeners();
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
            // console.log(`🌍 Changed projection to: ${projectionName}`);
            if (this.#storage) {
                this.#storage.saveSetting("mapProjection", projectionName);
            }
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

        if (this.#storage) {
            this.#storage.saveSetting("terrainEnabled", true);
        }
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

        const currentProjection = this.#storage
            ? this.#storage.getSetting("mapProjection") || "mercator"
            : "mercator";

        this.#map.easeTo({
            pitch: 0,
            bearing: 0,
            duration: 1000,
        });

        setTimeout(() => {
            try {
                this.#map.setProjection(currentProjection);
                // console.log("🌍 Projection restored to:", currentProjection);
            } catch (error) {
                console.warn("Error setting projection:", error);
                this.#map.setProjection("mercator");
            }
        }, 1200);

        if (this.#storage) {
            this.#storage.saveSetting("terrainEnabled", false);
        }
    }

    // ============================================================
    // SPINNING GLOBE FUNCTIONALITY
    // ============================================================

    /**
     * Setup event listeners for spinning globe interactions
     * Pauses spinning when user interacts with the map
     */
    #setupSpinGlobeListeners() {
        // Pause spinning on user interaction
        this.#map.on('mousedown', () => {
            this.#userInteracting = true;
        });

        // Restart spinning when interaction ends
        this.#map.on('mouseup', () => {
            this.#userInteracting = false;
            if (this.#spinEnabled) {
                this.#spinGlobe();
            }
        });

        // Handle cases where mouse moves off map
        this.#map.on('dragend', () => {
            this.#userInteracting = false;
            if (this.#spinEnabled) {
                this.#spinGlobe();
            }
        });

        this.#map.on('pitchend', () => {
            this.#userInteracting = false;
            if (this.#spinEnabled) {
                this.#spinGlobe();
            }
        });

        this.#map.on('rotateend', () => {
            this.#userInteracting = false;
            if (this.#spinEnabled) {
                this.#spinGlobe();
            }
        });

        // Continue spinning when animation completes
        this.#map.on('moveend', () => {
            if (this.#spinEnabled) {
                this.#spinGlobe();
            }
        });
    }

    /**
     * Core spinning globe logic
     * Rotates the globe continuously based on zoom level
     */
    #spinGlobe() {
        // Configuration
        const secondsPerRevolution = 60; // Complete revolution every 2 minutes
        const maxSpinZoom = 5; // Don't rotate above this zoom
        const slowSpinZoom = 3; // Start slowing rotation at this zoom

        const zoom = this.#map.getZoom();

        // Only spin if enabled, not interacting, and below max zoom
        if (this.#spinEnabled && !this.#userInteracting && zoom < maxSpinZoom) {
            let distancePerSecond = 360 / secondsPerRevolution;

            // Slow down spinning at higher zooms
            if (zoom > slowSpinZoom) {
                const zoomDif = (maxSpinZoom - zoom) / (maxSpinZoom - slowSpinZoom);
                distancePerSecond *= zoomDif;
            }

            const center = this.#map.getCenter();
            center.lng -= distancePerSecond;

            // Smoothly animate the map over one second
            this.#map.easeTo({ 
                center, 
                duration: 1000, 
                easing: (n) => n 
            });
        }
    }

    /**
     * Toggle spinning globe on/off
     * @returns {boolean} - New spinning state
     */
    toggleSpinGlobe() {
        this.#spinEnabled = !this.#spinEnabled;

        if (this.#spinEnabled) {
            // Start spinning
            // console.log("🌍 Starting globe rotation...");
            
            // Set globe projection and fog for better effect
            try {
                this.#map.setProjection('globe');
                this.#map.setFog({}); // Default atmosphere
            } catch (error) {
                console.warn("Could not set globe projection:", error);
            }

            // Start the spin
            this.#spinGlobe();

            // Save state
            if (this.#storage) {
                this.#storage.saveSetting('globeSpinning', true);
            }
        } else {
            // Stop spinning
            // console.log("🛑 Stopping globe rotation...");
            this.#map.stop(); // Immediately end ongoing animation
            
            // Save state
            if (this.#storage) {
                this.#storage.saveSetting('globeSpinning', false);
            }
        }

        return this.#spinEnabled;
    }

    /**
     * Get current spinning state
     * @returns {boolean}
     */
    isSpinning() {
        return this.#spinEnabled;
    }

    /**
     * Restore spinning state from storage
     * Called on initialization to restore previous session state
     */
    restoreSpinState() {
        const savedState = this.#storage?.getSetting('globeSpinning') || false;
        
        if (savedState && !this.#spinEnabled) {
            // Re-enable spinning silently without toggling
            this.#spinEnabled = true;
            
            // Set projection and fog
            try {
                this.#map.setProjection('globe');
                this.#map.setFog({});
            } catch (error) {
                console.warn("Could not restore globe projection:", error);
            }
            
            // Start spinning
            this.#spinGlobe();
        }
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
      <!-- scrollable chapter list -->
      <div id="storyChapters" style="display:grid;gap:8px;max-height:50vh;overflow-y:auto;padding-right:4px;"></div>
      <div id="storyEditor" style="display:none;border-top:1px solid #2a2a2a;margin-top:10px;padding-top:10px"></div>
    `;
    if (window.lucide?.createIcons) window.lucide.createIcons();
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

    this.state.stories.forEach((s) => {
      const o = document.createElement("option");
      o.value = String(s.id);
      o.textContent = s.title || `Story #${s.id}`;
      sel.appendChild(o);
    });

    if (meta) meta.textContent = "";
    chapters.innerHTML = `
        <div style="padding:10px;border:1px dashed #444;border-radius:8px;opacity:.8">
          Pick a story above or create a new one in the editor.
        </div>
      `;
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

        // When scrolling, always "go to" the current visible chapter.
        // _showChapterLayers() already clears previously shown static layers,
        // and _clearTemporal() is called within that flow when switching.
        this.state.currentIndex = idx;

        // Fly and show layers for this chapter
        this._flyToChapter(idx, true);

        // If going UP and the earlier chapter has fewer/no layers,
        // the net effect is layers progressively "removed" as desired.
        // (No extra code needed because _showChapterLayers() clears previous.)
      },
      {
        root: container,
        threshold: [0.55, 0.7, 0.85], // act when a chapter is mostly in view
      }
    );

    cards.forEach((card) => io.observe(card));

    // Optionally, jump the observer to the first card as initial state
    // (Don't auto-fly; let the user scroll to start)
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

// Optional: direct "play by slug" helper
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