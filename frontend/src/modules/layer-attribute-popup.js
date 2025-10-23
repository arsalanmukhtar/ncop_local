// // layer-attribute-popup.js
// // Themed popup for displaying vector tile feature attributes on click

// class LayerAttributePopup {
//     constructor(map, layerConfigs) {
//         this.map = map;
//         this.layerConfigs = layerConfigs;
//         this.popupEl = this._createPopupElement();
//         this.popupLngLat = null; // Store geographic coordinates (lat/lng) of popup
//         this.mapMoveListener = null; // Reference to map movement handler
//         this._bindEvents();
//         this._setupDewPolygonClickHandler();
//     }

//     _createPopupElement() {
//         const el = document.createElement("div");
//         el.className = "layer-attribute-popup hidden";
//         el.innerHTML = '<div class="popup-content"></div>';
//         document.body.appendChild(el);
//         return el;
//     }

//     _bindEvents() {
//         // Hide popup when clicking outside
//         let lastMapClickTime = 0;
//         this.map.on("click", () => {
//             lastMapClickTime = Date.now();
//         });
//         document.addEventListener("mousedown", (e) => {
//             // Prevent immediate hide after map click
//             if (Date.now() - lastMapClickTime < 200) return;
//             if (
//                 !this.popupEl.classList.contains("hidden") &&
//                 !this.popupEl.contains(e.target)
//             ) {
//                 this.hide();
//             }
//         });
//     }

//     /**
//      * Setup click handler for DEW exposure polygon layers and all vector tile features
//      */
//     _setupDewPolygonClickHandler() {
//         this.map.on("click", (e) => {
//             // Query all rendered features at this click point
//             let features = [];
//             if (this.map && typeof this.map.queryRenderedFeatures === 'function') {
//                 features = this.map.queryRenderedFeatures(e.point);
//             }

//             if (!features || features.length === 0) {
//                 this.hide();
//                 return;
//             }

//             // Look for DEW polygon layers FIRST (format: exposure-polygon-{id})
//             for (const feature of features) {
//                 // Support both vector tile and GeoJSON features
//                 const layerId = feature.layer?.id;
//                 const sourceId = feature.source;
//                 const sourceType = this.map.getSource(sourceId)?.type;

//                 // Try to match exposure polygons by layerId or sourceId
//                 let exposureId = null;
//                 if (layerId && layerId.startsWith("exposure-polygon-")) {
//                     exposureId = layerId.replace("exposure-polygon-", "");
//                 } else if (sourceId && sourceId.startsWith("exposure-source-")) {
//                     exposureId = sourceId.replace("exposure-source-", "");
//                 }
//                 if (exposureId) {
//                     // Use the remarks property from feature.properties for the label
//                     const remarks =
//                       feature?.properties?.exposure_remarks ||
//                       `DEW Exposure #${exposureId}`;
//                     const customConfig = { label: remarks };
//                     // Pass the actual click coordinates (e.lngLat) for accurate positioning
//                     this.show(
//                         feature,
//                         `dew_exposure_${exposureId}`,
//                         e.lngLat,
//                         customConfig
//                     );
//                     return;
//                 }
//             }

//             // If no DEW polygon found, process other vector tile features
//             for (const feature of features) {
//                 const layerId = feature.layer?.id;
//                 const sourceId = feature.source;
//                 const sourceType = this.map.getSource(sourceId)?.type;

//                 // Skip if no layer ID or source ID
//                 if (!layerId && !sourceId) continue;

//                 // Try to find a matching config
//                 let config = (this.layerConfigs && this.layerConfigs[layerId]) || (this.layerConfigs && this.layerConfigs[sourceId]);

//                 if (config) {
//                     console.log(
//                         `🔍 Vector tile feature clicked: ${layerId || sourceId
//                         } (source type: ${sourceType})`,
//                         feature
//                     );
//                     // Always pass e.lngLat for vector tiles - it's the exact click point
//                     this.show(feature, layerId || sourceId, e.lngLat, null);
//                     return;
//                 }
//             }

