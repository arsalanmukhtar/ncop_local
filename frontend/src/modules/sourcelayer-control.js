// sourcelayer-control.js - Direct Mapbox layer management using map-layers.js configuration

import { ncop_menu_items } from "./map-layers.js";
import LayerAttributePopup from "./layer-attribute-popup.js"; // <-- ENABLED
// import LayerAttributePopup from './layer-attribute-popup.js';

/**
 * SourceLayerControl Class
 *
 * Manages map layers directly using Mapbox addSource and addLayer functions.
 * Reads layer configuration from map-layers.js and applies it to the map.
 */
// ---------------------------------------------------------------------------
// Loading overlay CSS — injected once into the document head.
// Keeps all overlay styling co-located with its logic.
// ---------------------------------------------------------------------------
(function _injectLoadingOverlayCSS() {
  if (document.getElementById("ncop-overlay-style")) return; // already injected
  const style = document.createElement("style");
  style.id = "ncop-overlay-style";
  style.textContent = `
    #ncop-layer-loading-overlay {
      position: absolute;
      inset: 0;
      z-index: 4000;           /* above Mapbox controls (z-index ~300) */
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(10, 14, 20, 0.72);
      backdrop-filter: blur(3px);
      pointer-events: all;     /* swallow all clicks / drags / scrolls */
      cursor: not-allowed;
      transition: opacity 0.2s ease;
    }
    #ncop-layer-loading-overlay.ncop-overlay-hidden {
      display: none;
    }
    .ncop-overlay-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
      background: rgba(20, 26, 36, 0.96);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      padding: 30px 40px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      pointer-events: none;
    }
    .ncop-overlay-spinner {
      width: 36px;
      height: 36px;
      border: 3px solid rgba(255,255,255,0.15);
      border-top-color: #4a9eff;
      border-radius: 50%;
      animation: ncop-spin 0.8s linear infinite;
    }
    @keyframes ncop-spin { to { transform: rotate(360deg); } }
    .ncop-overlay-title {
      color: #e8eaf0;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .ncop-overlay-sub {
      color: rgba(200,210,230,0.65);
      font-size: 12px;
      text-align: center;
      max-width: 220px;
      line-height: 1.5;
    }
  `;
  document.head.appendChild(style);
})();

export class SourceLayerControl {
  constructor(map) {
    this.map = map;

    // Track active layers and their configuration
    this.activeLayers = new Map(); // key -> { sourceId, layerIds, config }

    // Track layer order (layers added later appear on top)
    this.layerOrder = [];

    // Flag to indicate if we're currently restoring layers
    this.isRestoringLayers = false;

    // Counter for concurrent in-flight data loads (keeps overlay up until ALL done)
    this._loadingCount = 0;

    // Listen for style changes to restore layers
    this.setupStyleChangeHandler();

    // NEW: generic popup instance (binds itself when map is ready)
    this.layerAttributePopup = new LayerAttributePopup(this.map);
    // Optional global exposure for other modules/tools
    window.layerAttributePopup = this.layerAttributePopup;
    window.ncop_popup = this.layerAttributePopup;

    this._setupFeatureClickHandler();

    // Preload sources only after style is loaded
    this.map.on("style.load", () => {
      this.preloadAllSources();
    });
  }

  /**
   * ---------- Safety Helpers (non-invasive) ----------
   */
  _isStyleReady() {
    try {
      if (!this.map?.isStyleLoaded || !this.map?.getStyle) return false;
      const ready = this.map.isStyleLoaded();
      const style = this.map.getStyle();
      return !!(ready && style && Array.isArray(style.layers));
    } catch {
      return false;
    }
  }

  _safeQRF(point, options) {
    try {
      if (!this._isStyleReady()) return [];
      // If specific layer IDs are provided, ensure each exists before querying
      if (options?.layers && Array.isArray(options.layers)) {
        const validLayers = options.layers.filter((lid) =>
          this.map.getLayer(lid)
        );
        if (validLayers.length === 0) return [];
        return (
          this.map.queryRenderedFeatures(point, {
            ...options,
            layers: validLayers,
          }) || []
        );
      }
      return this.map.queryRenderedFeatures(point, options) || [];
    } catch {
      // Swallow transient Mapbox internal errors (e.g., featuresets undefined)
      return [];
    }
  }

