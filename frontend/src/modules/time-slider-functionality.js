// time-slider-functionality.js
// Updated to work with DashboardManager's private map instance
// Adds: clean Lucide play/pause toggle with two buttons, and restoration on map 'style.load'.
// ADDED: Drag and Resize functionality
// IMPROVED: Table-based popup with advanced styling and CSS variables

import { legends } from "./temporal-layer-legends";

// ===== GLOBAL VARIABLES =====
let sliderLayers = []; // Array of arrays of layer ids for each timestep
let isPlaying = false;
let interval;
const speedLevels = [0.5, 1, 2, 3];
let currentSpeedIndex = 1;
let currentActiveLayerSet = null;
let clickPopup = null;

// For restoring after 'style.load'
let _sliderRestore = {
  layerKey: null, // string
  textContent: null, // string (title)
  layersDef: null, // the "layers" array passed into updateTempSlider
  currentIndex: 0, // current slider frame
};
let _styleLoadHandlerBound = false;

// Drag and Resize variables
let isDragging = false;
let isResizing = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLeft = 0;
let dragStartTop = 0;
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;

// Helper to get the map instance from DashboardManager
function getMap() {
  if (!window.ncop_map) {
    console.error(
      "❌ Map not initialized. Make sure DashboardManager exposed window.ncop_map"
    );
    return null;
  }
  return window.ncop_map;
}

// ===== POPUP FORMATTING UTILITIES =====

function formatPropertyValue(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  // Format numbers with thousands separator
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return value.toLocaleString();
    } else {
      return value.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    }
  }

  // Format dates
  if (typeof value === "string") {
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    if (dateRegex.test(value)) {
      try {
        const date = new Date(value);
        if (!isNaN(date.getTime())) {
          return date.toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
        }
      } catch (e) {
        return value;
      }
    }
  }

  return value;
}

function formatPropertyKey(key) {
  // Convert snake_case or camelCase to Title Case
  return key
    .replace(/([_-])/g, " ")
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (str) => str.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function buildPopupContent(layerId, feature) {
  let tableRows = `
    <tr style="border-bottom: 1px solid rgba(0, 0, 0, 0.08);">
      <td style="
        padding: 8px 0;
        padding-right: 12px;
        font-weight: 600;
        color: rgba(0, 0, 0, 0.6);
        text-transform: uppercase;
        font-size: 11px;
        letter-spacing: 0.5px;
        white-space: nowrap;
      ">Layer</td>
      <td style="
        padding: 8px 0;
        color: rgba(0, 0, 0, 0.85);
        font-weight: 500;
        word-break: break-word;
      ">${layerId}</td>
    </tr>
  `;

  if (feature.properties && Object.keys(feature.properties).length > 0) {
    Object.entries(feature.properties).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        const formattedKey = formatPropertyKey(key);
        const formattedValue = formatPropertyValue(value);

        tableRows += `
          <tr style="border-bottom: 1px solid rgba(0, 0, 0, 0.05);">
            <td style="
              padding: 8px 0;
              padding-right: 12px;
              font-weight: 600;
              color: rgba(0, 0, 0, 0.6);
              white-space: nowrap;
              vertical-align: top;
            ">${formattedKey}:</td>
            <td style="
              padding: 8px 0;
              color: rgba(0, 0, 0, 0.85);
              word-break: break-word;
              max-width: 250px;
            ">${formattedValue}</td>
          </tr>
        `;
      }
    });
  } else {
    tableRows += `
      <tr>
        <td colspan="2" style="
          padding: 8px 0;
          color: rgba(0, 0, 0, 0.4);
          font-size: 12px;
          font-style: italic;
          text-align: center;
        ">No properties available</td>
      </tr>
    `;
  }

  const html = `
    <div style="
      position: fixed;
      z-index: 9999;
      background: var(--primary-bg, #ffffff);
      box-shadow: 0 8px 32px var(--shadow-soft, rgba(0, 0, 0, 0.1));
      border-radius: 8px;
      padding: 10px 15px;
      font-size: 13px;
      border: 1px solid var(--border-dark, rgba(0, 0, 0, 0.1));
      backdrop-filter: blur(15px) saturate(180%);
      -webkit-backdrop-filter: blur(15px) saturate(180%);
      transition: opacity 0.2s;
      opacity: 1;
      display: flex;
      flex-direction: column;
      transform: translate(-50%, -100%);
      min-width: 280px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.4;
    ">
      <table style="
        width: 100%;
        border-collapse: collapse;
        margin: 0;
        padding: 0;
      ">
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  `;

  return html;
}