//             // No matching feature or config found - hide popup
//             this.hide();
//         });

//         // Change cursor to pointer when hovering over interactive features
//         this.map.on("mousemove", (e) => {
//             const features = this.map.queryRenderedFeatures(e.point);
//             let hasInteractiveFeature = features?.some((f) => {
//                 const layerId = f.layer?.id;
//                 const sourceId = f.source;

//                 // Check if it's a DEW polygon
//                 if (
//                     (layerId && layerId.startsWith("exposure-polygon-")) ||
//                     (sourceId && sourceId.startsWith("exposure-source-"))
//                 ) {
//                     return true;
//                 }

//                 // Check if it has a config in layerConfigs
//                 if ((this.layerConfigs && this.layerConfigs[layerId]) || (this.layerConfigs && this.layerConfigs[sourceId])) {
//                     return true;
//                 }

//                 return false;
//             });

//             this.map.getCanvas().style.cursor = hasInteractiveFeature
//                 ? "pointer"
//                 : "";
//         });
//     }

//     show(feature, layerId, lngLatOrClickPoint = null, customConfig = null) {
//         // Try to get config from vector tile layers first
//         let config = customConfig || this.layerConfigs[layerId];

//         // If not found, try to get config from DEW polygons
//         if (
//             !config &&
//             window.sourceLayerControl &&
//             typeof window.sourceLayerControl.getDewPolygonConfigs === "function"
//         ) {
//             const dewConfigs = window.sourceLayerControl.getDewPolygonConfigs();
//             config = dewConfigs[layerId];
//         }

//         if (!config) {
//             console.warn("❌ No config found");
//             return;
//         }

//         const content = this.popupEl.querySelector(".popup-content");

//         let html = `<div class="popup-label">${config.label || layerId}</div>`;
//         html +=
//             '<div class="popup-attributes-scroll"><table class="popup-attributes">';

//         // Fallback for missing properties
//         const props = feature.properties || {};
//         if (Object.keys(props).length === 0) {
//             html += `<tr><td colspan="2" class="attr-value">No attributes found</td></tr>`;
//         } else {
//             // Helper to recursively render nested objects and JSON strings as tables
//             function renderNestedTable(obj, level = 0) {
//                 let rows = "";
//                 for (const key in obj) {
//                     const prettyKey = prettyAttributeName(key);
//                     let value = obj[key];
//                     // Try to parse JSON strings
//                     if (typeof value === "string") {
//                         try {
//                             const parsed = JSON.parse(value);
//                             if (typeof parsed === "object" && parsed !== null) {
//                                 value = parsed;
//                             }
//                         } catch (e) { }
//                     }
//                     if (typeof value === "object" && value !== null) {
//                         rows += `<tr><td class="attr-key" style="padding-left:${level * 16}px">${prettyKey}</td><td></td></tr>`;
//                         rows += renderNestedTable(value, level + 1);
//                     } else {
//                         rows += `<tr><td class="attr-key" style="padding-left:${level * 16}px">${prettyKey}</td><td class="attr-value">${value}</td></tr>`;
//                     }
//                 }
//                 return rows;
//             }
//             html += renderNestedTable(props);
//         }

//         html += "</table></div>";
//         content.innerHTML = html;

//         // Always use the clicked lat/lng for popup anchoring
//         let lngLat = null;

