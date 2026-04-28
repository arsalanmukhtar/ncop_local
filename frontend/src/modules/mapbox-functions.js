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
 * Get the item data from map-layers.js configuration (updated to handle nested sections)
 */
function getItemData(categoryKey, subcategoryKey, itemKey, itemType) {
  try {
      const categoryData = ncop_menu_items[categoryKey];
      if (!categoryData) return null;
      
      const subcategoryData = categoryData[subcategoryKey];
      if (!subcategoryData) return null;
      
      // First check direct items
      const typeData = subcategoryData[itemType];
      if (typeData && typeData[itemKey]) {
          return typeData[itemKey];
      }

      // 🔥 NEW: Check nested sections (for GDACS)
      const nestedSections = subcategoryData.nested || subcategoryData.subsections;
      if (nestedSections && typeof nestedSections === "object") {
          for (const nestedKey in nestedSections) {
              const nestedSection = nestedSections[nestedKey];
              const nestedTypeData = nestedSection[itemType];
              if (nestedTypeData && nestedTypeData[itemKey]) {
                  return nestedTypeData[itemKey];
              }
          }
      }
      
      return null;
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
 * Toggle a spinner on a sidebar item while its source is loading.
 * We listen for the first `sourcedata` event that reports the source as
 * loaded, then remove the loading class. Safety timeout of 20s in case the
 * event never fires (e.g. source errors out).
 */
function showLayerLoading(itemKey, sourceId) {
    const row = document.querySelector(
        `.ncop-item[data-item-key="${itemKey}"], input[data-item-key="${itemKey}"]`
    );
    const itemEl = row?.closest?.(".ncop-item") || row;
    if (!itemEl) return;
    itemEl.classList.add("is-loading");

    const map = window.ncop_map || window.map;
    if (!map || !sourceId) {
        setTimeout(() => itemEl.classList.remove("is-loading"), 600);
        return;
    }

    let done = false;
    const finish = () => {
        if (done) return;
        done = true;
        itemEl.classList.remove("is-loading");
        map.off("sourcedata", onData);
        clearTimeout(bailout);
    };
    const onData = (e) => {
        if (e.sourceId === sourceId && e.isSourceLoaded) finish();
    };
    map.on("sourcedata", onData);
    // Safety net: never leave the spinner spinning forever.
    const bailout = setTimeout(finish, 20000);
}

/**
 * Handle toggle item interactions (checkboxes)
 */
export function handleToggleInteraction(categoryKey, subcategoryKey, itemKey, isChecked) {
    const stateKey = initializeItemState(categoryKey, subcategoryKey, itemKey);
    const itemData = getItemData(categoryKey, subcategoryKey, itemKey, 'toggle');

    layerStates.set(stateKey, { active: isChecked });

    if (sourceLayerControl && itemData && itemData.source && itemData.layers) {
        if (isChecked) {
            showLayerLoading(itemKey, itemData.source.id);
            sourceLayerControl.addLayerByKey(itemKey);
        } else {
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
  layerConfig
) {
  // Unified temporal flow. Each temporal item exposes its layer set on
  // `window[itemKey]`, which can be one of:
  //   * Array<entry>            — pre-baked frames (DWD, IMERG, ECMWF, ...)
  //   * Promise<Array<entry>>   — descriptor-driven, already in-flight
  //   * () => Array | Promise   — descriptor-driven, lazily resolved on click
  //                                (e.g. RainViewer radar / satellite-IR)
  //
  // Either form goes through the standard #temp-slider1 controller, so its
  // `currentActiveLayerSet` enforces single-select replacement across every
  // temporal layer in the app — toggling a new one tears down whichever was
  // previously active, regardless of which group it came from.
  if (isActive) {
    let layerSrc = window[itemKey];

    if (typeof layerSrc === "function") {
      try {
        layerSrc = layerSrc();
      } catch (err) {
        console.error(`❌ Layer builder threw for ${itemKey}:`, err);
        return;
      }
    }

    if (!layerSrc) {
      console.error(`❌ Layer array not found: ${itemKey}`);
      return;
    }

    const title = layerConfig?.title || subcategoryKey;
    const isAsync = typeof layerSrc?.then === "function";

    if (isAsync) {
      if (typeof window.updateTempSliderAsync === "function") {
        window.updateTempSliderAsync(layerSrc, title, itemKey);
      } else {
        console.error("❌ updateTempSliderAsync function not found");
      }
    } else {
      if (typeof window.updateTempSlider === "function") {
        window.updateTempSlider(layerSrc, title, itemKey, null);
      } else {
        console.error("❌ updateTempSlider function not found");
      }
    }
  } else {
    const tempSlider = document.getElementById("temp-slider1");
    if (tempSlider) tempSlider.style.display = "none";

    if (typeof window.hideAllSliderLayers === "function") {
      window.hideAllSliderLayers();
    }
    if (typeof window.cleanupSliderLayers === "function") {
      window.cleanupSliderLayers();
    }
  }
}


// Replace the loadGdacsImagesFromData function (around line 217):
/**
 * Load GDACS images from GeoJSON data dynamically
 */
async function loadGdacsImagesFromData(map, itemKey, itemData) {
  if (!itemKey.includes('gdacs_') || !itemData.source?.data) {
    return;
  }

  try {
    //console.log(`🔄 Fetching GDACS data from: ${itemData.source.data}`);
    
    // Fetch the GeoJSON data to extract icon URLs
    const response = await fetch(itemData.source.data);
    if (!response.ok) {
      console.warn(`⚠️ Failed to fetch GDACS data: ${response.status}`);
      return;
    }
    
    const geojson = await response.json();
    const imageUrls = new Set();
    
    // Extract all unique icon URLs from features
    if (geojson.features) {
      geojson.features.forEach(feature => {
        if (feature.properties) {
          const iconUrl = feature.properties.icon || 
                         feature.properties.iconeventlink || 
                         feature.properties.iconitemlink;
          if (iconUrl && iconUrl.startsWith('http')) {
            imageUrls.add(iconUrl);
          }
        }
      });
    }

    //console.log(`🖼️ Found ${imageUrls.size} unique GDACS icon URLs to load`);

    // Special handling for TC events - check if no images found but we have TC data
    if (imageUrls.size === 0 && itemKey === 'gdacs_tc_events' && geojson.features?.length > 0) {
      //console.log(`🔄 TC events found but no icon URLs, creating default TC icons`);
      // Create default TC icon URLs for common alert levels
      const defaultTcIcons = [
        'https://www.gdacs.org/images/gdacs_icons/maps/Green/TC.png',
        'https://www.gdacs.org/images/gdacs_icons/maps/Orange/TC.png',
        'https://www.gdacs.org/images/gdacs_icons/maps/Red/TC.png'
      ];
      defaultTcIcons.forEach(url => imageUrls.add(url));
    }

    // Load each unique image using the full URL as the image ID
    const loadPromises = Array.from(imageUrls).map(async (iconUrl) => {
      try {
        if (!map.hasImage(iconUrl)) {
          //console.log(`🔄 Loading image: ${iconUrl}`);
          
          // Try to load the image
          const img = new Image();
          img.crossOrigin = 'anonymous';
          
          return new Promise((resolve) => {
            img.onload = () => {
              try {
                map.addImage(iconUrl, img); // Use full URL as image ID
                //console.log(`✅ Successfully loaded image: ${iconUrl}`);
                resolve();
              } catch (e) {
                console.warn(`⚠️ Failed to add image ${iconUrl}:`, e);
                resolve(); // Don't reject, continue with other images
              }
            };
            
            img.onerror = () => {
              console.warn(`⚠️ Failed to load image from URL: ${iconUrl}, creating fallback`);
              
              try {
                // Create fallback image if loading fails
                const size = 24;
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                
                // Clear canvas
                ctx.clearRect(0, 0, size, size);
                
                // Color based on alert level and hazard type
                const alertColor = iconUrl.includes('Green') ? '#00FF00' : 
                                 iconUrl.includes('Orange') ? '#FFA500' : 
                                 iconUrl.includes('Red') ? '#FF0000' : '#666666';
                
                ctx.fillStyle = alertColor;
                ctx.beginPath();
                ctx.arc(size/2, size/2, (size/2) - 2, 0, 2 * Math.PI);
                ctx.fill();
                
                // Add border
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 1;
                ctx.stroke();
                
                // Add hazard type text
                ctx.fillStyle = 'white';
                ctx.font = 'bold 8px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                
                // Extract hazard type from URL
                let hazardType = '?';
                if (iconUrl.includes('/TC.png')) hazardType = 'TC';
                else if (iconUrl.includes('/FL.png')) hazardType = 'FL';
                else if (iconUrl.includes('/EQ.png')) hazardType = 'EQ';
                else if (iconUrl.includes('/VO.png')) hazardType = 'VO';
                else if (iconUrl.includes('/WF.png')) hazardType = 'WF';
                else if (iconUrl.includes('/DR.png')) hazardType = 'DR';
                
                ctx.fillText(hazardType, size/2, size/2);
                
                // Get image data and add to map
                const imageData = ctx.getImageData(0, 0, size, size);
                map.addImage(iconUrl, {
                  width: size,
                  height: size,
                  data: imageData.data
                });
                
                //console.log(`✅ Created fallback image: ${iconUrl}`);
              } catch (e) {
                console.warn(`⚠️ Failed to add fallback image ${iconUrl}:`, e);
              }
              
              resolve();
            };
            
            img.src = iconUrl;
          });
        } else {
          //console.log(`ℹ️ Image already exists: ${iconUrl}`);
          return Promise.resolve();
        }
      } catch (error) {
        console.warn(`⚠️ Error processing image ${iconUrl}:`, error);
        return Promise.resolve();
      }
    });

    // Wait for all images to load
    await Promise.all(loadPromises);
    //console.log(`✅ All GDACS images processed for ${itemKey}`);
    
  } catch (error) {
    console.warn(`⚠️ Error loading GDACS images for ${itemKey}:`, error);
  }
}


// Add this event listener for missing images (place this after the existing functions)
// Replace the setupGdacsMissingImageHandler function (around line 365):
/**
 * Handle missing images dynamically
 */
function setupGdacsMissingImageHandler() {
  // Use the correct global map reference
  const map = window.ncop_map || window.map;
  if (!map || typeof map.on !== 'function') {
    console.warn('Map not ready for GDACS image handler setup');
    return;
  }

  //console.log('🔄 Setting up GDACS missing image handler');

  map.on('styleimagemissing', (e) => {
    const imageId = e.id;
    
    //console.log(`⚠️ Missing image detected: ${imageId}`);
    
    // Handle GDACS image URLs
    if (imageId.startsWith('https://www.gdacs.org/images/gdacs_icons/maps/')) {
      //console.log(`🔄 Creating fallback for GDACS image: ${imageId}`);
      
      try {
        // Create a properly sized canvas for Mapbox
        const size = 24;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        // Clear the canvas with transparent background
        ctx.clearRect(0, 0, size, size);
        
        // Color based on alert level
        let color = '#666666';
        let text = '?';
        
        if (imageId.includes('Green')) {
          color = '#00FF00';
        } else if (imageId.includes('Orange')) {
          color = '#FFA500';
        } else if (imageId.includes('Red')) {
          color = '#FF0000';
        }
        
        // Extract hazard type from URL
        if (imageId.includes('/TC.png')) text = 'TC';
        else if (imageId.includes('/FL.png')) text = 'FL';
        else if (imageId.includes('/EQ.png')) text = 'EQ';
        else if (imageId.includes('/VO.png')) text = 'VO';
        else if (imageId.includes('/WF.png')) text = 'WF';
        else if (imageId.includes('/DR.png')) text = 'DR';
        
        // Draw the circle
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(size/2, size/2, (size/2) - 2, 0, 2 * Math.PI);
        ctx.fill();
        
        // Add border
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 1;
        ctx.stroke();
        
        // Add text
        ctx.fillStyle = 'white';
        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, size/2, size/2);
        
        // Create ImageData object with proper format for Mapbox
        const imageData = ctx.getImageData(0, 0, size, size);
        
        // Add image to map using ImageData
        map.addImage(imageId, {
          width: size,
          height: size,
          data: imageData.data
        });
        
        //console.log(`✅ Created missing image fallback: ${imageId}`);
      } catch (error) {
        console.warn(`⚠️ Failed to create fallback image ${imageId}:`, error);
        
        // Try alternative fallback method
        try {
          const alternativeCanvas = document.createElement('canvas');
          alternativeCanvas.width = 20;
          alternativeCanvas.height = 20;
          const altCtx = alternativeCanvas.getContext('2d');
          
          altCtx.fillStyle = '#FF0000';
          altCtx.fillRect(0, 0, 20, 20);
          
          const altImageData = altCtx.getImageData(0, 0, 20, 20);
          map.addImage(imageId, {
            width: 20,
            height: 20,
            data: altImageData.data
          });
          
          //console.log(`✅ Created simple fallback for: ${imageId}`);
        } catch (altError) {
          console.warn(`⚠️ Even alternative fallback failed for ${imageId}:`, altError);
        }
      }
    }
  });
  
  //console.log('✅ GDACS missing image handler setup complete');
}
// Initialize GDACS image handler when map is ready
function initGdacsImageHandler() {
  const map = window.ncop_map || window.map;
  if (map && typeof map.on === 'function') {
    setupGdacsMissingImageHandler();
    return;
  }
  
  // Wait for map to be available
  let attempts = 0;
  const maxAttempts = 50; // 5 seconds max wait
  const checkMapInterval = setInterval(() => {
    attempts++;
    const map = window.ncop_map || window.map;
    if (map && typeof map.on === 'function') {
      setupGdacsMissingImageHandler();
      clearInterval(checkMapInterval);
    } else if (attempts >= maxAttempts) {
      console.warn('Failed to setup GDACS image handler: map not available after 5 seconds');
      clearInterval(checkMapInterval);
    }
  }, 100);
}

// Initialize when the module loads
if (typeof window !== 'undefined') {
  // Try immediate setup
  initGdacsImageHandler();
  
  // Also setup on DOMContentLoaded as fallback
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGdacsImageHandler);
  }
}

// Export the function if needed by other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { loadGdacsImagesFromData, setupGdacsMissingImageHandler };
}
//static handler
/**
 * Handle static item interactions (WMS raster layers + GDACS GeoJSON layers)
 */
