// Layer interaction logging system - tracks state and logs interactions

// Import the menu configuration to access item data
import { ncop_menu_items } from './map-layers.js';

// In-memory state tracking for all items
const layerStates = new Map();

// Global SourceLayerControl instance reference (will be set by dashboard initialization)
let sourceLayerControl = null;

/**
 * Initialize state for an item if it doesn't exist
 */
function initializeItemState(categoryKey, subcategoryKey, itemKey) {
    const stateKey = `${categoryKey}.${subcategoryKey}.${itemKey}`;
    if (!layerStates.has(stateKey)) {
        layerStates.set(stateKey, { active: false });
    }
    return stateKey;
}

/**
 * Get the item data from map-layers.js configuration
 */
function getItemData(categoryKey, subcategoryKey, itemKey, itemType) {
    try {
        const categoryData = ncop_menu_items[categoryKey];
        if (!categoryData) return null;
        
        const subcategoryData = categoryData[subcategoryKey];
        if (!subcategoryData) return null;
        
        const typeData = subcategoryData[itemType];
        if (!typeData) return null;
        
        return typeData[itemKey];
    } catch (error) {
        console.error(`❌ Error getting item data for ${categoryKey}.${subcategoryKey}.${itemKey}:`, error);
        return null;
    }
}

/**
 * Initialize the SourceLayerControl instance
 */
export function initializeSourceLayerControl(sourceLayerControlInstance) {
    sourceLayerControl = sourceLayerControlInstance;
    // console.log('🗺️ SourceLayerControl reference initialized for layer management');
}



/**
 * Handle toggle item interactions (checkboxes)
 */
export function handleToggleInteraction(categoryKey, subcategoryKey, itemKey, isChecked) {
    const stateKey = initializeItemState(categoryKey, subcategoryKey, itemKey);
    const itemData = getItemData(categoryKey, subcategoryKey, itemKey, 'toggle');
    
    // Update state
    layerStates.set(stateKey, { active: isChecked });
    
    // Log the interaction with full item data
    // console.log('🔄 TOGGLE INTERACTION:', {
    //     category: categoryKey,
    //     subcategory: subcategoryKey,
    //     itemKey: itemKey,
    //     itemData: itemData,
    //     active: isChecked,
    //     stateKey: stateKey
    // });
      // Handle layer management using SourceLayerControl
    if (sourceLayerControl && itemData && itemData.source && itemData.layers) {
        if (isChecked) {
            // Add layer to map
            sourceLayerControl.addLayerByKey(itemKey);
        } else {
            // Remove layer from map
            sourceLayerControl.removeLayerByKey(itemKey);
        }
    }
}


/**
 * Handle dropdown item interactions (select changes)
 */
export function handleDropdownInteraction(categoryKey, subcategoryKey, selectedValue, selectedLabel) {
    const stateKey = initializeItemState(categoryKey, subcategoryKey, 'dropdown');
    const itemData = getItemData(categoryKey, subcategoryKey, 'dropdown', 'dropdown');
    
    const isActive = selectedValue && selectedValue !== '';
    
    // Update state
    layerStates.set(stateKey, { 
        active: isActive,
        selectedValue: selectedValue,
        selectedLabel: selectedLabel
    });
    
    // Log the interaction with full item data
    // console.log('📋 DROPDOWN INTERACTION:', {
    //     category: categoryKey,
    //     subcategory: subcategoryKey,
    //     itemKey: 'dropdown',
    //     itemData: itemData,
    //     active: isActive,
    //     selectedValue: selectedValue,
    //     selectedLabel: selectedLabel,
    //     stateKey: stateKey
    // });
}

/**
 * Handle button item interactions (button clicks)
 */
export function handleButtonInteraction(categoryKey, subcategoryKey, itemKey) {
    const stateKey = initializeItemState(categoryKey, subcategoryKey, itemKey);
    const itemData = getItemData(categoryKey, subcategoryKey, itemKey, 'button');
    
    // Toggle the current state
    const currentState = layerStates.get(stateKey);
    const newActive = !currentState.active;
    
    // Update state
    layerStates.set(stateKey, { active: newActive });
    
    // Log the interaction with full item data
    // console.log('🔘 BUTTON INTERACTION:', {
    //     category: categoryKey,
    //     subcategory: subcategoryKey,
    //     itemKey: itemKey,
    //     itemData: itemData,
    //     active: newActive,
    //     stateKey: stateKey
    // });
      // Handle layer management using SourceLayerControl
    if (sourceLayerControl && itemData && itemData.source && itemData.layers) {
        if (newActive) {
            // Add layer to map
            sourceLayerControl.addLayerByKey(itemKey);
        } else {
            // Remove layer from map
            sourceLayerControl.removeLayerByKey(itemKey);
        }
    }
    
    return newActive;
}

