// SidebarMenu.js

import {
  handleToggleInteraction,
  handleTemporalInteraction,
  handleDropdownInteraction,
  handleButtonInteraction,
  handleStaticInteraction,
} from "./mapbox-functions.js";
import { handleDewExposureCheckbox } from "./mapbox-functions.js";
import gisLayersIcon from "@assets/images/accordion_icons/gis-layers.webp";
import weatherSystemsIcon from "@assets/images/accordion_icons/weather-systems.webp";
import floodMonitoringIcon from "@assets/images/accordion_icons/flood.webp";
import airQualityIcon from "@assets/images/accordion_icons/air-quality.webp";
import oceanCoastalIcon from "@assets/images/accordion_icons/ocean-coastal.webp";
import earlyWarningIcon from "@assets/images/accordion_icons/early-warning.webp";

/**
 * Handles the main sidebar logic, including configuration loading, UI generation (accordions),
 * search, and NCOP control state management.
 */
export class SidebarMenu {
  #sidebarPanel;
  #menuControlDiv;
  #accordionContainer;
  constructor() {
    // console.log("🚀 SidebarMenu constructor called");

    this.renderButton();
    // console.log("✅ Button rendered");

    this.#sidebarPanel = document.getElementById("sidebarPanel");
    // console.log("🔍 Sidebar panel:", this.#sidebarPanel);

    this.#accordionContainer = this.#sidebarPanel?.querySelector(
      ".accordion-container"
    );
    // console.log("🔍 Accordion container:", this.#accordionContainer);

    this.loadSidebarConfig();
    // console.log("✅ Config loading started");

    this.addEventListeners();
    // console.log("✅ Event listeners added");