  /**
   * Find layer configuration by key in the ncop_menu_items structure
   */
  findLayerConfig(layerKey) {
    for (const categoryKey in ncop_menu_items) {
      const category = ncop_menu_items[categoryKey];

      for (const subcategoryKey in category) {
        const subcategory = category[subcategoryKey];

        // Check in toggle items
        if (subcategory.toggle && subcategory.toggle[layerKey]) {
          return {
            config: subcategory.toggle[layerKey],
            categoryKey,
            subcategoryKey,
            itemType: "toggle",
          };
        }

        // Check in temporal items
        if (subcategory.temporal) {
          for (const temporalKey in subcategory.temporal) {
            if (temporalKey === layerKey) {
              return {
                config: subcategory.temporal[temporalKey],
                categoryKey,
                subcategoryKey,
                itemType: "temporal",
              };
            }
          }
        }

        // Check in button items
        if (subcategory.button && subcategory.button[layerKey]) {
          return {
            config: subcategory.button[layerKey],
            categoryKey,
            subcategoryKey,
            itemType: "button",
          };
        }

        // Check in dropdown items
        if (subcategory.dropdown && Array.isArray(subcategory.dropdown)) {
          for (const dropdownItem of subcategory.dropdown) {
            if (dropdownItem.options) {
              for (const optionKey in dropdownItem.options) {
                if (optionKey === layerKey) {
                  return {
                    config: dropdownItem.options[optionKey],
                    categoryKey,
                    subcategoryKey,
                    itemType: "dropdown",
                  };
                }
              }
            }
          }
        }

        // Check in static items
        if (subcategory.static && subcategory.static[layerKey]) {
          return {
            config: subcategory.static[layerKey],
            categoryKey,
            subcategoryKey,
            itemType: "static",
          };
        }

        // 🔥 NEW: Check in nested sections (like GDACS Alerts)
        const nestedSections = subcategory.nested || subcategory.subsections;
        if (nestedSections && typeof nestedSections === "object") {
          for (const nestedKey in nestedSections) {
            const nestedSection = nestedSections[nestedKey];

            // Check nested toggle items
            if (nestedSection.toggle && nestedSection.toggle[layerKey]) {
              return {
                config: nestedSection.toggle[layerKey],
                categoryKey,
                subcategoryKey,
                nestedKey,
                itemType: "toggle",
              };
            }

            // Check nested temporal items
            if (nestedSection.temporal && nestedSection.temporal[layerKey]) {
              return {
                config: nestedSection.temporal[layerKey],
                categoryKey,
                subcategoryKey,
                nestedKey,
                itemType: "temporal",
              };
            }

            // Check nested static items (where GDACS events are located)
            if (nestedSection.static && nestedSection.static[layerKey]) {
              return {
                config: nestedSection.static[layerKey],
                categoryKey,
                subcategoryKey,
                nestedKey,
                itemType: "static",
              };
            }

            // Check nested button items
            if (nestedSection.button && nestedSection.button[layerKey]) {
              return {
                config: nestedSection.button[layerKey],
                categoryKey,
                subcategoryKey,
                nestedKey,
                itemType: "button",
              };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Preload sources for all layers (optimized, only once per source).
   *
   * PERF: We now SKIP geojson sources whose `data` field is an HTTP URL.
   * When Mapbox adds a geojson source with a URL, it fetches that URL
   * immediately — even before any layer using that source is made visible.
   * For sources backed by heavy Django API endpoints (WAQI, GDACS, SlickPlus,
   * etc.) this caused all those endpoints to be hit on every style.load,
   * spiking the server's CPU at startup.
   *
   * Tile-based sources (vector, raster, raster-dem) are safe to preload because
   * Mapbox only fetches individual tiles when they enter the viewport.
   *
   * Geojson sources with HTTP URLs are added lazily inside addLayerByKey()
   * the first time the user actually activates that layer.
   */
  preloadAllSources() {
    const sourcesSet = new Set();

    const shouldSkip = (sourceConfig) => {
      // PERF: skip geojson sources backed by remote URLs — they auto-fetch on addSource.
      return (
        sourceConfig.type === "geojson" &&
        typeof sourceConfig.data === "string" &&
        (sourceConfig.data.startsWith("http://") ||
          sourceConfig.data.startsWith("https://") ||
          sourceConfig.data.startsWith("/"))   // relative API paths also deferred
      );
    };

    for (const categoryKey in ncop_menu_items) {
      const category = ncop_menu_items[categoryKey];

      for (const subcategoryKey in category) {
        const subcategory = category[subcategoryKey];

        // Handle direct items (toggle, temporal, button, dropdown, static)
        const items = [
          subcategory.toggle,
          subcategory.temporal,
          subcategory.button,
          subcategory.dropdown,
          subcategory.static,
        ].filter(Boolean);

        items.forEach((item) => {
          if (typeof item === "object") {
            for (const key in item) {
              const config = item[key];
              if (
                config &&
                config.source &&
                config.source.id &&
                !sourcesSet.has(config.source.id)
              ) {
                sourcesSet.add(config.source.id);
                if (!shouldSkip(config.source)) {
                  this.addMapboxSource(config.source);
                  console.debug(`🔧 Preloaded source: ${config.source.id}`);
                } else {
                  console.debug(`⏳ Deferred (lazy) source: ${config.source.id}`);
                }
              }
            }
          }
        });

        // 🔥 Handle nested subsections (GDACS, etc.)
        const nestedSections = subcategory.nested || subcategory.subsections;
        if (nestedSections && typeof nestedSections === "object") {
          for (const nestedKey in nestedSections) {
            const nestedSection = nestedSections[nestedKey];

            const nestedItems = [
              nestedSection.toggle,
              nestedSection.temporal,
              nestedSection.static,
              nestedSection.button,
            ].filter(Boolean);

            nestedItems.forEach((item) => {
              if (typeof item === "object") {
                for (const key in item) {
                  const config = item[key];
                  if (
                    config &&
                    config.source &&
                    config.source.id &&
                    !sourcesSet.has(config.source.id)
                  ) {
                    sourcesSet.add(config.source.id);
                    if (!shouldSkip(config.source)) {
                      this.addMapboxSource(config.source);
                      console.debug(
                        `🔧 Preloaded nested source: ${config.source.id} (from ${nestedKey})`
                      );
                    } else {
                      console.debug(
                        `⏳ Deferred (lazy) nested source: ${config.source.id} (from ${nestedKey})`
                      );
                    }
                  }
                }
              }
            });
          }
        }
      }
    }

    console.debug(`✅ Preloaded ${sourcesSet.size} total sources (API-backed geojson sources deferred to lazy load)`);
  }

  /**
   * Add a layer by its key from map-layers.js configuration
   * Only toggles layer visibility/loading, source is preloaded
   */
  async addLayerByKey(layerKey, shouldLog = true) {
    if (this.activeLayers.has(layerKey)) {
      if (shouldLog) console.warn(`⚠️ Layer "${layerKey}" is already active`);
      return false;
    }

    const layerInfo = this.findLayerConfig(layerKey);
    if (!layerInfo) {
      console.error(`❌ Layer configuration not found for key: "${layerKey}"`);
      return false;
    }

    const { config } = layerInfo;

    // Check if config has source and layers
    if (!config.source || !config.layers) {
      console.warn(
        `⚠️ Layer "${layerKey}" missing source or layers configuration`
      );
      return false;
    }

    try {
      // PERF: Ensure source is registered before adding layers.
      // API-backed geojson sources are intentionally skipped in preloadAllSources()
      // and added here on first use (lazy loading). addMapboxSource() is a no-op if
      // the source already exists, so it is safe to call unconditionally.
      const isLazyGeoJSON =
        config.source.type === "geojson" &&
        typeof config.source.data === "string" &&
        (config.source.data.startsWith("http://") ||
          config.source.data.startsWith("https://") ||
          config.source.data.startsWith("/"));

      if (!this.map.getSource(config.source.id)) {
        // Show loading overlay for remote geojson sources — Mapbox will fetch
        // them immediately after addSource(). Hide once data arrives or after
        // a 60-second safety timeout to avoid permanently blocking the UI.
        if (isLazyGeoJSON) {
          this.showLoadingOverlay(config.label || layerKey);

          const sourceId = config.source.id;
          const onSourceData = (e) => {
            if (e.sourceId === sourceId && e.isSourceLoaded) {
              this.map.off("sourcedata", onSourceData);
              clearTimeout(safetyTimer);
              this.hideLoadingOverlay();
            }
          };
          this.map.on("sourcedata", onSourceData);

          // Safety: always release the overlay if sourcedata never fires
          const safetyTimer = setTimeout(() => {
            this.map.off("sourcedata", onSourceData);
            this.hideLoadingOverlay();
          }, 60_000);
        }

        this.addMapboxSource(config.source);
      }
      const layerIds = this.addMapboxLayers(config.layers, config.source.id);
      if (layerIds.length === 0) {
        return false;
      }

      // Store layer information
      this.activeLayers.set(layerKey, {
        sourceId: config.source.id,
        layerIds: layerIds,
        config: config,
      });

      // Track order
      this.layerOrder.push(layerKey);

      return true;
    } catch (error) {
      console.error(`❌ Error adding layer "${layerKey}":`, error);
      return false;
    }
  }

  /**
   * Remove a layer by its key (does NOT remove source)
   */
  removeLayerByKey(layerKey, shouldLog = true) {
    const layerInfo = this.activeLayers.get(layerKey);
    if (!layerInfo) {
      if (shouldLog)
        console.warn(`⚠️ Layer "${layerKey}" is not currently active`);
      return false;
    }

    try {
      // Remove layers only, keep source
      layerInfo.layerIds.reverse().forEach((layerId) => {
        if (this.map.getLayer(layerId)) {
          this.map.removeLayer(layerId);
        }
      });

      // Remove from tracking
      this.activeLayers.delete(layerKey);

      // Remove from order
      const orderIndex = this.layerOrder.indexOf(layerKey);
      if (orderIndex > -1) {
        this.layerOrder.splice(orderIndex, 1);
      }

      return true;
    } catch (error) {
      console.error(`❌ Error removing layer "${layerKey}":`, error);
      return false;
    }
  }

  /**
   * Add a Mapbox source from configuration
   */
  addMapboxSource(sourceConfig) {
    try {
      const { id, type, data, tiles, scheme, maxzoom, minzoom, tileSize } =
        sourceConfig;

      // Check if source already exists
      if (this.map.getSource(id)) {
        // console.log(`⚠️ Source ${id} already exists, skipping...`);
        return true;
      }

      const sourceDefinition = {
        type: type,
        ...(data && { data }), // For GeoJSON sources
        ...(tiles && { tiles }), // For vector/raster tile sources
        ...(scheme && { scheme }), // For vector tile sources (e.g., 'tms')
        ...(maxzoom !== undefined && { maxzoom }),
        ...(minzoom !== undefined && { minzoom }),
        ...(tileSize && { tileSize }), // Now properly destructured
      };

      // For raster sources, ensure we have proper defaults
      if (type === "raster") {
        // Set default tileSize if not provided
        if (!sourceDefinition.tileSize) {
          sourceDefinition.tileSize = 256; // Default tile size
        }

        // Add attribution if needed
        if (!sourceDefinition.attribution) {
          sourceDefinition.attribution = "";
        }
      }

      // console.log(`🔧 Adding ${type} source:`, {
      //   id,
      //   type,
      //   tileSize: sourceDefinition.tileSize,
      //   tiles: tiles ? `${tiles.length} tile URLs` : "no tiles",
      // });

      this.map.addSource(id, sourceDefinition);
      return true;
    } catch (error) {
      console.error("❌ Error adding source:", error);
      console.error("❌ Source config:", sourceConfig);
      return false;
    }
  }

  /**
   * Ensure custom icon images are loaded before adding symbol layers
   * Handles both local and remote images, and listens for styleimagemissing
   */
  ensureSymbolIconLoaded(iconName, iconPath, callback) {
    // If image is already loaded, callback immediately
    if (this.map.hasImage(iconName)) {
      callback();
      return;
    }
    // Try to load image
    this.map.loadImage(iconPath, (error, image) => {
      if (!error && image && !this.map.hasImage(iconName)) {
        this.map.addImage(iconName, image);
        callback();
      } else if (error) {
        console.error(`❌ Error loading icon image '${iconPath}':`, error);
      }
    });
    // Listen for styleimagemissing to reload if style changes
    this.map.on("styleimagemissing", (e) => {
      if (e.id === iconName && !this.map.hasImage(iconName)) {
        this.map.loadImage(iconPath, (error, image) => {
          if (!error && image) {
            this.map.addImage(iconName, image);
            callback();
          }
        });
      }
    });
  }

  /**
   * Add Mapbox layers from configuration (in order)
   */
  /**
   * Add Mapbox layers from configuration (in order) with GDACS icon support
   */
  addMapboxLayers(layersConfig, sourceId) {
    const addedLayers = [];
    try {
      // Find the first label layer (symbol with text-field)
      const style = this.map.getStyle();
      let labelLayerId = null;
      if (style && style.layers) {
        for (const layer of style.layers) {
          if (
            layer.type === "symbol" &&
            layer.layout &&
            layer.layout["text-field"]
          ) {
            labelLayerId = layer.id;
            break;
          }
        }
      }

      layersConfig.forEach((layerConfig) => {
        const layerId = layerConfig.id;
        if (this.map.getLayer(layerId)) {
          addedLayers.push(layerId);
          return;
        }

        const layer = {
          id: layerId,
          type: layerConfig.type,
          source: sourceId,
          ...(layerConfig["source-layer"] && {
            "source-layer": layerConfig["source-layer"],
          }),
          ...(layerConfig.paint && { paint: layerConfig.paint }),
          ...(layerConfig.layout && { layout: layerConfig.layout }),
          ...(layerConfig.filter && { filter: layerConfig.filter }),
        };

        // Handle symbol layers with icon-image
        if (
          layer.type === "symbol" &&
          layer.layout &&
          layer.layout["icon-image"]
        ) {
          const iconImage = layer.layout["icon-image"];

          // Check if this is a GDACS layer with conditional expressions or direct icon URL usage
          const isGDACSLayer = sourceId && sourceId.startsWith("gdacs_");
          const isComplexExpression =
            Array.isArray(iconImage) && iconImage[0] === "case";
          const isDirectIconExpression =
            Array.isArray(iconImage) &&
            iconImage.length === 3 &&
            iconImage[0] === "case" &&
            Array.isArray(iconImage[1]) &&
            iconImage[1][0] === "has" &&
            iconImage[1][1] === "icon";

          if (isGDACSLayer && (isComplexExpression || isDirectIconExpression)) {
            // For GDACS layers, set up the layer with direct icon URL support
            console.debug(
              `Setting up GDACS layer with dynamic icons: ${layerId}`
            );

            // Simplify to direct icon URL from properties
            layer.layout["icon-image"] = [
              "case",
              ["has", "icon"],
              ["get", "icon"],
              "red-dot",
            ];
            layer.layout["icon-size"] = layer.layout["icon-size"] || 0.6; // Smaller for GDACS icons

            // Add layer immediately and handle icon loading asynchronously
            if (labelLayerId) {
              this.map.addLayer(layer, labelLayerId);
            } else {
              this.map.addLayer(layer);
            }
            addedLayers.push(layerId);

            // Set up dynamic icon handling for this GDACS source
            this.setupGDACSIconHandling(sourceId, layerId);
          } else if (typeof iconImage === "string") {
            // Handle regular string icon paths (non-GDACS)
            let iconPath = iconImage;
            if (
              !iconImage.includes("/") &&
              !iconImage.endsWith(".webp") &&
              !iconImage.endsWith(".png") &&
              !iconImage.startsWith("http")
            ) {
              iconPath = `/static/icons/map_icons/layer_icons/${iconImage}.webp`;
            }

            this.ensureSymbolIconLoaded(iconImage, iconPath, () => {
              // Wait for source to be available before adding layer
              const tryAddLayer = () => {
                if (this.map.getSource(sourceId)) {
                  if (labelLayerId) {
                    this.map.addLayer(layer, labelLayerId);
                  } else {
                    this.map.addLayer(layer);
                  }
                  addedLayers.push(layerId);
                } else {
                  setTimeout(tryAddLayer, 100);
                }
              };
              tryAddLayer();
            });
          } else {
            // Handle other complex expressions (non-GDACS)
            if (labelLayerId) {
              this.map.addLayer(layer, labelLayerId);
            } else {
              this.map.addLayer(layer);
            }
            addedLayers.push(layerId);
          }
        } else {
          // Non-symbol layers or symbol layers without icons
          if (labelLayerId) {
            this.map.addLayer(layer, labelLayerId);
          } else {
            this.map.addLayer(layer);
          }
          addedLayers.push(layerId);
        }
      });

      // After adding, move all label layers to the top to ensure they stay above all others
      this.ensureLabelsOnTop();

      return addedLayers;
    } catch (error) {
      console.error("❌ Error adding layers:", error);
      return addedLayers;
    }
  }

  /**
   * Set up dynamic icon handling for GDACS layers
   */
  setupGDACSIconHandling(sourceId, layerId) {
    if (!sourceId || !sourceId.startsWith("gdacs_")) {
      return;
    }

    console.debug(`Setting up GDACS icon handling for source: ${sourceId}`);

    // Listen for data changes on this source
    const handleSourceData = (e) => {
      if (e.sourceId === sourceId && e.isSourceLoaded) {
        this.updateGDACSIcons(sourceId, layerId);
        // Remove listener after first successful load
        this.map.off("sourcedata", handleSourceData);
      }
    };

    this.map.on("sourcedata", handleSourceData);

    // Also try to update immediately if data is already loaded
    setTimeout(() => {
      this.updateGDACSIcons(sourceId, layerId);
    }, 1000);
  }

  /**
   * Update GDACS icons using the icon URLs from the API response
   */
  updateGDACSIcons(sourceId, layerId) {
    try {
      const source = this.map.getSource(sourceId);
      if (!source) return;

      // Get the GeoJSON data
      const data = source._data;
      if (!data || !data.features) return;

      // Collect unique icon URLs from features
      const iconUrls = new Set();
      data.features.forEach((feature) => {
        if (feature.properties && feature.properties.icon) {
          iconUrls.add(feature.properties.icon);
        }
      });

      if (iconUrls.size === 0) return;

      console.debug(
        `Found ${iconUrls.size} unique GDACS icons to preload for ${sourceId}`
      );

      // Preload all unique icon URLs
      this.preloadGDACSIconsFromUrls(iconUrls)
        .then(() => {
          console.debug(`✅ Preloaded all GDACS icons for ${sourceId}`);
        })
        .catch((error) => {
          console.error("Error preloading GDACS icons:", error);
        });
    } catch (error) {
      console.error("Error updating GDACS icons:", error);
    }
  }

  /**
   * Preload GDACS icons from URLs
   */
  async preloadGDACSIconsFromUrls(iconUrls) {
    try {
      // Load all icons in parallel
      const loadPromises = Array.from(iconUrls).map((iconUrl) =>
        this.loadRemoteIcon(iconUrl)
      );
      await Promise.all(loadPromises);
    } catch (error) {
      console.error("Error preloading GDACS icons from URLs:", error);
    }
  }

  /**
   * Load remote icon and add to map
   */
  async loadRemoteIcon(iconUrl) {
    try {
      // Use the URL itself as the icon name
      if (this.map.hasImage(iconUrl)) {
        console.debug(`Icon already loaded: ${iconUrl}`);
        return;
      }

      console.debug(`Loading GDACS icon: ${iconUrl}`);

      const response = await fetch(iconUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const blob = await response.blob();
      const img = await createImageBitmap(blob);

      // Add the image using the URL as the key
      this.map.addImage(iconUrl, img);
      console.debug(`✅ Loaded remote icon: ${iconUrl}`);
    } catch (error) {
      console.error(`❌ Error loading remote icon ${iconUrl}:`, error);

      // Ensure fallback icon exists
      if (!this.map.hasImage("red-dot")) {
        this.ensureSymbolIconLoaded(
          "red-dot",
          "/static/icons/map_icons/layer_icons/red-dot.webp",
          () => {
            console.debug("Fallback red-dot icon loaded");
          }
        );
      }
    }
  }

  /**
   * Move all label layers to the top of the stack
   */
  ensureLabelsOnTop() {
    try {
      const style = this.map.getStyle();
      if (!style || !style.layers) return;
      // Find all label layers (symbol layers with text-field)
      const labelLayers = style.layers.filter(
        (layer) =>
          layer.type === "symbol" && layer.layout && layer.layout["text-field"]
      );
      // Move each label layer to the top, preserving their relative order
      labelLayers.forEach((labelLayer) => {
        if (this.map.getLayer(labelLayer.id)) {
          this.map.moveLayer(labelLayer.id);
        }
      });
    } catch (error) {
      console.error("❌ Error ensuring labels on top:", error);
    }
  }

  /**
   * Remove Mapbox layers and source
   */
  removeMapboxLayersAndSource(sourceId, layerIds) {
    try {
      // Remove layers first (reverse order)
      layerIds.reverse().forEach((layerId) => {
        if (this.map.getLayer(layerId)) {
          this.map.removeLayer(layerId);
        }
      });

      // Remove source
      this.removeMapboxSource(sourceId);
    } catch (error) {
      console.error("❌ Error removing layers/source:", error);
    }
  }

  /**
   * Remove Mapbox source
   */
  removeMapboxSource(sourceId) {
    try {
      if (this.map.getSource(sourceId)) {
        this.map.removeSource(sourceId);
      }
    } catch (error) {
      console.error("❌ Error removing source:", error);
    }
  }

  /**
   * Toggle layer visibility
   */
  toggleLayerByKey(layerKey) {
    if (this.activeLayers.has(layerKey)) {
      return this.removeLayerByKey(layerKey);
    } else {
      return this.addLayerByKey(layerKey);
    }
  }

  /**
   * Check if layer is active
   */
  isLayerActive(layerKey) {
    return this.activeLayers.has(layerKey);
  }

  /**
   * Get all active layer keys
   */
  getActiveLayerKeys() {
    return Array.from(this.activeLayers.keys());
  }

  /**
   * Get layer information
   */
  getLayerInfo(layerKey) {
    return this.activeLayers.get(layerKey);
  }

  /**
   * Remove all active layers
   */
  removeAllLayers() {
    const layerKeys = Array.from(this.activeLayers.keys());
    layerKeys.forEach((layerKey) => {
      this.removeLayerByKey(layerKey, false);
    });
  }

  /**
   * Get layer count
   */
  getLayerCount() {
    return this.activeLayers.size;
  }

  /**
   * Setup style change handler to restore layers after basemap changes
   */
  setupStyleChangeHandler() {
    this.map.on("style.load", () => {
      this.handleStyleLoad();
    });

    // Also listen for styledata as a backup
    this.map.on("styledata", () => {
      if (this.map.isStyleLoaded() && !this.isRestoringLayers) {
        // Small delay to ensure style is fully loaded
        setTimeout(() => {
          this.handleStyleLoad();
        }, 100);
      }
    });
  }

  /**
   * Handle style load event - restore all active layers
   */
  handleStyleLoad() {
    // Prevent multiple restoration attempts
    if (this.isRestoringLayers) {
      return;
    }

    // Only restore if we have active layers
    if (this.activeLayers.size === 0) {
      return;
    }

    this.isRestoringLayers = true;

    // Save current layer state
    const layersToRestore = new Map(this.activeLayers);
    const orderToRestore = [...this.layerOrder];

    // Clear current tracking (but don't remove from map since style change already did that)
    this.activeLayers.clear();
    this.layerOrder = [];

    // Restore layers in the same order with a delay to ensure style is ready
    setTimeout(() => {
      orderToRestore.forEach((layerKey, index) => {
        setTimeout(() => {
          this.addLayerByKey(layerKey, false);

          // Reset flag when all layers are processed
          if (index === orderToRestore.length - 1) {
            setTimeout(() => {
              this.isRestoringLayers = false;
            }, 100);
          }
        }, index * 100); // 100ms delay between each layer for better stability
      });
    }, 300); // Increased delay to ensure style is fully loaded
  }

  /**
   * Manually trigger layer restoration (for external use)
   */
  restoreAllLayers() {
    this.handleStyleLoad();
  }

  /**
   * Get active layers info for debugging
   */
  getActiveLayersInfo() {
    const info = {
      count: this.activeLayers.size,
      layers: Array.from(this.activeLayers.entries()).map(([key, data]) => ({
        key,
        sourceId: data.sourceId,
        layerIds: data.layerIds,
        config: data.config,
      })),
      order: [...this.layerOrder],
      isRestoring: this.isRestoringLayers,
    };
    return info;
  }

  /**
   * Get configs for all vector tile layers (for popup)
   */
  getVectorTileLayerConfigs() {
    const configs = {};
    for (const categoryKey in ncop_menu_items) {
      const category = ncop_menu_items[categoryKey];
      for (const subcategoryKey in category) {
        const subcategory = category[subcategoryKey]; // FIXED: was subcategory=subcategory[subcategoryKey]
        if (subcategory.toggle) {
          for (const layerKey in subcategory.toggle) {
            const config = subcategory.toggle[layerKey];
            if (config.source && config.source.type === "vector") {
              configs[layerKey] = config;
            }
          }
        }
      }
    }
    return configs;
  }

  /**
   * Get configs for all DEW polygons (for popup)
   */
  getDewPolygonConfigs() {
    // This should return configs for all DEW polygons currently on the map
    // For now, we use a simple structure: { dew_exposure_{id}: { label, ... } }
    const configs = {};
    if (window.exposureLayersMap) {
      window.exposureLayersMap.forEach((info, exposureId) => {
        configs[`dew_exposure_${exposureId}`] = {
          label: `DEW Exposure #${exposureId}`,
          // Add more config options here if needed
        };
      });
    }
    return configs;
  }

  /**
   * Setup map click handler for vector tile feature popup
   */
  _setupFeatureClickHandler() {
    // ✅ FIXED: Removed duplicate click handler that was blocking the popup
    // The LayerAttributePopup now handles all clicks properly

    // Only keep mousemove for cursor changes (no click handler needed here)
    this.map.on("mousemove", (e) => {
      if (!this._isStyleReady()) {
        this.map.getCanvas().style.cursor = "";
        return;
      }
      let pointer = false;
      for (const layerKey of this.getActiveLayerKeys()) {
        const info = this.getLayerInfo(layerKey);
        const config = info?.config;
        if (config?.source?.type === "vector") {
          const layerId = info.layerIds?.[0];
          if (!layerId || !this.map.getLayer(layerId)) continue;
          const features = this._safeQRF(e.point, { layers: [layerId] });
          if (features && features.length > 0) {
            pointer = true;
            break;
          }
        }
      }
      this.map.getCanvas().style.cursor = pointer ? "pointer" : "";
    });

    // ✅ Click handling is now done by LayerAttributePopup - removed duplicate handler
  }

  /**
   * Position popup at top right of viewport
   */
  _positionPopupTopRight() {
    // const el = this.layerAttributePopup.popupEl;
    el.style.position = "fixed";
    el.style.top = "24px";
    el.style.right = "32px";
    el.style.zIndex = "9999";
    el.style.maxWidth = "340px";
  }

  // ---------------------------------------------------------------------------
  // Loading Overlay — shown while a remote geojson source is being fetched.
  // ---------------------------------------------------------------------------

  /**
   * Show the loading overlay and disable map interactions.
   * Increments an internal counter so multiple concurrent loads are handled
   * correctly — the overlay stays visible until ALL loads have finished.
   *
   * @param {string} [message] — Optional label shown below the spinner
   */
  showLoadingOverlay(message = "") {
    this._loadingCount++;

    // Create the overlay element once; reuse on subsequent calls.
    let overlay = document.getElementById("ncop-layer-loading-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "ncop-layer-loading-overlay";
      overlay.innerHTML = `
        <div class="ncop-overlay-card">
          <div class="ncop-overlay-spinner"></div>
          <div class="ncop-overlay-title">Loading Data…</div>
          <div class="ncop-overlay-sub" id="ncop-overlay-msg"></div>
        </div>
      `;
      // Append inside the map container so absolute positioning works.
      this.map.getContainer().appendChild(overlay);
    }

    const msgEl = overlay.querySelector("#ncop-overlay-msg");
    if (msgEl) msgEl.textContent = message;

    overlay.classList.remove("ncop-overlay-hidden");
    this._disableMapInteractions();
  }

  /**
   * Decrement the loading counter and hide the overlay once it reaches zero.
   * Re-enables map interactions when the overlay is dismissed.
   */
  hideLoadingOverlay() {
    this._loadingCount = Math.max(0, this._loadingCount - 1);
    if (this._loadingCount > 0) return; // other layers still loading

    const overlay = document.getElementById("ncop-layer-loading-overlay");
    if (overlay) overlay.classList.add("ncop-overlay-hidden");

    this._enableMapInteractions();
  }

  /** Disable all interactive handlers on the map. */
  _disableMapInteractions() {
    try {
      this.map.dragPan.disable();
      this.map.scrollZoom.disable();
      this.map.boxZoom.disable();
      this.map.dragRotate.disable();
      this.map.keyboard.disable();
      this.map.doubleClickZoom.disable();
      this.map.touchZoomRotate.disable();
    } catch (_) {
      // Handlers may not exist in all Mapbox versions; safe to ignore.
    }
  }

  /** Re-enable all interactive handlers on the map. */
  _enableMapInteractions() {
    try {
      this.map.dragPan.enable();
      this.map.scrollZoom.enable();
      this.map.boxZoom.enable();
      this.map.dragRotate.enable();
      this.map.keyboard.enable();
      this.map.doubleClickZoom.enable();
      this.map.touchZoomRotate.enable();
    } catch (_) {
      // Handlers may not exist in all Mapbox versions; safe to ignore.
    }
  }
}