/**
 * Get current state of an item
 */
export function getItemState(categoryKey, subcategoryKey, itemKey) {
    const stateKey = `${categoryKey}.${subcategoryKey}.${itemKey}`;
    return layerStates.get(stateKey) || { active: false };
}

/**
 * Get all current states (for debugging)
 */
export function getAllStates() {
    return Object.fromEntries(layerStates);
}

/**
 * Clear all states
 */
export function clearAllStates() {
    layerStates.clear();
    // console.log('🗑️ All layer states cleared');
}
//temporal handler
export function handleTemporalInteraction(
  categoryKey,
  subcategoryKey,
  itemKey,
  isActive,
  layerConfig  // Add this parameter to receive the config object
) {
  console.log(`🔄 Temporal interaction: ${itemKey}, isActive: ${isActive}`);

  if (isActive) {
    // Get layer array from window
    const layerArray = window[itemKey];

    if (!layerArray) {
      console.error(`❌ Layer array not found: ${itemKey}`);
      return;
    }

    console.log(`✅ Found layer array:`, layerArray.length, "steps");

    // Extract title from layer config
    const title = layerConfig?.title || subcategoryKey; // Fallback to subcategoryKey if no title

    // Call the global function with the title
    if (typeof window.updateTempSlider === "function") {
      window.updateTempSlider(layerArray, title, itemKey, null);
      console.log(`✅ Slider initialized`);
    } else {
      console.error("❌ updateTempSlider function not found");
    }
  } else {
    // Hide slider when deselected
    console.log(`🔴 Hiding slider for: ${itemKey}`);

    const tempSlider = document.getElementById("temp-slider1");
    if (tempSlider) {
      tempSlider.style.display = "none";
    }

    // Call global cleanup functions
    if (typeof window.hideAllSliderLayers === "function") {
      window.hideAllSliderLayers();
    }
    if (typeof window.cleanupSliderLayers === "function") {
      window.cleanupSliderLayers();
    }
  }
}
//static handler

/**
 * Handle static item interactions (WMS raster layers)
 */
export function handleStaticInteraction(categoryKey, subcategoryKey, itemKey, isChecked) {
  const stateKey = initializeItemState(categoryKey, subcategoryKey, itemKey);
  const itemData = getItemData(categoryKey, subcategoryKey, itemKey, 'static');
  
  // Update state
  layerStates.set(stateKey, { active: isChecked });
  
  // Log the interaction with full item data
  console.log('🗺️ STATIC INTERACTION:', {
      category: categoryKey,
      subcategory: subcategoryKey,
      itemKey: itemKey,
      itemData: itemData,
      active: isChecked,
      stateKey: stateKey
  });

  // Handle layer management using SourceLayerControl
  if (sourceLayerControl && itemData) {
    if (!itemData.source || !itemData.layers) {
      console.error(`❌ Static layer "${itemKey}" missing source or layers configuration:`, itemData);
      return;
    }

    try {
      if (isChecked) {
        // Add layer to map
        console.log(`✅ Adding static layer "${itemKey}" to map`);
        const success = sourceLayerControl.addLayerByKey(itemKey);
        if (!success) {
          console.error(`❌ Failed to add static layer "${itemKey}" to map`);
        } else {
          console.log(`✅ Successfully added static layer "${itemKey}" to map`);
        }
      } else {
        // Remove layer from map
        console.log(`🔴 Removing static layer "${itemKey}" from map`);
        const success = sourceLayerControl.removeLayerByKey(itemKey);
        if (!success) {
          console.error(`❌ Failed to remove static layer "${itemKey}" from map`);
        } else {
          console.log(`✅ Successfully removed static layer "${itemKey}" from map`);
        }
      }
    } catch (error) {
      console.error(`❌ Error handling static layer "${itemKey}":`, error);
    }
  } else {
    console.error(`❌ SourceLayerControl not available or itemData missing for "${itemKey}"`);
    console.log('sourceLayerControl:', sourceLayerControl);
    console.log('itemData:', itemData);
  }
}
/**
 * DEW Exposure Dropdown Checkbox Handler
 * Handles checkbox interactions for exposure items in the dropdown
 * Uses SourceLayerControl for map operations
 */

