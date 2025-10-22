// SidebarMenu.js

import {
  handleToggleInteraction,
  handleTemporalInteraction,
  handleDropdownInteraction,
  handleButtonInteraction
} from './mapbox-functions.js';

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
  #storage = window.ncop_storage;
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

    // Restore NCOP control states after UI is ready
    setTimeout(() => {
      this.#restoreNCOPStates();
    }, 100);
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
    header.innerHTML = `${iconHtml}<span class="accordion-title">${config.title}</span><i data-lucide="chevron-down" class="accordion-chevron"></i>`;

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
    subcategoryHeader.innerHTML = `<span>${subcategoryKey}</span><i data-lucide="chevron-right" class="subcategory-chevron"></i>`;
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
  #createToggleItem(categoryKey, subcategoryKey, itemKey, itemData) {
    // console.log(`🔧 Creating toggle item: ${itemKey}`, itemData);

    if (!itemData || !itemData.label) {
      console.error(`❌ Invalid toggle item data for ${itemKey}:`, itemData);
      return null;
    }

    const itemDiv = document.createElement("div");
    itemDiv.className = "ncop-item ncop-item-toggle";
    itemDiv.innerHTML = `
            <span class="ncop-item-label">${itemData.label}</span>
            <label class="ncop-toggle">
                <input type="checkbox" data-item-key="${itemKey}">
                <span class="ncop-toggle-slider"></span>
            </label>
        `;

    // Add event listener for toggle interaction
    const checkbox = itemDiv.querySelector('input[type="checkbox"]');
    checkbox.addEventListener("change", (e) => {
      handleToggleInteraction(
        categoryKey,
        subcategoryKey,
        itemKey,
        e.target.checked
      );
    });

    // console.log(`✅ Toggle item created successfully:`, itemDiv);
    return itemDiv;
  }
  #createTemporalItem(categoryKey, subcategoryKey, itemKey, itemData) {
    // console.log(`🔧 Creating temporal item: ${itemKey}`, itemData);

    if (!itemData || !itemData.label) {
      console.error(`❌ Invalid temporal item data for ${itemKey}:`, itemData);
      return null;
    }

    const itemDiv = document.createElement("div");
    itemDiv.className = "ncop-item ncop-item-temporal";
    itemDiv.innerHTML = `
            <div class="ncop-item-image">
                <img src="${itemData.image || "/static/images/placeholder.png"
      }" alt="${itemData.label}" />
            </div>
            <span class="ncop-item-label">${itemData.label}</span>
        `;

    // Add click handler for image selection and interaction logging
    const imageElement = itemDiv.querySelector(".ncop-item-image");
    imageElement.addEventListener("click", (event) => {
      event.stopPropagation();
      const wasSelected = imageElement.classList.contains("selected");
      this.#handleImageSelection(imageElement);
      const newActive = !wasSelected;
      handleTemporalInteraction(
        categoryKey,
        subcategoryKey,
        itemKey,
        newActive,
        itemData // <-- Use itemData instead of layerConfig
      );
    });

    // console.log(`✅ Temporal item created successfully:`, itemDiv);
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
        if (k.endsWith('_endpoint') && typeof dropdownConfig[k] === 'string' && dropdownConfig[k].startsWith('http')) {
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
            attrHeader.textContent = attributeField.replace(/_/g, " ").toUpperCase();
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
              checkbox.setAttribute("data-attribute-label", row[attributeField]);

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
    // console.log(`🔄 NCOP Toggle - ${itemKey}:`, {
    //     endpoint: endpoint,
    //     enabled: isEnabled,
    // });

    if (this.#storage) {
      this.#storage.saveSetting(`ncop_toggle_${itemKey}`, isEnabled);
    }

    const message = isEnabled ? "enabled" : "disabled";
    // console.log(`📡 ${itemKey} has been ${message}`);

    // Placeholder for API/Map Layer logic
  }

  #handleNCOPDropdown(endpoint, itemKey, selectedValue) {
    // console.log(`📋 NCOP Dropdown - ${itemKey}:`, {
    //     endpoint: endpoint,
    //     value: selectedValue,
    // });

    if (this.#storage) {
      this.#storage.saveSetting(`ncop_dropdown_${itemKey}`, selectedValue);
    }

    if (selectedValue === "") {
      // console.log(`📋 ${itemKey} selection cleared`);
      return;
    }

    // console.log(`📊 ${itemKey} set to: ${selectedValue}`);

    // Placeholder for API/Map Layer logic
  }

  #restoreNCOPStates() {
    if (!this.#storage) return;

    document
      .querySelectorAll('.ncop-toggle input[type="checkbox"]')
      .forEach((toggle) => {
        const itemKey = toggle.dataset.itemKey;
        const savedState = this.#storage.getSetting(`ncop_toggle_${itemKey}`);
        if (savedState !== null) {
          toggle.checked = savedState;
        }
      });

    document.querySelectorAll(".ncop-dropdown").forEach((dropdown) => {
      const itemKey = dropdown.dataset.itemKey;
      const savedState = this.#storage.getSetting(`ncop_dropdown_${itemKey}`);
      if (savedState !== null) {
        dropdown.value = savedState;
      }
    });

    // console.log("🔄 NCOP control states restored from localStorage");
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