export async function handleStaticInteraction(categoryKey, subcategoryKey, itemKey, isChecked) {
  const stateKey = initializeItemState(categoryKey, subcategoryKey, itemKey);
  const itemData = getItemData(categoryKey, subcategoryKey, itemKey, 'static');
  
  // Update state
  layerStates.set(stateKey, { active: isChecked });
  
  // // Log the interaction with full item data
  // console.log('🗺️ STATIC INTERACTION:', {
  //     category: categoryKey,
  //     subcategory: subcategoryKey,
  //     itemKey: itemKey,
  //     itemData: itemData,
  //     active: isChecked,
  //     stateKey: stateKey
  // });

  // 🔥 IMPROVED: Better error handling for missing configurations
  if (!sourceLayerControl) {
    console.error(`❌ SourceLayerControl not available for "${itemKey}"`);
    return;
  }

  if (!itemData) {
    console.error(`❌ Item data missing for "${itemKey}". Checking nested sections...`);
    
    // Try to find the item in nested sections manually
    try {
      const categoryData = ncop_menu_items[categoryKey];
      const subcategoryData = categoryData[subcategoryKey];
      const nestedSections = subcategoryData.nested || subcategoryData.subsections;
      
      if (nestedSections) {
        console.debug(`🔍 Searching nested sections for "${itemKey}":`, Object.keys(nestedSections));
        
        for (const nestedKey in nestedSections) {
          const nestedSection = nestedSections[nestedKey];
          if (nestedSection.static && nestedSection.static[itemKey]) {
            console.debug(`✅ Found "${itemKey}" in nested section: ${nestedKey}`);
            const nestedItemData = nestedSection.static[itemKey];
            
            // Handle the nested item data
            await handleNestedStaticLayer(itemKey, nestedItemData, isChecked);
            return;
          }
        }
      }
    } catch (error) {
      console.error(`❌ Error searching nested sections:`, error);
    }
    
    console.error(`❌ Could not find configuration for "${itemKey}" anywhere`);
    return;
  }

  // Handle regular static layers
  await handleRegularStaticLayer(itemKey, itemData, isChecked);
}
/**
 * Handle nested static layers (like GDACS)
 */