// ===== DRAG AND RESIZE FUNCTIONS =====

function initDragResize() {
  const tempSlider = document.getElementById("temp-slider1");
  const dragBtn = document.getElementById("dragControlButton");
  const resizeBtn = document.getElementById("resizeControlButton");

  if (!tempSlider || !dragBtn || !resizeBtn) return;
  // ===== DRAG FUNCTIONALITY =====
  dragBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLeft = parseInt(window.getComputedStyle(tempSlider).left) || 0;
    dragStartTop = parseInt(window.getComputedStyle(tempSlider).top) || 0;

    document.addEventListener("mousemove", onDragMove);
    document.addEventListener("mouseup", onDragEnd);
  });

  function onDragMove(e) {
    if (!isDragging) return;

    const deltaX = e.clientX - dragStartX;
    const deltaY = e.clientY - dragStartY;

    tempSlider.style.left = dragStartLeft + deltaX + "px";
    tempSlider.style.top = dragStartTop + deltaY + "px";
  }

  function onDragEnd() {
    isDragging = false;
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
  }

  // ===== RESIZE FUNCTIONALITY =====
  resizeBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = tempSlider.offsetWidth;
    resizeStartHeight = tempSlider.offsetHeight;

    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
  });

  function onResizeMove(e) {
    if (!isResizing) return;

    const deltaX = e.clientX - resizeStartX;
    const deltaY = e.clientY - resizeStartY;

    const newWidth = Math.max(100, resizeStartWidth + deltaX);
    const newHeight = Math.max(50, resizeStartHeight + deltaY);

    tempSlider.style.width = newWidth + "px";
    tempSlider.style.height = newHeight + "px";

    const legendContainer = document.querySelector(".legend-container1");
    if (legendContainer) {
      legendContainer.style.width = newWidth * 0.95 + "px";
    }
  }

  function onResizeEnd() {
    isResizing = false;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeEnd);
  }
}

// ===== UTILITY FUNCTIONS =====

function loadsliderlayertemporalIcons(layerSet) {
  const map = getMap();
  if (!map) {
    console.error("Map instance not found");
    return;
  }

  if (layerSet[0]?.images) {
    layerSet[0].images.forEach((icon) => {
      if (!map.hasImage(icon.name)) {
        map.loadImage(icon.url, (error, image) => {
          if (error) {
            console.error(`Failed to load icon ${icon.name}:`, error);
          } else {
            map.addImage(icon.name, image);
            // console.log(`Loaded icon: ${icon.name}`);
          }
        });
      }
    });
  }
}

function isRasterLayer(layerId) {
  const map = getMap();
  const layer = map?.getLayer(layerId);
  return layer && layer.type === "raster";
}

function isVectorLayer(layerId) {
  const map = getMap();
  const layer = map?.getLayer(layerId);
  return layer && ["fill", "line", "circle", "symbol"].includes(layer.type);
}

function getOpacityProperty(layerId) {
  const map = getMap();
  const layer = map?.getLayer(layerId);
  if (!layer) return null;

  const type = layer.type;
  if (type === "raster") return "raster-opacity";
  if (type === "fill") return "fill-opacity";
  if (type === "line") return "line-opacity";
  if (type === "circle") return "circle-opacity";
  if (type === "symbol") return "icon-opacity";
  return null;
}