const exposureLayersMap = new Map(); // Track: exposureId -> {layerId, outlineId, sourceId}

/**
 * Get SourceLayerControl instance
 */
function getSourceLayerControl() {
  return window.sourceLayerControl;
}

/**
 * Get map instance
 */
function getMap() {
  return window.map || (window.sourceLayerControl?.map);
}

/**
 * Remove polygon layers for a specific exposure
 */
function removeExposureLayersById(exposureId) {
  // Try both local and global exposureLayersMap
  let layerInfo = exposureLayersMap.get(exposureId);
  if (!layerInfo && window.exposureLayersMap) {
    layerInfo = window.exposureLayersMap.get(exposureId);
  }
  if (!layerInfo) return;

  const { layerId, outlineId, sourceId } = layerInfo;
  const map = getMap();

  // Remove layers from map
  if (map && map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map && map.getLayer(outlineId)) {
    map.removeLayer(outlineId);
  }
  // Remove source
  if (map && map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }

  exposureLayersMap.delete(exposureId);
  if (window.exposureLayersMap) {
    window.exposureLayersMap.delete(exposureId);
  }
  console.log(`🗑️ Exposure layers removed for ID: ${exposureId}`);
}

/**
 * Add exposure polygon to map from GeoJSON
 */
function addExposurePolygonToMap(exposureId, geojson) {
  if (!geojson || !geojson.features || geojson.features.length === 0) {
    console.error(`❌ No features found for exposure ${exposureId}`);
    return;
  }

  const map = getMap();
  if (!map) {
    console.error(`❌ Map instance not available`);
    return;
  }

  const layerId = `exposure-polygon-${exposureId}`;
  const outlineId = `exposure-outline-${exposureId}`;
  const sourceId = `exposure-source-${exposureId}`;

  // Always remove existing layers and source before adding new ones
  if (map.getLayer(layerId)) {
    map.removeLayer(layerId);
  }
  if (map.getLayer(outlineId)) {
    map.removeLayer(outlineId);
  }
  if (map.getSource(sourceId)) {
    map.removeSource(sourceId);
  }

  try {
    // Add GeoJSON source
    map.addSource(sourceId, {
      type: "geojson",
      data: geojson
    });

    // Add filled polygon layer
    map.addLayer({
      id: layerId,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": "#ff0000",
        "fill-opacity": 0.6
      }
    });

    // Add outline layer
    map.addLayer({
      id: outlineId,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#ff0000",
        "line-width": 2,
        "line-opacity": 1
      }
    });

    // Store layer info
    if (!window.exposureLayersMap) {
      window.exposureLayersMap = new Map();
    }
    window.exposureLayersMap.set(exposureId, { layerId, outlineId, sourceId });

    // Zoom to polygon bounds
    const coords = geojson.features[0].geometry.coordinates[0];
    const bounds = coords.reduce(
      (b, coord) => b.extend(coord),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 40 });

    console.log(`✅ Exposure ${exposureId} added to map`);
  } catch (error) {
    console.error(`❌ Error adding exposure polygon:`, error);
  }
}

/**
 * Handle DEW exposure checkbox interaction
 * @param {string} exposureId - The exposure ID
 * @param {boolean} isChecked - Checkbox state
 */
export async function handleDewExposureCheckbox(exposureId, isChecked) {
  console.log(`🔄 DEW Exposure: ID=${exposureId}, checked=${isChecked}`);

  if (isChecked) {
    // Fetch and add to map
    try {
      const endpoint = `http://172.18.1.108:8000/get-exposures/?exposure_id=${exposureId}`;
      console.log(`📡 Fetching: ${endpoint}`);
      
      const response = await fetch(endpoint);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const geojson = await response.json();
      addExposurePolygonToMap(exposureId, geojson);
    } catch (error) {
      console.error(`❌ Error:`, error);
    }
  } else {
    // Remove from map: always remove source and layers for this exposureId
    removeExposureLayersById(exposureId);
    // Also remove from window.exposureLayersMap if present
    if (window.exposureLayersMap) {
      window.exposureLayersMap.delete(exposureId);
    }
  }
}

/**
 * Clear all exposure layers
 */
export function clearAllExposureLayersFromMap() {
  exposureLayersMap.forEach((_, exposureId) => {
    console.log(`🗑️ Clearing exposure ID: ${exposureId}`);
    removeExposureLayersById(exposureId);
  });
}