async function handleNestedStaticLayer(itemKey, itemData, isChecked) {
  if (!itemData.source || !itemData.layers) {
    console.error(`❌ Nested static layer "${itemKey}" missing source or layers configuration:`, itemData);
    return;
  }

  try {
    if (isChecked) {
      // Load GDACS images first if this is a GDACS layer
      if (itemKey.includes('gdacs_')) {
        const map = window.ncop_map || window.map;
        if (map && typeof map.addImage === 'function') {
          await loadGdacsImagesFromData(map, itemKey, itemData);
        }
      }
      
      // console.log(`✅ Adding nested static layer "${itemKey}" to map`);
      const success = sourceLayerControl.addLayerByKey(itemKey);
      if (!success) {
        console.error(`❌ Failed to add nested static layer "${itemKey}" to map`);
      } else {
        // console.log(`✅ Successfully added nested static layer "${itemKey}" to map`);
      }
    } else {
      //console.log(`🔴 Removing nested static layer "${itemKey}" from map`);
      const success = sourceLayerControl.removeLayerByKey(itemKey);
      if (!success) {
        console.error(`❌ Failed to remove nested static layer "${itemKey}" from map`);
      } else {
        //console.log(`✅ Successfully removed nested static layer "${itemKey}" from map`);
      }
    }
  } catch (error) {
    console.error(`❌ Error handling nested static layer "${itemKey}":`, error);
  }
}