function setLayerOpacity(layerId, value) {
  const map = getMap();
  if (!map) return;

  const prop = getOpacityProperty(layerId);
  if (prop && map.getLayer(layerId)) {
    map.setPaintProperty(layerId, prop, value);
    if (map.getLayer(layerId).type === "symbol") {
      try {
        map.setPaintProperty(layerId, "text-opacity", value);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function hideAllSliderLayers() {
  sliderLayers.flat().forEach((id) => {
    const map = getMap();
    if (map?.getLayer(id)) {
      setLayerOpacity(id, 0);
    }
  });
}

function removeClickListeners() {
  const map = getMap();
  if (!map) return;

  if (clickPopup) {
    clickPopup.remove();
    clickPopup = null;
  }

  sliderLayers.flat().forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.off("mouseenter", layerId);
      map.off("mouseleave", layerId);
      map.off("click", layerId);
    }
  });
}

function addClickListeners() {
  const map = getMap();
  if (!map) return;

  sliderLayers.flat().forEach((layerId) => {
    if (map.getLayer(layerId) && isVectorLayer(layerId)) {
      map.on("mouseenter", layerId, () => {
        map.getCanvas().style.cursor = "pointer";
      });

      map.on("mouseleave", layerId, () => {
        map.getCanvas().style.cursor = "";
      });

      map.on("click", layerId, (e) => {
        if (e.features.length > 0) {
          const feature = e.features[0];
          const coordinates = e.lngLat;

          if (clickPopup) {
            clickPopup.remove();
          }

          const popupContent = buildPopupContent(layerId, feature);

          clickPopup = new mapboxgl.Popup({
            closeButton: true,
            closeOnClick: true,
            maxWidth: "400px",
            offset: [0, -10],
            anchor: "bottom",
            className: "temporal-layer-popup",
          })
            .setLngLat(coordinates)
            .setHTML(popupContent)
            .addTo(map);
        }
      });
    }
  });
}

function cleanupSliderLayers() {
  const map = getMap();
  if (!map) return;

  removeClickListeners();

  sliderLayers.flat().forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });

  const sourceIds = new Set();
  sliderLayers.forEach((layerGroup) => {
    layerGroup.forEach((layerId) => {
      const layer = map.getLayer(layerId);
      if (layer && layer.source) {
        sourceIds.add(layer.source);
      }
    });
  });

  if (currentActiveLayerSet && window[currentActiveLayerSet]) {
    const layerSet = window[currentActiveLayerSet];
    layerSet.forEach((entry) => {
      if (entry.sources) {
        entry.sources.forEach((source) => {
          sourceIds.add(source.id);
        });
      } else if (entry.source) {
        sourceIds.add(entry.source.id);
      }
    });
  }

  sourceIds.forEach((sourceId) => {
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  });

  sliderLayers = [];
  currentActiveLayerSet = null;
}

function showTimeStepLayers(stepIndex) {
  hideAllSliderLayers();

  if (sliderLayers[stepIndex]) {
    sliderLayers[stepIndex].forEach((layerId) => {
      const map = getMap();
      if (map?.getLayer(layerId)) {
        setLayerOpacity(layerId, 0.75);
      }
    });
  }
}

// Add all sources/layers from a layersDef array (like updateTempSlider does),
// but DO NOT touch UI text/legend/etc. Used for restoring after style.load.
function _rebuildLayersFromDef(layersDef, currentIndex) {
  const map = getMap();
  if (!map || !Array.isArray(layersDef)) return;

  sliderLayers = [];

  // ensure icons present
  loadsliderlayertemporalIcons(layersDef);

  layersDef.forEach((entry, index) => {
    const group = [];

    // Add sources
    if (entry.sources) {
      entry.sources.forEach((source) => {
        if (!map.getSource(source.id)) {
          map.addSource(source.id, source);
        }
      });
    } else if (entry.source) {
      const { id: sourceId } = entry.source;
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, entry.source);
      }
    }

    // Add layers
    entry.layers.forEach((layerDef) => {
      group.push(layerDef.id);

      const opacityProp =
        getOpacityProperty(layerDef.id) ||
        (layerDef.type === "raster"
          ? "raster-opacity"
          : layerDef.type === "fill"
          ? "fill-opacity"
          : layerDef.type === "line"
          ? "line-opacity"
          : layerDef.type === "circle"
          ? "circle-opacity"
          : layerDef.type === "symbol"
          ? "icon-opacity"
          : null);

      // visible but 0 opacity except for the current index
      const initialOpacity =
        index === currentIndex ? layerDef.paint?.[opacityProp] ?? 0.75 : 0;

      const layerConfig = {
        ...layerDef,
        layout: {
          ...layerDef.layout,
          visibility: "visible",
        },
        paint: {
          ...layerDef.paint,
          ...(opacityProp ? { [opacityProp]: initialOpacity } : {}),
        },
      };

      if (layerDef.type === "symbol") {
        layerConfig.paint = {
          ...layerConfig.paint,
          "text-opacity": initialOpacity,
        };
      }

      if (!map.getLayer(layerDef.id)) {
        map.addLayer(layerConfig);
      } else {
        // If layer already exists (rare on style.load), just reset opacities
        if (opacityProp) {
          map.setPaintProperty(layerDef.id, opacityProp, initialOpacity);
          if (layerDef.type === "symbol") {
            try {
              map.setPaintProperty(layerDef.id, "text-opacity", initialOpacity);
            } catch {}
          }
        }
        map.setLayoutProperty(layerDef.id, "visibility", "visible");
      }
    });

    sliderLayers.push(group);
  });

  // restore click listeners
  setTimeout(addClickListeners, 300);
}

