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