/**
 * Handle regular static layers (non-nested)
 */
async function handleRegularStaticLayer(itemKey, itemData, isChecked) {
  if (!itemData.source || !itemData.layers) {
    console.error(`❌ Static layer "${itemKey}" missing source or layers configuration:`, itemData);
    return;
  }

  try {
    if (isChecked) {
      // Load GDACS images first if this is a GDACS layer
      if (itemKey.includes('gdacs_')) {
        const map = window.ncop_map || window.map;
        if (map && typeof map.addImage === 'function') {
          //console.log(`🔄 Loading GDACS images for "${itemKey}"...`);
          await loadGdacsImagesFromData(map, itemKey, itemData);
          //console.log(`✅ GDACS images loaded for "${itemKey}"`);
        }
      }
      
      //console.log(`✅ Adding static layer "${itemKey}" to map`);
      const success = sourceLayerControl.addLayerByKey(itemKey);
      if (!success) {
        console.error(`❌ Failed to add static layer "${itemKey}" to map`);
      } else {
        //console.log(`✅ Successfully added static layer "${itemKey}" to map`);
      }
    } else {
      //console.log(`🔴 Removing static layer "${itemKey}" from map`);
      const success = sourceLayerControl.removeLayerByKey(itemKey);
      if (!success) {
        console.error(`❌ Failed to remove static layer "${itemKey}" from map`);
      } else {
        //console.log(`✅ Successfully removed static layer "${itemKey}" from map`);
      }
    }
  } catch (error) {
    console.error(`❌ Error handling static layer "${itemKey}":`, error);
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
  // console.log(`🗑️ Exposure layers removed for ID: ${exposureId}`);
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

    // console.log(`✅ Exposure ${exposureId} added to map`);
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
  // console.log(`🔄 DEW Exposure: ID=${exposureId}, checked=${isChecked}`);

  if (isChecked) {
    // Fetch and add to map
    try {
      const endpoint = `http://172.18.1.108:8000/get-exposures/?exposure_id=${exposureId}`;
      // console.log(`📡 Fetching: ${endpoint}`);
      
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
    // console.log(`🗑️ Clearing exposure ID: ${exposureId}`);
    removeExposureLayersById(exposureId);
  });
}