// After rendering the legend HTML into #legend-container-slider1, dynamically set legend bar widths
export function updateLegendBarWidths() {
  const legendContainer = document.getElementById("legend-container-slider1");
  if (!legendContainer) return;
  // Select all direct child divs with class bar1 or bar2 (legend bars)
  const bars = legendContainer.querySelectorAll("div.bar1, div.bar2");
  bars.forEach((bar) => {
    bar.style.flex = "1 1 0";
    bar.style.minWidth = "0";
    bar.style.width = "";
  });
}

// ===== MAIN SLIDER FUNCTION =====

function updateTempSlider(layers, textContent, layerKey, event = null) {
  const map = getMap();
  if (!map) {
    console.error("Map instance not found. Cannot initialize slider.");
    return;
  }

  const tempSlider = document.getElementById("temp-slider1");
  const slider = document.getElementById("slider1");
  const yearLabelsDiv = document.querySelector(".year-labels1");
  const legendContainer = document.getElementById("legend-container-slider1");
  const playBtn = document.getElementById("playPauseButton1"); // PLAY
  const pauseBtn = document.getElementById("playPauseButton2"); // PAUSE

  // ensure Lucide renders (in case DOM updated)
  try {
    window.lucide?.createIcons();
  } catch {}

  // Reset play/pause buttons -> show PLAY, hide PAUSE
  if (playBtn) playBtn.style.display = "inline-block";
  if (pauseBtn) pauseBtn.style.display = "none";
  clearInterval(interval);
  isPlaying = false;

  // Toggle off if same layer clicked
  if (
    tempSlider.style.display === "block" &&
    currentActiveLayerSet === layerKey
  ) {
    hideAllSliderLayers();
    cleanupSliderLayers();
    tempSlider.style.display = "none";
    if (legendContainer) legendContainer.style.display = "none";

    currentActiveLayerSet = null;
    _sliderRestore = {
      layerKey: null,
      textContent: null,
      layersDef: null,
      currentIndex: 0,
    };
    return;
  }

  // Clean up previous layers
  if (sliderLayers.length > 0) {
    hideAllSliderLayers();
    cleanupSliderLayers();
  }

  // Load icons for temporal set
  loadsliderlayertemporalIcons(layers);

  tempSlider.style.display = "block";
  sliderLayers = [];
  currentActiveLayerSet = layerKey;

  // Add layers to map
  layers.forEach((entry, index) => {
    const group = [];

    // Sources
    if (entry.sources) {
      entry.sources.forEach((source) => {
        if (!map.getSource(source.id)) {
          map.addSource(source.id, source);
        }
      });
    } else if (entry.source) {
      const { id: sourceId } = entry.source;
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, entry.source);
      }
    }

    // Layers
    entry.layers.forEach((layerDef) => {
      group.push(layerDef.id);

      if (!map.getLayer(layerDef.id)) {
        const opacityProp =
          getOpacityProperty(layerDef.id) ||
          (layerDef.type === "raster"
            ? "raster-opacity"
            : layerDef.type === "fill"
            ? "fill-opacity"
            : layerDef.type === "line"
            ? "line-opacity"
            : layerDef.type === "circle"
            ? "circle-opacity"
            : layerDef.type === "symbol"
            ? "icon-opacity"
            : null);

        let initialOpacity = 0;
        if (index === 0) {
          initialOpacity =
            layerDef.paint?.[opacityProp] !== undefined
              ? layerDef.paint[opacityProp]
              : 0.75;
        }

        const layerConfig = {
          ...layerDef,
          layout: { ...layerDef.layout, visibility: "visible" },
          paint: {
            ...layerDef.paint,
            ...(opacityProp ? { [opacityProp]: initialOpacity } : {}),
          },
        };

        if (layerDef.type === "symbol") {
          layerConfig.paint = {
            ...layerConfig.paint,
            "text-opacity": initialOpacity,
          };
        }

        map.addLayer(layerConfig);
      } else {
        map.setLayoutProperty(layerDef.id, "visibility", "visible");
        let initialOpacity = 0;
        if (index === 0) {
          const opacityProp = getOpacityProperty(layerDef.id);
          initialOpacity =
            layerDef.paint?.[opacityProp] !== undefined
              ? layerDef.paint[opacityProp]
              : 0.75;
        }
        setLayerOpacity(layerDef.id, initialOpacity);
      }
    });

    sliderLayers.push(group);
  });

  // Click listeners
  setTimeout(addClickListeners, 500);

  // Render time labels
  if (yearLabelsDiv) {
    yearLabelsDiv.innerHTML = "";
    layers.forEach((l) => {
      const span = document.createElement("span");
      span.textContent = l.date;
      span.style.marginRight = "10px";
      yearLabelsDiv.appendChild(span);
    });
  }

  // Setup slider range
  const sliderEl = document.getElementById("slider1");
  if (sliderEl) {
    sliderEl.max = layers.length - 1;
    sliderEl.value = 0;
  }

  const titleElement = document.querySelector("#temp-slider1 p");
  if (titleElement) {
    titleElement.textContent = textContent;
  }

  // Load legend
  if (typeof legends !== "undefined" && legends[layerKey]) {
    if (legendContainer) {
      legendContainer.innerHTML = legends[layerKey];
      legendContainer.style.display = "block";
    }
  } else if (legendContainer) {
    legendContainer.style.display = "none";
  }

  // After legend HTML is set:
  updateLegendBarWidths();

  // Show first frame when map idle
  map.once("idle", () => {
    showTimeStepLayers(0);
  });

  // Save restore info for style.load
  _sliderRestore = {
    layerKey,
    textContent,
    layersDef: layers,
    currentIndex: 0,
  };

  // Bind a single style.load handler that restores temporal layers
  if (!_styleLoadHandlerBound) {
    map.on("style.load", () => {
      // If a temporal slider is active, rebuild its layers
      const tempSlider = document.getElementById("temp-slider1");
      if (
        tempSlider &&
        tempSlider.style.display === "block" &&
        _sliderRestore.layersDef &&
        _sliderRestore.layerKey === currentActiveLayerSet
      ) {
        // clean any remnants, then rebuild to current index
        removeClickListeners();
        _rebuildLayersFromDef(
          _sliderRestore.layersDef,
          _sliderRestore.currentIndex
        );
      }
    });
    _styleLoadHandlerBound = true;
  }
}

