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
export class SourceLayerControl {
  constructor(map) {
    this.map = map;

    // Track active layers and their configuration
    this.activeLayers = new Map(); // key -> { sourceId, layerIds, config }

    // Track layer order (layers added later appear on top)
    this.layerOrder = [];

    // Flag to indicate if we're currently restoring layers
    this.isRestoringLayers = false;

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

        if (subcategory.static && subcategory.static[layerKey]) {
          return {
            config: subcategory.static[layerKey],
            categoryKey,
            subcategoryKey,
            itemType: "static",
          };
        }
      }
    }

    return null;
  }

  /**
   * Preload all sources for all layers (optimized, only once per source)
   */
  preloadAllSources() {
    const sourcesSet = new Set();
    for (const categoryKey in ncop_menu_items) {
      const category = ncop_menu_items[categoryKey];
      for (const subcategoryKey in category) {
        const subcategory = category[subcategoryKey];
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
                this.addMapboxSource(config.source);
              }
            }
          }
        });
      }
    }
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
      // Source is already preloaded, just add layers
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
        };
        // Handle symbol layers with custom icon-image
        if (
          layer.type === "symbol" &&
          layer.layout &&
          layer.layout["icon-image"]
        ) {
          const iconName = layer.layout["icon-image"];
          let iconPath = iconName;
          if (
            !iconName.includes("/") &&
            !iconName.endsWith(".webp") &&
            !iconName.endsWith(".png")
          ) {
            iconPath = `/static/icons/map_icons/layer_icons/${iconName}.webp`;
          }
          this.ensureSymbolIconLoaded(iconName, iconPath, () => {
            // Wait for source to be available before adding layer
            const tryAddLayer = () => {
              if (this.map.getSource(sourceId)) {
                if (labelLayerId) {
                  this.map.addLayer(layer, labelLayerId);
                } else {
                  this.map.addLayer(layer);
                }
                addedLayers.push(layerId);
                // --- FIX: update activeLayers and layerOrder immediately after adding ---
                const layerKey = Object.keys(this.activeLayers).find((key) => {
                  const info = this.activeLayers.get(key);
                  return (
                    info &&
                    info.sourceId === sourceId &&
                    info.layerIds.includes(layerId)
                  );
                });
                if (!layerKey) {
                  // If not already tracked, add to activeLayers and layerOrder
                  // Find config for this sourceId
                  for (const categoryKey in ncop_menu_items) {
                    const category = ncop_menu_items[categoryKey];
                    for (const subcategoryKey in category) {
                      const subcategory = category[subcategoryKey];
                      const items = [
                        subcategory.toggle,
                        subcategory.temporal,
                        subcategory.button,
                        subcategory.dropdown,
                      ].filter(Boolean);
                      items.forEach((item) => {
                        if (typeof item === "object") {
                          for (const key in item) {
                            const config = item[key];
                            if (
                              config &&
                              config.source &&
                              config.source.id === sourceId
                            ) {
                              this.activeLayers.set(key, {
                                sourceId: sourceId,
                                layerIds: [layerId],
                                config: config,
                              });
                              this.layerOrder.push(key);
                            }
                          }
                        }
                      });
                    }
                  }
                }
              } else {
                setTimeout(tryAddLayer, 100);
              }
            };
            tryAddLayer();
          });
        } else {
          // Always add before the first label layer
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
    // Set pointer cursor for all vector tile layers
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
          if (!layerId || !this.map.getLayer(layerId)) continue; // guard during style churn
          const features = this._safeQRF(e.point, { layers: [layerId] });
          if (features && features.length > 0) {
            pointer = true;
            break;
          }
        }
      }
      this.map.getCanvas().style.cursor = pointer ? "pointer" : "";
    });

    this.map.on("click", (e) => {
      if (!this._isStyleReady()) return;
      // Get layer order (topmost first)
      const orderedKeys = [...this.layerOrder].reverse();
      for (const layerKey of orderedKeys) {
        const info = this.getLayerInfo(layerKey);
        const config = info?.config;
        if (config?.source?.type === "vector") {
          const layerId = info.layerIds?.[0];
          if (!layerId || !this.map.getLayer(layerId)) continue; // guard during style churn
          const features = this._safeQRF(e.point, { layers: [layerId] });
          if (features && features.length > 0) {
            // this.layerAttributePopup.show(features[0], layerKey, e.point);
            return;
          }
        }
      }
      // Only hide if no DEW popup is active
      if (!window.ncop_popup_active) {
        // this.layerAttributePopup.hide();
      }
    });
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
}