//         // PRIORITY 1: Use the actual click coordinates (e.lngLat) if available
//         // This is the most accurate for vector tiles since it's the exact point clicked
//         if (
//             lngLatOrClickPoint &&
//             lngLatOrClickPoint.lng !== undefined &&
//             lngLatOrClickPoint.lat !== undefined
//         ) {
//             lngLat = lngLatOrClickPoint;
//             console.log(
//                 `📍 Using click coordinates for popup: ${lngLat.lng}, ${lngLat.lat}`
//             );
//         }
//         // FALLBACK: Only use feature geometry if click coordinates are not available
//         // This handles cases where geometry data is available (GeoJSON features, etc.)
//         else if (feature?.geometry?.type && feature?.geometry?.coordinates) {
//             if (feature.geometry.type === "Point") {
//                 lngLat = {
//                     lng: feature.geometry.coordinates[0],
//                     lat: feature.geometry.coordinates[1],
//                 };
//                 console.log(
//                     `📍 Using Point geometry for popup: ${lngLat.lng}, ${lngLat.lat}`
//                 );
//             } else if (
//                 feature.geometry.type === "Polygon" &&
//                 feature.geometry.coordinates[0]
//             ) {
//                 // Use centroid of polygon for fallback
//                 const coords = feature.geometry.coordinates[0];
//                 let sumX = 0,
//                     sumY = 0;
//                 coords.forEach(([x, y]) => {
//                     sumX += x;
//                     sumY += y;
//                 });
//                 lngLat = { lng: sumX / coords.length, lat: sumY / coords.length };
//                 console.log(
//                     `📍 Using Polygon centroid for popup: ${lngLat.lng}, ${lngLat.lat}`
//                 );
//             }
//         }

//         this.popupLngLat = lngLat;

//         // Position the popup and set up listeners
//         this.popupEl.classList.remove("hidden");
//         this._updatePopupPosition();
//         this._setupMapMoveListener();
//         window.ncop_popup_active = true;
//     }

//     /**
//      * Setup listeners for map movement/zoom/rotation
//      * When the map moves, recalculate popup position to stay bound to geographic coordinates
//      */
//     _setupMapMoveListener() {
//         // Remove existing listener if any
//         if (this.mapMoveListener) {
//             this.map.off("move", this.mapMoveListener);
//             this.map.off("zoom", this.mapMoveListener);
//             this.map.off("rotate", this.mapMoveListener);
//         }

//         // Create the listener function
//         this.mapMoveListener = () => this._updatePopupPosition();

//         // Attach listeners for all map change events
//         this.map.on("move", this.mapMoveListener);
//         this.map.on("zoom", this.mapMoveListener);
//         this.map.on("rotate", this.mapMoveListener);
//     }

//     /**
//      * Update popup screen position based on stored geographic coordinates
//      */
//     _updatePopupPosition() {
//         if (!this.popupLngLat || this.popupEl.classList.contains("hidden")) {
//             return;
//         }

//         // Use requestAnimationFrame to ensure DOM has rendered before calculating dimensions
//         requestAnimationFrame(() => {
//             // Convert geographic coordinates to current screen coordinates
//             const screenCoords = this.map.project(this.popupLngLat);

//             // Get the actual rendered dimensions
//             const rect = this.popupEl.getBoundingClientRect();
//             const popupWidth = rect.width;
//             const popupHeight = rect.height;

//             // Position popup centered above the geographic point
//             // The triangle at the bottom points to the exact clicked location
//             const left = screenCoords.x - popupWidth / 2;
//             const top = screenCoords.y - popupHeight - 16; // 16px offset for the triangle

//             this.popupEl.style.left = `${Math.max(left, 8)}px`;
//             this.popupEl.style.top = `${Math.max(top, 8)}px`;
//         });
//     }

//     hide() {
//         this.popupEl.classList.add("hidden");
//         window.ncop_popup_active = false;

//         // Remove map listeners when popup is hidden
//         if (this.mapMoveListener) {
//             this.map.off("move", this.mapMoveListener);
//             this.map.off("zoom", this.mapMoveListener);
//             this.map.off("rotate", this.mapMoveListener);
//             this.mapMoveListener = null;
//         }
//         this.popupLngLat = null;
//     }
// }

// function prettyAttributeName(attr) {
//     // Replace underscores/dashes with spaces, capitalize each word
//     return attr
//         .replace(/[_-]+/g, " ")
//         .replace(/([a-z])([A-Z])/g, "$1 $2")
//         .replace(/\b\w/g, (c) => c.toUpperCase());
// }

// export default LayerAttributePopup;
