// time-slider-functionality.js
// Updated to work with DashboardManager's private map instance

// ===== GLOBAL VARIABLES =====
let sliderLayers = [];
let isPlaying = false;
let interval;
const speedLevels = [0.5, 1, 2, 3];
let currentSpeedIndex = 1;
let currentActiveLayerSet = null;
let clickPopup = null;

// Helper to get the map instance from DashboardManager
function getMap() {
  if (!window.ncop_map) {
    console.error("❌ Map not initialized. Make sure DashboardManager exposed window.ncop_map");
    return null;
  }
  return window.ncop_map;
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
            console.log(`Loaded icon: ${icon.name}`);
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
        // Ignore if text-opacity doesn't exist
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

          let popupContent = '<div style="max-width: 200px; font-size: 12px;">';
          popupContent += `<strong>Layer:</strong> ${layerId}<br>`;

          if (feature.properties) {
            Object.entries(feature.properties).forEach(([key, value]) => {
              if (value !== null && value !== undefined && value !== "") {
                popupContent += `<strong>${key}:</strong> ${value}<br>`;
              }
            });
          }

          popupContent += "</div>";

          clickPopup = new mapboxgl.Popup({
            closeButton: true,
            closeOnClick: true,
            maxWidth: "300px",
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
  const playPauseBtn = document.getElementById("playPauseButton1");
  const icon = playPauseBtn?.querySelector("i");

  // Reset play/pause button
  if (icon) {
    icon.classList.replace("fa-pause", "fa-play");
  }
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

    // Remove active highlighting from images
    document
      .querySelectorAll(".ncop-item-image.selected")
      .forEach((img) => img.classList.remove("selected"));

    currentActiveLayerSet = null;
    console.log(`✅ Slider closed for: ${layerKey}`);
    return;
  }

  // Clean up previous layers
  if (sliderLayers.length > 0) {
    hideAllSliderLayers();
    cleanupSliderLayers();
  }

  // Load icons
  loadsliderlayertemporalIcons(layers);

  // Update UI
  document
    .querySelectorAll(".ncop-item-image.selected")
    .forEach((img) => img.classList.remove("selected"));

  if (event?.target) {
    event.target.closest(".ncop-item-image")?.classList.add("selected");
  }

  tempSlider.style.display = "block";
  sliderLayers = [];
  currentActiveLayerSet = layerKey;

  console.log(`🔄 Initializing slider for: ${layerKey} with ${layers.length} steps`);

  // Add layers to map
  layers.forEach((entry, index) => {
    const group = [];

    // Handle sources
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

      if (!map.getLayer(layerDef.id)) {
        const opacityProp = getOpacityProperty(layerDef.id) ||
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

  // Add click listeners
  setTimeout(() => {
    addClickListeners();
  }, 500);

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

  // Setup slider
  if (slider) {
    slider.max = layers.length - 1;
    slider.value = 0;
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

  // Show first frame
  map.once("idle", () => {
    showTimeStepLayers(0);
    console.log(`✅ Slider ready: ${layerKey}`);
  });
}

// ===== SLIDER CONTROLS =====

document.addEventListener("DOMContentLoaded", function () {
  const playPauseBtn = document.getElementById("playPauseButton1");
  const slider = document.getElementById("slider1");
  const speedBtn = document.getElementById("speedControlButton");

  if (speedBtn) {
    speedBtn.textContent = speedLevels[currentSpeedIndex] + "x";
  }

  function playAnimation() {
    interval = setInterval(() => {
      const maxVal = parseInt(slider.max);
      let currentVal = parseInt(slider.value);

      const nextVal = currentVal < maxVal ? currentVal + 1 : 0;
      slider.value = nextVal;

      showTimeStepLayers(nextVal);
    }, 1000 / speedLevels[currentSpeedIndex]);
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener("click", () => {
      isPlaying = !isPlaying;
      const icon = playPauseBtn.querySelector("i");
      if (icon) {
        icon.setAttribute("data-lucide", isPlaying ? "pause" : "play");
        // Refresh lucide icons
        if (window.lucide?.createIcons) {
          window.lucide.createIcons();
        }
      }
      clearInterval(interval);
      if (isPlaying) playAnimation();
    });
  }

  if (slider) {
    slider.addEventListener("input", () => {
      const val = parseInt(slider.value);
      showTimeStepLayers(val);
    });
  }

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