    // console.log("📋 Sidebar menu initialized");
  }

  renderButton() {
    const mapContainer = document.getElementById("map");
    this.#menuControlDiv = document.createElement("div");
    this.#menuControlDiv.className = "custom-menu-control";
    this.#menuControlDiv.innerHTML = `
            <button id="menuToggle" class="custom-menu-btn" title="Open Menu">
                <i data-lucide="menu"></i>
            </button>
        `;
    mapContainer.appendChild(this.#menuControlDiv);
    lucide.createIcons();
  }

  addEventListeners() {
    document
      .getElementById("menuToggle")
      ?.addEventListener("click", this.openSidebar.bind(this));
    document
      .getElementById("sidebarCloseBtn")
      ?.addEventListener("click", this.closeSidebar.bind(this));
    document.addEventListener("keydown", this.#handleKeydown.bind(this));
  }

  openSidebar() {
    this.#sidebarPanel?.classList.add("visible");
    this.#menuControlDiv?.classList.add("hidden");
  }

  closeSidebar() {
    this.#sidebarPanel?.classList.remove("visible");
    this.#menuControlDiv?.classList.remove("hidden");
  }

  #handleKeydown(event) {
    if (
      event.key === "Escape" &&
      this.#sidebarPanel?.classList.contains("visible")
    ) {
      this.closeSidebar();
    }
  }

  // --- Configuration Loading and Population ---
  async loadSidebarConfig() {
    try {
      // console.log("🔍 Starting to import map-layers.js...");

      // Import the menu configuration from map-layers.js
      const { ncop_menu_items } = await import("./map-layers.js");

      // console.log("📋 Import successful! Menu configuration:", ncop_menu_items);
      // console.log("📋 Available categories:", Object.keys(ncop_menu_items || {}));

      if (ncop_menu_items && Object.keys(ncop_menu_items).length > 0) {
        // console.log("✅ Starting sidebar population...");
        this.#populateNCOPSidebar(ncop_menu_items);
      } else {
        console.warn(
          "⚠️ ncop_menu_items is empty or undefined, using basic sidebar"
        );
        this.#createBasicSidebar();
      }
    } catch (error) {
      console.error("❌ Error loading NCOP menu configuration:", error);
      console.error("❌ Error details:", error.message, error.stack);
      this.#createBasicSidebar();
    }
  }

  #populateNCOPSidebar(menuData) {
    if (!this.#accordionContainer) return;

    this.#accordionContainer.innerHTML = "";

    Object.keys(menuData).forEach((categoryKey) => {
      const categoryData = menuData[categoryKey];
      const categoryElement = this.#createNCOPCategorySection(
        categoryKey,
        categoryData
      );
      this.#accordionContainer.appendChild(categoryElement);
    });

    lucide.createIcons();
    this.#initializeAccordionHandlers();
    this.#initializeSearchFunctionality();
  }

  // --- Sidebar UI Generation ---

  #getCategoryConfig(categoryKey) {
    const categoryConfig = {
      gis_layers: {
        title: "GIS Layers",
        icon: "layers",
        customIcon: gisLayersIcon,
      },
      weather: {
        title: "Weather Systems",
        icon: "cloud",
        customIcon: weatherSystemsIcon,
      },
      flood: {
        title: "Flood Monitoring",
        icon: "waves",
        customIcon: floodMonitoringIcon,
      },
      air_quality: {
        title: "Air Quality",
        icon: "wind",
        customIcon: airQualityIcon,
      },
      "ocean/coastal": {
        title: "Ocean & Coastal",
        icon: "anchor",
        customIcon: oceanCoastalIcon,
      },
      "Disaster Early Warning (DEW)": {
        title: "Early Warning",
        icon: "alert-triangle",
        customIcon: earlyWarningIcon,
      },
      agriculture_monitoring: {
        title: "Agriculture Monitoring",
        icon: "wheat",
      },
    };
    return (
      categoryConfig[categoryKey] || {
        title: categoryKey
          .replace(/_/g, " ")
          .replace(/\b\w/g, (l) => l.toUpperCase()),
        icon: "folder",
      }
    );
  }

  #createNCOPCategorySection(categoryKey, categoryData) {
    const sectionDiv = document.createElement("div");
    sectionDiv.className = "accordion-item";
    const config = this.#getCategoryConfig(categoryKey);

    const iconHtml = config.customIcon
      ? `<img src="${config.customIcon}" alt="${config.title}" class="accordion-custom-icon">`
      : `<i data-lucide="${config.icon}" class="accordion-icon"></i>`;

    const header = document.createElement("div");
    header.className = "accordion-header";
    header.innerHTML = `${iconHtml}<span class="accordion-title"><span class="accordion-title-text">${config.title}</span></span><i data-lucide="chevron-down" class="accordion-chevron"></i>`;
    this.#attachMarquee(header.querySelector(".accordion-title"));

    const content = document.createElement("div");
    content.className = "accordion-content";
    Object.keys(categoryData).forEach((subcategoryKey) => {
      const subcategoryData = categoryData[subcategoryKey];
      content.appendChild(
        this.#createNCOPSubcategorySection(
          categoryKey,
          subcategoryKey,
          subcategoryData
        )
      );
    });

    sectionDiv.appendChild(header);
    sectionDiv.appendChild(content);
    return sectionDiv;
  }

  #createNCOPSubcategorySection(categoryKey, subcategoryKey, subcategoryData) {
    const subcategoryDiv = document.createElement("div");
    subcategoryDiv.className = "ncop-subcategory";

    const subcategoryHeader = document.createElement("div");
    subcategoryHeader.className = "ncop-subcategory-header";
    subcategoryHeader.innerHTML = `<span class="ncop-subcategory-title"><span class="ncop-subcategory-title-text">${subcategoryKey}</span></span><i data-lucide="chevron-right" class="subcategory-chevron"></i>`;
    this.#attachMarquee(subcategoryHeader.querySelector(".ncop-subcategory-title"));
    const itemsContainer = document.createElement("div");
    itemsContainer.className = "ncop-items-container";

    // --- Render items by type: toggle, temporal, dropdown, button ---
    // console.log(`🔍 Rendering subcategory: ${subcategoryKey}`, subcategoryData);

    Object.keys(subcategoryData).forEach((typeKey) => {
      const items = subcategoryData[typeKey];
      // console.log(`🔍 Processing type: ${typeKey}`, items);

      // --- TOGGLE CASE ---
      // JSON: { toggle: { itemKey: { label: ... }, ... } }
      // HTML: label + switch
      if (typeKey === "toggle") {
        // console.log(`✅ Creating toggle items for ${typeKey}:`, Object.keys(items));
        Object.keys(items).forEach((itemKey) => {
          // console.log(`🔍 Creating toggle item: ${itemKey}`, items[itemKey]);
          const toggleElement = this.#createToggleItem(
            categoryKey,
            subcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (toggleElement) {
            // console.log(`✅ Created toggle element:`, toggleElement);
            itemsContainer.appendChild(toggleElement);
          } else {
            console.error(`❌ Failed to create toggle element for ${itemKey}`);
          }
        });
      }
      // --- TEMPORAL CASE ---
      // JSON: { temporal: { itemKey: { label: ..., image: ... }, ... } }
      // HTML: 2-col grid, image + label
      else if (typeKey === "temporal") {
        // console.log(`✅ Creating temporal items for ${typeKey}:`, Object.keys(items));
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          if (items[itemKey]?.hidden === true) return;
          // console.log(`🔍 Creating temporal item: ${itemKey}`, items[itemKey]);
          const temporalElement = this.#createTemporalItem(
            categoryKey,
            subcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (temporalElement) {
            // console.log(`✅ Created temporal element:`, temporalElement);
            grid.appendChild(temporalElement);
          } else {
            console.error(
              `❌ Failed to create temporal element for ${itemKey}`
            );
          }
        });
        itemsContainer.appendChild(grid);
      }
      // --- DROPDOWN CASE ---            // JSON: { dropdown: { endpoint: ..., key: ..., attribute: ... } }
      // HTML: async select, populated from endpoint
      // Only dropdowns use endpoint/key/attribute
      else if (typeKey === "dropdown") {
        // console.log(`✅ Creating dropdown item for ${typeKey}:`, items);
        const dropdownElement = this.#createDropdownItem(
          categoryKey,
          subcategoryKey,
          typeKey,
          items
        );
        if (dropdownElement) {
          // console.log(`✅ Created dropdown element:`, dropdownElement);
          itemsContainer.appendChild(dropdownElement);
        } else {
          console.error(`❌ Failed to create dropdown element for ${typeKey}`);
        }
      }
      // --- BUTTON CASE ---
      // JSON: { button: { itemKey: { label: ..., color: ..., outline: ... }, ... } }
      // HTML: colored, rounded button grid
      else if (typeKey === "button") {
        // console.log(`✅ Creating button items for ${typeKey}:`, Object.keys(items));
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          // console.log(`🔍 Creating button item: ${itemKey}`, items[itemKey]);
          const buttonElement = this.#createButtonItem(
            categoryKey,
            subcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (buttonElement) {
            // console.log(`✅ Created button element:`, buttonElement);
            grid.appendChild(buttonElement);
          } else {
            console.error(`❌ Failed to create button element for ${itemKey}`);
          }
        });
        itemsContainer.appendChild(grid);
      }
      // --- STATIC CASE ---
      // JSON: { static: { itemKey: { label: ..., image: ... }, ... } }
      else if (typeKey === "static") {
        // console.log(`✅ Creating static items for ${typeKey}:`, Object.keys(items));
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          // console.log(`🔍 Creating static item: ${itemKey}`, items[itemKey]);
          const staticElement = this.#createStaticItem(
            categoryKey,
            subcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (staticElement) {
            // console.log(`✅ Created static element:`, staticElement);
            grid.appendChild(staticElement);
          } else {
            console.error(`❌ Failed to create static element for ${itemKey}`);
          }
        });
        itemsContainer.appendChild(grid);
      } else if (typeKey === "nested") {
        // 🆕 NEW: Nested sub-accordions (e.g., "GDACS Alerts", "Regional Alerts")
        Object.keys(items).forEach((nestedSubKey) => {
          const nestedSubData = items[nestedSubKey];
          const nestedElement = this.#createNestedSubSection(
            categoryKey,
            subcategoryKey,
            nestedSubKey,
            nestedSubData
          );
          if (nestedElement) {
            itemsContainer.appendChild(nestedElement);
          }
        });
        // Handle other item types
      }

      // --- OTHER CASES ---
      // If new types are added in map-layers.js, add their logic here.
      else {
        console.warn(`⚠️ Unknown item type: ${typeKey}`, items);
      }
    });

    subcategoryHeader.addEventListener("click", function () {
      const isExpanded = this.classList.contains("expanded");
      const parentContent = this.closest(".accordion-content");
      const otherHeaders = parentContent?.querySelectorAll(
        ".ncop-subcategory-header"
      );

      otherHeaders?.forEach((header) => {
        if (header !== this) {
          header.classList.remove("expanded");
          header.nextElementSibling?.classList.remove("visible");
        }
      });

      if (!isExpanded) {
        this.classList.add("expanded");
        itemsContainer.classList.add("visible");
      } else {
        this.classList.remove("expanded");
        itemsContainer.classList.remove("visible");
      }
    });

    subcategoryDiv.appendChild(subcategoryHeader);
    subcategoryDiv.appendChild(itemsContainer);
    return subcategoryDiv;
  }
  /**
   * 🆕 NEW: Create nested sub-accordion sections
   * Handles sub-accordions within subcategories (e.g., "GDACS and their respective alerts Alerts" inside "Hazard Alerts")
   */
  #createNestedSubSection(
    categoryKey,
    parentSubcategoryKey,
    nestedSubKey,
    nestedSubData
  ) {
    const nestedDiv = document.createElement("div");
    nestedDiv.className = "ncop-nested-subsection";

    const nestedHeader = document.createElement("div");
    nestedHeader.className = "ncop-nested-header";
    nestedHeader.innerHTML = `<span class="ncop-nested-title"><span class="ncop-nested-title-text">${nestedSubKey}</span></span><i data-lucide="chevron-right" class="nested-chevron"></i>`;
    this.#attachMarquee(nestedHeader.querySelector(".ncop-nested-title"));

    const nestedItemsContainer = document.createElement("div");
    nestedItemsContainer.className = "ncop-nested-items-container";

    // Render items within the nested section
    Object.keys(nestedSubData).forEach((typeKey) => {
      const items = nestedSubData[typeKey];

      if (typeKey === "static") {
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          const staticElement = this.#createStaticItem(
            categoryKey,
            parentSubcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (staticElement) grid.appendChild(staticElement);
        });
        nestedItemsContainer.appendChild(grid);
      } else if (typeKey === "toggle") {
        Object.keys(items).forEach((itemKey) => {
          const toggleElement = this.#createToggleItem(
            categoryKey,
            parentSubcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (toggleElement) nestedItemsContainer.appendChild(toggleElement);
        });
      } else if (typeKey === "temporal") {
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          if (items[itemKey]?.hidden === true) return;
          const temporalElement = this.#createTemporalItem(
            categoryKey,
            parentSubcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (temporalElement) grid.appendChild(temporalElement);
        });
        nestedItemsContainer.appendChild(grid);
      } else if (typeKey === "button") {
        const grid = document.createElement("div");
        grid.className = "ncop-grid";
        Object.keys(items).forEach((itemKey) => {
          const buttonElement = this.#createButtonItem(
            categoryKey,
            parentSubcategoryKey,
            itemKey,
            items[itemKey]
          );
          if (buttonElement) grid.appendChild(buttonElement);
        });
        nestedItemsContainer.appendChild(grid);
      } else {
        console.warn(`⚠️ Unknown nested item type: ${typeKey}`, items);
      }
    });

    // Event handler for nested header click
    nestedHeader.addEventListener("click", function () {
      const isExpanded = this.classList.contains("expanded");

      // Close other nested sections at the same level
      const parentContainer = this.closest(".ncop-items-container");
      const otherNestedHeaders = parentContainer?.querySelectorAll(
        ".ncop-nested-header"
      );

      otherNestedHeaders?.forEach((header) => {
        if (header !== this) {
          header.classList.remove("expanded");
          header.nextElementSibling?.classList.remove("visible");
        }
      });

      if (!isExpanded) {
        this.classList.add("expanded");
        nestedItemsContainer.classList.add("visible");
      } else {
        this.classList.remove("expanded");
        nestedItemsContainer.classList.remove("visible");
      }
    });

    nestedDiv.appendChild(nestedHeader);
    nestedDiv.appendChild(nestedItemsContainer);
    return nestedDiv;
  }
  #getLayerGeometry(itemData) {
    if (!itemData) return null;
    const g =
      typeof itemData.geometry === "string"
        ? itemData.geometry.toLowerCase()
        : null;
    if (g === "point" || g === "line" || g === "polygon" || g === "raster")
      return g;
    const t =
      typeof itemData.type === "string" ? itemData.type.toLowerCase() : null;
    if (t === "raster") return "raster";
    if (itemData.source?.type === "raster") return "raster";
    const layers = Array.isArray(itemData.layers) ? itemData.layers : [];
    let hasFill = false,
      hasLine = false,
      hasPoint = false,
      hasRaster = false;
    for (const l of layers) {
      if (!l || typeof l.type !== "string") continue;
      const lt = l.type.toLowerCase();
      if (lt === "raster") hasRaster = true;
      else if (lt === "fill" || lt === "fill-extrusion") hasFill = true;
      else if (lt === "line") hasLine = true;
      else if (lt === "symbol" || lt === "circle" || lt === "heatmap")
        hasPoint = true;
    }
    if (hasRaster) return "raster";
    if (hasFill) return "polygon";
    if (hasLine) return "line";
    if (hasPoint) return "point";
    return null;
  }

  #buildTypeIndicator(kind) {
    if (!kind) return "";
    const labelText =
      { point: "Point", line: "Line", polygon: "Polygon", raster: "Raster" }[
        kind
      ] || "";
    let svg = "";
    switch (kind) {
      case "point":
        svg = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>`;
        break;
      case "line":
        svg = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 13 L14 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>`;
        break;
      case "polygon":
        svg = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.75"/></svg>`;
        break;
      case "raster":
        svg = `<svg viewBox="0 0 15 15" aria-hidden="true"><rect x="0" y="0" width="5" height="5" fill="currentColor"/><rect x="10" y="0" width="5" height="5" fill="currentColor"/><rect x="5" y="5" width="5" height="5" fill="currentColor"/><rect x="0" y="10" width="5" height="5" fill="currentColor"/><rect x="10" y="10" width="5" height="5" fill="currentColor"/></svg>`;
        break;
    }
    return `<span class="ncop-item-type" data-geom="${kind}" title="${labelText} layer" aria-label="${labelText} layer">${svg}</span>`;
  }

  #attachMarquee(wrapper) {
    if (!wrapper) return;
    // Generic: the inner animated element is always the first child span.
    // Works for both .ncop-item-label inside .ncop-item-label-marquee
    // and .*-title-text inside .*-title (accordion / subcategory / nested).
    const label = wrapper.firstElementChild;
    if (!label) return;
    const update = () => {
      const overflow = label.scrollWidth - wrapper.clientWidth;
      if (overflow > 1) {
        wrapper.classList.add("is-overflowing");
        wrapper.style.setProperty("--marquee-x", `-${overflow}px`);
        const duration = Math.max(6, Math.min(16, overflow / 20 + 6));
        wrapper.style.setProperty("--marquee-duration", `${duration}s`);
      } else {
        wrapper.classList.remove("is-overflowing");
        wrapper.style.removeProperty("--marquee-x");
        wrapper.style.removeProperty("--marquee-duration");
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(update));
    if (typeof ResizeObserver !== "undefined") {
      try {
        const ro = new ResizeObserver(update);
        ro.observe(wrapper);
      } catch {}
    }
  }

  #createToggleItem(categoryKey, subcategoryKey, itemKey, itemData) {
    if (!itemData || !itemData.label) {
      console.error(`❌ Invalid toggle item data for ${itemKey}:`, itemData);
      return null;
    }

    const hasIcon = !!itemData.image;
    const geom = this.#getLayerGeometry(itemData);
    const iconHtml = hasIcon
      ? `<span class="ncop-item-icon"><img src="${itemData.image}" alt="" /></span>`
      : "";
    const typeHtml = this.#buildTypeIndicator(geom);

    const itemDiv = document.createElement("div");

    // Raster toggle items (not bound to a temporal legend): clickable
    // multi-select rows. No single-selection — multiple can stay active
    // together. Click again to deselect.
    if (geom === "raster") {
      itemDiv.className =
        "ncop-item ncop-item-toggle ncop-item-row ncop-item-row--clickable ncop-item-row--multi";
      itemDiv.title = itemData.label;
      itemDiv.dataset.itemKey = itemKey;
      itemDiv.innerHTML = `${iconHtml}<span class="ncop-item-label-marquee"><span class="ncop-item-label">${itemData.label}</span></span>${typeHtml}`;

      itemDiv.addEventListener("click", () => {
        const newState = !itemDiv.classList.contains("is-selected");
        itemDiv.classList.toggle("is-selected", newState);
        handleToggleInteraction(
          categoryKey,
          subcategoryKey,
          itemKey,
          newState
        );
      });

      this.#attachMarquee(itemDiv.querySelector(".ncop-item-label-marquee"));
      return itemDiv;
    }

    // Non-raster (point/line/polygon) toggle items keep the switch.
    itemDiv.className = "ncop-item ncop-item-toggle ncop-item-row";
    itemDiv.innerHTML = `${iconHtml}<span class="ncop-item-label-marquee"><span class="ncop-item-label">${itemData.label}</span></span>${typeHtml}<label class="ncop-toggle"><input type="checkbox" data-item-key="${itemKey}"><span class="ncop-toggle-slider"></span></label>`;

    const checkbox = itemDiv.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", (e) => {
      handleToggleInteraction(
        categoryKey,
        subcategoryKey,
        itemKey,
        e.target.checked
      );
    });

    this.#attachMarquee(itemDiv.querySelector(".ncop-item-label-marquee"));
    return itemDiv;
  }
  #createTemporalItem(categoryKey, subcategoryKey, itemKey, itemData) {
    if (!itemData || !itemData.label) {
      console.error(`❌ Invalid temporal item data for ${itemKey}:`, itemData);
      return null;
    }
    // Allow individual menu entries to opt out of being rendered without
    // having to delete or comment out the whole config block. Used right
    // now to hide the RainViewer radar / satellite-IR items while their
    // unified-slider integration is being tuned. Returning null here drops
    // the row cleanly (the iteration site already skips null returns).
    if (itemData.hidden === true) return null;

    const itemDiv = document.createElement("div");
    itemDiv.className =
      "ncop-item ncop-item-temporal ncop-item-row ncop-item-row--clickable";
    itemDiv.title = itemData.label;
    itemDiv.dataset.itemKey = itemKey;

    const hasIcon = !!itemData.image;
    const geom = this.#getLayerGeometry(itemData);
    const iconHtml = hasIcon
      ? `<span class="ncop-item-icon ncop-item-image"><img src="${itemData.image}" alt="" /></span>`
      : "";
    const typeHtml = this.#buildTypeIndicator(geom);

    itemDiv.innerHTML = `${iconHtml}<span class="ncop-item-label-marquee"><span class="ncop-item-label">${itemData.label}</span></span>${typeHtml}`;

    const imageElement = itemDiv.querySelector(".ncop-item-image");

    itemDiv.addEventListener("click", () => {
      const wasSelected = itemDiv.classList.contains("is-selected");
      if (wasSelected) {
        itemDiv.classList.remove("is-selected");
        if (imageElement) imageElement.classList.remove("selected");
        handleTemporalInteraction(
          categoryKey,
          subcategoryKey,
          itemKey,
          false,
          itemData
        );
        return;
      }
      // Single-selection is scoped to OTHER temporal items only — static
      // rasters and raster toggles are independent multi-select and must
      // keep their selection state here.
      document
        .querySelectorAll(".ncop-item-temporal.is-selected")
        .forEach((other) => {
          if (other === itemDiv) return;
          other.classList.remove("is-selected");
          const otherImg = other.querySelector(".ncop-item-image");
          if (otherImg) otherImg.classList.remove("selected");
        });
      itemDiv.classList.add("is-selected");
      if (imageElement) imageElement.classList.add("selected");
      handleTemporalInteraction(
        categoryKey,
        subcategoryKey,
        itemKey,
        true,
        itemData
      );
    });

    this.#attachMarquee(itemDiv.querySelector(".ncop-item-label-marquee"));
    return itemDiv;
  }

  #createDropdownItem(categoryKey, subcategoryKey, itemKey, itemData) {
    // Main container for all dropdowns in this item
    const itemDiv = document.createElement("div");
    itemDiv.className = "ncop-item ncop-item-dropdown-group";

    // Iterate through each dropdown configuration
    const dropdownKeys = Object.keys(itemData);

    dropdownKeys.forEach((dropdownKey) => {
      const dropdownConfig = itemData[dropdownKey];

      // ===== STEP 1: Extract endpoint =====
      let endpoint = "";
      for (const k in dropdownConfig) {
        if (
          k.endsWith("_endpoint") &&
          typeof dropdownConfig[k] === "string" &&
          dropdownConfig[k].startsWith("http")
        ) {
          endpoint = dropdownConfig[k];
          break;
        }
      }

      // ===== STEP 2: Extract configuration values =====
      const keyField = dropdownConfig.key || "id";
      const attributeField = dropdownConfig.attribute || "remarks";

      // Format label from dropdown key (dew_exposures → Dew Exposures)
      const label = dropdownKey
        .replace(/_/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());

      // ===== STEP 3: Create wrapper container =====
      const wrapper = document.createElement("div");
      wrapper.className = "ncop-dropdown-wrapper";
      wrapper.setAttribute("data-dropdown-key", dropdownKey);

      // ===== STEP 4: Create collapsible header =====
      const header = document.createElement("div");
      header.className = "ncop-dropdown-header";

      const headerContent = document.createElement("div");
      headerContent.className = "ncop-dropdown-header-content";

      const headerLabel = document.createElement("label");
      headerLabel.className = "ncop-dropdown-label";
      headerLabel.textContent = label;

      // Count badge (shows number of items loaded)
      const countBadge = document.createElement("span");
      countBadge.className = "ncop-dropdown-count";
      countBadge.textContent = "0";
      countBadge.style.display = "none"; // Hidden initially

      headerContent.appendChild(headerLabel);
      headerContent.appendChild(countBadge);

      // Toggle button (expand/collapse)
      const toggleBtn = document.createElement("div");
      toggleBtn.className = "ncop-dropdown-toggle";

      header.appendChild(headerContent);
      header.appendChild(toggleBtn);

      // ===== STEP 5: Create scrollable content area with table =====
      const contentArea = document.createElement("div");
      contentArea.className = "ncop-dropdown-content";
      contentArea.setAttribute("data-endpoint", endpoint);
      contentArea.setAttribute("data-key-field", keyField);
      contentArea.setAttribute("data-attribute-field", attributeField);
      contentArea.setAttribute("data-item-key", dropdownKey);

      // Add to wrapper first
      wrapper.appendChild(header);
      wrapper.appendChild(contentArea);

      // ===== STEP 6: Attach expand/collapse handler =====
      header.addEventListener("click", () => {
        contentArea.classList.toggle("expanded");
        toggleBtn.classList.toggle("expanded");
      });

      // ===== STEP 7: Fetch and populate table asynchronously =====
      setTimeout(() => {
        if (!endpoint) {
          contentArea.innerHTML = `
                    <div class="ncop-error-state">
                        <span class="ncop-error-icon">⚠️</span>
                        No endpoint provided for dropdown: ${dropdownKey}
                    </div>
                `;
          console.warn(`⚠️ No endpoint provided for dropdown ${dropdownKey}`);
          return;
        }

        // Show loading state
        contentArea.innerHTML = `
                <div class="ncop-loading-state">
                    <span class="ncop-spinner"></span>
                    Loading data...
                </div>
            `;

        // Fetch data from endpoint
        fetch(endpoint)
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
          })
          .then((data) => {
            // Validate data is an array
            if (!Array.isArray(data)) {
              throw new Error("Endpoint did not return an array");
            }

            // Check if data is empty
            if (data.length === 0) {
              contentArea.innerHTML = `
                            <div class="ncop-empty-state">
                                <div class="ncop-empty-state-icon">📋</div>
                                <div class="ncop-empty-state-text">No data available</div>
                            </div>
                        `;
              countBadge.textContent = "0";
              countBadge.style.display = "inline-flex";
              return;
            }

            // Update count badge
            countBadge.textContent = data.length;
            countBadge.style.display = "inline-flex";

            // ===== CREATE TABLE =====
            const table = document.createElement("table");
            table.className = "ncop-data-table";

            // Create thead with headers
            const thead = document.createElement("thead");
            const headerRow = document.createElement("tr");

            // Checkbox header
            const checkboxHeader = document.createElement("th");
            checkboxHeader.textContent = "✓";
            checkboxHeader.style.textAlign = "center";
            checkboxHeader.style.width = "40px";
            headerRow.appendChild(checkboxHeader);

            // Key field header
            const keyHeader = document.createElement("th");
            keyHeader.textContent = keyField.replace(/_/g, " ").toUpperCase();
            keyHeader.style.minWidth = "60px";
            headerRow.appendChild(keyHeader);

            // Attribute field header
            const attrHeader = document.createElement("th");
            attrHeader.textContent = attributeField
              .replace(/_/g, " ")
              .toUpperCase();
            attrHeader.style.flex = "1";
            headerRow.appendChild(attrHeader);

            thead.appendChild(headerRow);
            table.appendChild(thead);

            // Create tbody with data rows
            const tbody = document.createElement("tbody");

            data.forEach((row) => {
              const tr = document.createElement("tr");

              // ===== CHECKBOX CELL =====
              const checkboxCell = document.createElement("td");
              checkboxCell.className = "ncop-checkbox-cell";

              const checkbox = document.createElement("input");
              checkbox.type = "checkbox";
              checkbox.className = "ncop-row-checkbox";
              checkbox.value = row[keyField];

              // Store reference to attribute label for potential use
              checkbox.setAttribute(
                "data-attribute-label",
                row[attributeField]
              );

              // Handle checkbox change
              // Handle checkbox change
              checkbox.addEventListener("change", (e) => {
                const isChecked = e.target.checked;
                const keyValue = e.target.value;
                const attrLabel = e.target.getAttribute("data-attribute-label");
                // Call handler with relevant data
                handleDropdownInteraction(
                  categoryKey,
                  subcategoryKey,
                  keyValue,
                  attrLabel,
                  dropdownKey,
                  isChecked
                );
                // Handle DEW Exposure specific functionality
                if (dropdownKey === "dew_exposures") {
                  handleDewExposureCheckbox(keyValue, isChecked);
                }
              });

              checkboxCell.appendChild(checkbox);
              tr.appendChild(checkboxCell);

              // ===== KEY CELL =====
              const keyCell = document.createElement("td");
              keyCell.className = "ncop-key-cell";
              keyCell.textContent = row[keyField];
              keyCell.title = `${keyField}: ${row[keyField]}`; // Tooltip
              tr.appendChild(keyCell);

              // ===== ATTRIBUTE CELL =====
              const attrCell = document.createElement("td");
              attrCell.className = "ncop-attribute-cell";
              attrCell.textContent = row[attributeField];
              attrCell.title = `${attributeField}: ${row[attributeField]}`; // Tooltip
              tr.appendChild(attrCell);

              tbody.appendChild(tr);
            });

            table.appendChild(tbody);
            contentArea.innerHTML = ""; // Clear loading state
            contentArea.appendChild(table);
          })
          .catch((error) => {
            console.error(`❌ Error fetching data for ${dropdownKey}:`, error);
            contentArea.innerHTML = `
                        <div class="ncop-error-state">
                            <span class="ncop-error-icon">❌</span>
                            Error loading data: ${error.message}
                        </div>
                    `;
          });
      }, 0); // Deferred execution

      // Add wrapper to main item div
      itemDiv.appendChild(wrapper);
    });

    return itemDiv;
  }

  #createButtonItem(categoryKey, subcategoryKey, itemKey, itemData) {
    // console.log(`🔧 Creating button item: ${itemKey}`, itemData);

    if (!itemData || !itemData.label) {
      console.error(`❌ Invalid button item data for ${itemKey}:`, itemData);
      return null;
    }

    const itemDiv = document.createElement("div");
    itemDiv.className = "ncop-item ncop-item-button";

    // Set CSS custom properties for colors
    const buttonColor = itemData.color || "#6366f1";
    const borderColor = itemData.outline || "#4f46e5";
    itemDiv.style.setProperty("--button-color", buttonColor);
    itemDiv.style.setProperty("--border-color", borderColor);

    // Create button with label on left and toggle on right
    if (itemData.image) {
      itemDiv.innerHTML = `
                <div class="ncop-item-content">
                    <div class="ncop-item-image">
                        <img src="${itemData.image}" alt="${itemData.label}" />
                    </div>
                    <span class="ncop-item-label">${itemData.label}</span>
                </div>
                <label class="ncop-toggle">
                    <input type="checkbox" data-item-key="${itemKey}">
                    <span class="ncop-toggle-slider"></span>
                </label>
            `;
      // Add click handler for image selection
      const imageElement = itemDiv.querySelector(".ncop-item-image");
      imageElement.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#handleImageSelection(imageElement);
      });
    } else {
      itemDiv.innerHTML = `
                <span class="ncop-item-label">${itemData.label}</span>
                <label class="ncop-toggle">
                    <input type="checkbox" data-item-key="${itemKey}">
                    <span class="ncop-toggle-slider"></span>
            `;
    }

    // Add event listener for button interaction
    const checkbox = itemDiv.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", (e) => {
      handleButtonInteraction(categoryKey, subcategoryKey, itemKey);
    });

    // console.log(`✅ Button item created successfully:`, itemDiv);
    return itemDiv;
  }

  #createStaticItem(categoryKey, subcategoryKey, itemKey, itemData) {
    if (!itemData || !itemData.label) return null;

    // Static items = non-temporal rasters (no temporal legend).
    // Multi-select: each one toggles independently; multiple can stay
    // active at the same time. Click again to deselect.
    const itemDiv = document.createElement("div");
    itemDiv.className =
      "ncop-item ncop-item-static ncop-item-row ncop-item-row--clickable ncop-item-row--multi";
    itemDiv.title = itemData.label;

    const hasIcon = !!itemData.image;
    const geom = this.#getLayerGeometry(itemData);
    const iconHtml = hasIcon
      ? `<span class="ncop-item-icon ncop-item-image"><img src="${itemData.image}" alt="" /></span>`
      : "";
    const typeHtml = this.#buildTypeIndicator(geom);

    itemDiv.innerHTML = `${iconHtml}<span class="ncop-item-label-marquee"><span class="ncop-item-label">${itemData.label}</span></span>${typeHtml}`;

    const imageElement = itemDiv.querySelector(".ncop-item-image");

    itemDiv.addEventListener("click", () => {
      const newState = !itemDiv.classList.contains("is-selected");
      itemDiv.classList.toggle("is-selected", newState);
      if (imageElement) imageElement.classList.toggle("selected", newState);
      handleStaticInteraction(categoryKey, subcategoryKey, itemKey, newState);
    });

    this.#attachMarquee(itemDiv.querySelector(".ncop-item-label-marquee"));
    return itemDiv;
  }

  #handleImageSelection(clickedImageElement) {
    // Check if the clicked image is already selected
    const isAlreadySelected =
      clickedImageElement.classList.contains("selected");

    // Remove selection from all images
    document.querySelectorAll(".ncop-item-image.selected").forEach((image) => {
      image.classList.remove("selected");
    });

    // If it wasn't already selected, select it
    if (!isAlreadySelected) {
      clickedImageElement.classList.add("selected");
    }

    // console.log(`🖼️ Image selection updated for:`, clickedImageElement);
  }

  #initializeAccordionHandlers() {
    document.querySelectorAll(".accordion-header").forEach((header) => {
      header.addEventListener("click", function () {
        const accordionContent = this.nextElementSibling;
        const isActive = this.classList.contains("active");

        document
          .querySelectorAll(".accordion-header")
          .forEach((otherHeader) => {
            if (otherHeader !== this) {
              otherHeader.classList.remove("active");
              otherHeader.nextElementSibling?.classList.remove("expanded");
            }
          });

        this.classList.toggle("active", !isActive);
        accordionContent?.classList.toggle("expanded", !isActive);
      });
    });
  }

  #createBasicSidebar() {
    if (!this.#accordionContainer) return;
    this.#accordionContainer.innerHTML = `
            <div class="accordion-item">
                <div class="accordion-header">
                    <i data-lucide="settings"></i>
                    <span>System Menu</span>
                    <i data-lucide="chevron-down" class="accordion-chevron"></i>
                </div>
                <div class="accordion-content">
                    <ul class="accordion-items">
                        <li class="accordion-item-entry" data-action="exportData">
                            <i data-lucide="download"></i><span>Export Settings</span>
                        </li>
                        <li class="accordion-item-entry" data-action="showHelp">
                            <i data-lucide="help-circle"></i><span>Help & Support</span>
                        </li>
                    </ul>
                </div>
            </div>
        `;
    this.#initializeAccordionHandlers();
    lucide.createIcons();
  }

  #handleNCOPToggle(endpoint, itemKey, isEnabled) {
    // Placeholder for API/Map Layer logic
  }

  #handleNCOPDropdown(endpoint, itemKey, selectedValue) {
    if (selectedValue === "") {
      return;
    }

    // Placeholder for API/Map Layer logic
  }

  #initializeSearchFunctionality() {
    const searchInput = document.getElementById("sidebarSearch");
    const clearSearchBtn = document.getElementById("clearSearch");

    if (!searchInput || !clearSearchBtn) return;

    searchInput.addEventListener("input", (e) => {
      const searchTerm = e.target.value.toLowerCase().trim();
      if (searchTerm) {
        clearSearchBtn.style.display = "flex";
        this.#performSearch(searchTerm);
      } else {
        clearSearchBtn.style.display = "none";
        this.#clearSearch();
      }
    });

    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      clearSearchBtn.style.display = "none";
      this.#clearSearch();
    });
  }

  #performSearch(searchTerm) {
    const accordionContainer = this.#accordionContainer;
    if (!accordionContainer) return;

    let visibleCount = 0;
    const accordions = accordionContainer.querySelectorAll(".accordion-item");

    accordions.forEach((accordion) => {
      let accordionHasMatch = false;
      const accordionHeader = accordion.querySelector(".accordion-header");
      const accordionContent = accordion.querySelector(".accordion-content");
      const accordionTitleElement = accordionHeader.querySelector("span");
      const accordionTitle =
        accordionTitleElement?.textContent.toLowerCase() || "";
      const accordionMatches = accordionTitle.includes(searchTerm);

      if (accordionMatches) {
        accordionHasMatch = true;
      }

      const subcategories = accordion.querySelectorAll(".ncop-subcategory");
      let visibleSubcategories = 0;

      subcategories.forEach((subcategory) => {
        let subcategoryHasMatch = false;
        const subcategoryHeader = subcategory.querySelector(
          ".ncop-subcategory-header"
        );
        const subcategoryHeaderSpan = subcategoryHeader?.querySelector("span");
        const subcategoryTitle = subcategoryHeaderSpan
          ? subcategoryHeaderSpan.textContent.toLowerCase()
          : "";
        const itemsContainer = subcategory.querySelector(
          ".ncop-items-container"
        );

        if (subcategoryTitle.includes(searchTerm)) {
          subcategoryHasMatch = true;
          accordionHasMatch = true;
        }

        const items = subcategory.querySelectorAll(".ncop-item");
        let visibleItems = 0;

        items.forEach((item) => {
          const itemLabel = item.querySelector(".ncop-item-label");
          const itemText = itemLabel ? itemLabel.textContent.toLowerCase() : "";

          const toggleInput = item.querySelector('input[type="checkbox"]');
          const dropdownSelect = item.querySelector("select");

          const allItemText = [
            itemText,
            toggleInput ? toggleInput.dataset.endpoint || "" : "",
            dropdownSelect ? dropdownSelect.dataset.endpoint || "" : "",
            subcategoryTitle,
            accordionTitle,
          ]
            .join(" ")
            .toLowerCase();

          if (allItemText.includes(searchTerm)) {
            item.style.display = "flex";
            visibleItems++;
            subcategoryHasMatch = true;
            accordionHasMatch = true;
            this.#highlightText(itemLabel, searchTerm);
          } else {
            item.style.display = "none";
            this.#removeHighlight(itemLabel);
          }
        });

        if (subcategoryHasMatch) {
          subcategory.style.display = "block";
          visibleSubcategories++;

          if (subcategoryTitle.includes(searchTerm)) {
            this.#highlightText(subcategoryHeaderSpan, searchTerm);
          } else {
            this.#removeHighlight(subcategoryHeaderSpan);
          }

          if (itemsContainer && subcategoryHeader && visibleItems > 0) {
            itemsContainer.classList.add("visible");
            subcategoryHeader.classList.add("expanded");
          }
        } else {
          subcategory.style.display = "none";
          this.#removeHighlight(subcategoryHeaderSpan);
        }
      });

      if (accordionHasMatch) {
        accordion.style.display = "block";
        visibleCount++;

        if (accordionContent && visibleSubcategories > 0) {
          accordionContent.classList.add("expanded");
          accordionHeader.classList.add("active");
        }

        if (accordionMatches && accordionTitleElement) {
          this.#highlightText(accordionTitleElement, searchTerm);
        } else if (accordionTitleElement) {
          this.#removeHighlight(accordionTitleElement);
        }
      } else {
        accordion.style.display = "none";
        if (accordionTitleElement) {
          this.#removeHighlight(accordionTitleElement);
        }
      }
    });

    if (visibleCount === 0) {
      this.#showNoResultsMessage();
    } else {
      this.#removeNoResultsMessage();
    }
  }

  #clearSearch() {
    const accordionContainer = this.#accordionContainer;
    if (!accordionContainer) return;

    accordionContainer
      .querySelectorAll(".accordion-item")
      .forEach((accordion) => {
        accordion.style.display = "block";

        const header = accordion.querySelector(".accordion-header");
        const content = accordion.querySelector(".accordion-content");
        const headerTitle = header.querySelector("span");

        this.#removeHighlight(headerTitle);

        header.classList.remove("active");
        content.classList.remove("expanded");

        accordion
          .querySelectorAll(".ncop-subcategory")
          .forEach((subcategory) => {
            subcategory.style.display = "block";

            const subHeader = subcategory.querySelector(
              ".ncop-subcategory-header"
            );
            const subHeaderTitle = subHeader?.querySelector("span");
            const itemsContainer = subcategory.querySelector(
              ".ncop-items-container"
            );

            this.#removeHighlight(subHeaderTitle);

            subHeader?.classList.remove("expanded");
            itemsContainer?.classList.remove("visible");

            subcategory.querySelectorAll(".ncop-item").forEach((item) => {
              item.style.display = "flex";
              const label = item.querySelector(".ncop-item-label");
              this.#removeHighlight(label);
            });
          });
      });

    this.#removeNoResultsMessage();
  }

  #highlightText(element, searchTerm) {
    if (!element || !searchTerm) return;
    this.#removeHighlight(element); // Ensure no prior highlights
    const originalText = element.textContent;
    const regex = new RegExp(`(${searchTerm})`, "gi");
    const highlightedText = originalText.replace(
      regex,
      '<span class="search-highlight">$1</span>'
    );
    element.innerHTML = highlightedText;
  }

  #removeHighlight(element) {
    if (!element) return;
    // Use a loop to handle nested structure if necessary
    const highlightedElements = element.querySelectorAll(".search-highlight");
    highlightedElements.forEach((highlighted) => {
      const parent = highlighted.parentNode;
      parent.replaceChild(
        document.createTextNode(highlighted.textContent),
        highlighted
      );
      parent.normalize();
    });

    // Also clean up the element itself if it was highlighted
    if (element.classList.contains("search-highlight")) {
      const parent = element.parentNode;
      parent.replaceChild(
        document.createTextNode(element.textContent),
        element
      );
      parent.normalize();
    }
  }

  #showNoResultsMessage() {
    this.#removeNoResultsMessage();
    if (this.#accordionContainer) {
      const noResultsDiv = document.createElement("div");
      noResultsDiv.className = "no-results-message";
      noResultsDiv.innerHTML = `<p>No results found</p><small>Try different keywords or check spelling</small>`;
      this.#accordionContainer.appendChild(noResultsDiv);
      lucide.createIcons();
    }
  }

  #removeNoResultsMessage() {
    document.querySelector(".no-results-message")?.remove();
  }
}