// ===== SLIDER CONTROLS =====

document.addEventListener("DOMContentLoaded", function () {
  const playBtn = document.getElementById("playPauseButton1"); // PLAY
  const pauseBtn = document.getElementById("playPauseButton2"); // PAUSE
  const slider = document.getElementById("slider1");
  const speedBtn = document.getElementById("speedControlButton");

  // Render Lucide icons on load
  try {
    window.lucide?.createIcons();
  } catch {}

  // Initialize drag and resize
  initDragResize();

  // Initialize speed label
  if (speedBtn) {
    speedBtn.textContent = speedLevels[currentSpeedIndex] + "x";
  }

  function playAnimation() {
    interval = setInterval(() => {
      const maxVal = parseInt(slider.max);
      let currentVal = parseInt(slider.value);
      const nextVal = currentVal < maxVal ? currentVal + 1 : 0;
      slider.value = nextVal;
      _sliderRestore.currentIndex = nextVal; // keep in sync for style.load restore
      showTimeStepLayers(nextVal);
    }, 1000 / speedLevels[currentSpeedIndex]);
  }

  // --- Clean 2-button toggle for Lucide ---
  if (playBtn) {
    playBtn.addEventListener("click", () => {
      isPlaying = true;
      clearInterval(interval);
      playAnimation();

      // Toggle visibility: hide PLAY, show PAUSE
      playBtn.style.display = "none";
      if (pauseBtn) pauseBtn.style.display = "inline-block";

      // Make sure icons render
      try {
        window.lucide?.createIcons();
      } catch {}
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      isPlaying = false;
      clearInterval(interval);

      // Toggle visibility back: show PLAY, hide PAUSE
      if (playBtn) playBtn.style.display = "inline-block";
      pauseBtn.style.display = "none";

      try {
        window.lucide?.createIcons();
      } catch {}
    });
  }

  // Slider scrub
  if (slider) {
    slider.addEventListener("input", () => {
      const val = parseInt(slider.value);
      _sliderRestore.currentIndex = val; // keep in sync
      showTimeStepLayers(val);
    });
  }

  // Speed button
  if (speedBtn) {
    speedBtn.addEventListener("click", () => {
      currentSpeedIndex = (currentSpeedIndex + 1) % speedLevels.length;
      speedBtn.textContent = speedLevels[currentSpeedIndex] + "x";
      if (isPlaying) {
        clearInterval(interval);
        playAnimation();
      }
    });
  }
});

// ===== EXPOSE FUNCTIONS GLOBALLY =====
window.updateTempSlider = updateTempSlider;
window.hideAllSliderLayers = hideAllSliderLayers;
window.cleanupSliderLayers = cleanupSliderLayers;
