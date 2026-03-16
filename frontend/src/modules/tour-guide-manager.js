// tour-guide-manager.js
// Guided product tour with element highlight + tooltip steps.
// Uses existing UI controls/actions without changing core app logic.

const TOUR_REFRESH_MS = 220;
const TOUR_PROMPT_LAST_SHOWN_KEY = "ncop_tour_prompt_last_shown_at";
const TOUR_PROMPT_DISABLED_KEY = "ncop_tour_prompt_disabled";
const TOUR_PROMPT_COOLDOWN_MS = 1000 * 60 * 60 * 12; // 12h

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function rectsOverlap(a, b) {
  return !(
    a.right < b.left ||
    a.left > b.right ||
    a.bottom < b.top ||
    a.top > b.bottom
  );
}

function expandRect(rect, padding = 0) {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding,
  };
}

async function waitForSelector(selector, timeout = 3500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(80);
  }
  return null;
}

export class NCOPTourGuide {
  #map;
  #active = false;
  #currentIndex = 0;
  #steps = [];
  #overlay = null;
  #highlight = null;
  #tooltip = null;
  #refreshTimer = null;
  #activatedTemporal = false;

  constructor(map) {
    this.#map = map;
    this.#buildSteps();
    this.#createDom();
    this.#maybePromptTour();
  }

  toggle() {
    if (this.#active) {
      this.stop();
      return;
    }
    this.start();
  }

  async start() {
    if (this.#active) return;
    this.#active = true;
    this.#currentIndex = 0;

    this.#setControlActive(true);
    this.#overlay?.classList.add("active");
    this.#highlight?.classList.add("active");
    this.#tooltip?.classList.add("active");

    this.#startRefreshLoop();
    await this.#renderCurrentStep();
  }

  stop() {
    if (!this.#active) return;
    this.#active = false;

    this.#stopRefreshLoop();
    this.#overlay?.classList.remove("active");
    this.#highlight?.classList.remove("active");
    this.#tooltip?.classList.remove("active");
    this.#setControlActive(false);
  }

  async next() {
    if (!this.#active) return;
    if (this.#currentIndex >= this.#steps.length - 1) {
      this.stop();
      window.location.reload();
      return;
    }
    this.#currentIndex += 1;
    await this.#renderCurrentStep();
  }

  async prev() {
    if (!this.#active) return;
    if (this.#currentIndex <= 0) return;
    this.#currentIndex -= 1;
    await this.#renderCurrentStep();
  }

  #buildSteps() {
    this.#steps = [
      {
        selector: "#menuToggle",
        title: "Sidebar Menu",
        description: "Open this to browse all categories and operational layers.",
      },
      {
        selector: "#sidebarPanel",
        title: "Layer Catalog",
        description: "This panel contains GIS, weather, flood, oceanography, air quality, and hazard tools.",
        action: async () => {
          const menuBtn = await waitForSelector("#menuToggle");
          if (menuBtn && !document.getElementById("sidebarPanel")?.classList.contains("visible")) {
            menuBtn.click();
            await sleep(240);
          }
          const firstAccordion = document.querySelector(".accordion-header");
          if (firstAccordion && !firstAccordion.classList.contains("active")) {
            firstAccordion.click();
            await sleep(220);
          }
        },
      },
      {
        selector: ".ncop-item-temporal .ncop-item-image",
        title: "Temporal Layer",
        description: "The tour activates a temporal layer to demonstrate timeline playback.",
        action: async () => {
          const menuBtn = await waitForSelector("#menuToggle");
          if (menuBtn && !document.getElementById("sidebarPanel")?.classList.contains("visible")) {
            menuBtn.click();
            await sleep(240);
          }
          const accordions = Array.from(document.querySelectorAll(".accordion-header"));
          const weatherAccordion = accordions.find((header) => {
            const title = header.querySelector(".accordion-title")?.textContent || "";
            return title.trim().toLowerCase() === "weather monitoring";
          });

          const targetAccordion = weatherAccordion || document.querySelector(".accordion-header");
          if (targetAccordion && !targetAccordion.classList.contains("active")) {
            targetAccordion.click();
            await sleep(220);
          }
          const temporalBtn = await waitForSelector(".ncop-item-temporal .ncop-item-image");
          if (temporalBtn && !temporalBtn.classList.contains("selected")) {
            temporalBtn.click();
            this.#activatedTemporal = true;
            await sleep(360);
          }
        },
      },
      {
        selector: "#temp-slider1",
        title: "Time Slider",
        description: "Use play/pause, speed, opacity, to inspect temporal evolution.",
        action: async () => {
          const sidebar = document.getElementById("sidebarPanel");
          if (sidebar?.classList.contains("visible")) {
            const closeBtn = document.getElementById("sidebarCloseBtn");
            if (closeBtn) {
              closeBtn.click();
            } else {
              sidebar.classList.remove("visible");
              document.querySelector(".custom-menu-control")?.classList.remove("hidden");
            }
            await sleep(220);
          }
        },
      },
      {
        selector: "#basemapToggle",
        title: "Basemap Control",
        description: "Switch basemaps and label visibility from this control.",
      },
      {
        selector: "#layerInfoToggle",
        title: "Layer Info",
        description: "Inspect details and legends for currently active layers.",
      },
      {
        selector: "#ncopGeocoderWrapper",
        title: "Search",
        description: "Search locations and quickly fly the map to places of interest.",
      },
      {
        selector: "#zoomIn",
        title: "Navigation: Zoom In",
        description: "Increase map zoom level for a closer local view.",
      },
      {
        selector: "#zoomOut",
        title: "Navigation: Zoom Out",
        description: "Decrease map zoom level to move back to regional or global context.",
      },
      {
        selector: "#toggle3D",
        title: "Navigation: 3D Terrain",
        description: "Toggle 3D terrain mode on and off.",
      },
      {
        selector: "#projectionSwitch",
        title: "Navigation: Projection",
        description: "Open projection settings to switch map projection modes.",
      },
      {
        selector: "#spinGlobe",
        title: "Navigation: Spinning Globe",
        description: "Toggle automatic globe rotation. User interaction stops auto-spin.",
      },
      {
        selector: "#localNews",
        title: "Navigation: Local News",
        description: "Open or close the local news ticker panel and related map markers.",
      },
      {
        selector: "#zoomHome",
        title: "Navigation: Home View",
        description: "Return quickly to a global default view.",
      },
      {
        selector: "#satTrackerBtn",
        title: "Navigation: Satellite Tracker",
        description: "Open satellite tracker controls for station and EO/Weather tracks.",
      },
      {
        selector: "#navToggleBtn",
        title: "Navigation: Collapse/Expand",
        description: "Collapse or expand the navigation button stack.",
      },
      {
        selector: "#tourGuideBtn",
        title: "Tour Control",
        description: "Start or stop the guided tour anytime from this control.",
      },
    ];
  }

  #createDom() {
    if (document.getElementById("gcop-tour-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "gcop-tour-overlay";
    overlay.className = "gcop-tour-overlay";

    const highlight = document.createElement("div");
    highlight.id = "gcop-tour-highlight";
    highlight.className = "gcop-tour-highlight";

    const tooltip = document.createElement("div");
    tooltip.id = "gcop-tour-tooltip";
    tooltip.className = "gcop-tour-tooltip";

    tooltip.innerHTML = `
      <div class="gcop-tour-tooltip-header">
        <h3 id="gcop-tour-title">Tour</h3>
        <button class="gcop-tour-close" id="gcop-tour-close" aria-label="Close tour">×</button>
      </div>
      <div class="gcop-tour-tooltip-content">
        <p id="gcop-tour-desc"></p>
      </div>
      <div class="gcop-tour-tooltip-footer">
        <div class="gcop-tour-progress">
          <span id="gcop-tour-progress-text">1 / 1</span>
          <div class="gcop-tour-progress-bar">
            <div id="gcop-tour-progress-fill" class="gcop-tour-progress-fill"></div>
          </div>
        </div>
        <div class="gcop-tour-buttons">
          <button id="gcop-tour-prev" class="gcop-tour-btn gcop-tour-prev">Previous</button>
          <button id="gcop-tour-next" class="gcop-tour-btn gcop-tour-next">Next</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(highlight);
    document.body.appendChild(tooltip);

    this.#overlay = overlay;
    this.#highlight = highlight;
    this.#tooltip = tooltip;

    document.getElementById("gcop-tour-close")?.addEventListener("click", () => this.stop());
    document.getElementById("gcop-tour-next")?.addEventListener("click", () => this.next());
    document.getElementById("gcop-tour-prev")?.addEventListener("click", () => this.prev());
    overlay.addEventListener("click", () => this.stop());
  }

  async #renderCurrentStep() {
    const step = this.#steps[this.#currentIndex];
    if (!step) return;

    if (typeof step.action === "function") {
      await step.action();
    }

    const element = await waitForSelector(step.selector, 2500);

    const titleEl = document.getElementById("gcop-tour-title");
    const descEl = document.getElementById("gcop-tour-desc");
    const progressTextEl = document.getElementById("gcop-tour-progress-text");
    const progressFillEl = document.getElementById("gcop-tour-progress-fill");
    const nextBtn = document.getElementById("gcop-tour-next");
    const prevBtn = document.getElementById("gcop-tour-prev");

    if (titleEl) titleEl.textContent = step.title;
    if (descEl) {
      descEl.textContent = element
        ? step.description
        : `${step.description} (This control is currently not available in the DOM.)`;
    }
    if (progressTextEl) progressTextEl.textContent = `${this.#currentIndex + 1} / ${this.#steps.length}`;
    if (progressFillEl) {
      const pct = ((this.#currentIndex + 1) / this.#steps.length) * 100;
      progressFillEl.style.width = `${pct}%`;
    }
    if (prevBtn) prevBtn.disabled = this.#currentIndex === 0;
    if (nextBtn) nextBtn.textContent = this.#currentIndex === this.#steps.length - 1 ? "Finish" : "Next";

    this.#positionForElement(element);
  }

  #positionForElement(element) {
    const highlight = this.#highlight;
    const tooltip = this.#tooltip;
    if (!highlight || !tooltip) return;

    let rect;
    if (element && isVisible(element)) {
      rect = element.getBoundingClientRect();
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
    } else {
      const w = 240;
      const h = 120;
      rect = {
        left: (window.innerWidth - w) / 2,
        top: (window.innerHeight - h) / 2,
        width: w,
        height: h,
      };
    }

    const pad = 8;
    highlight.style.left = `${Math.max(4, rect.left - pad)}px`;
    highlight.style.top = `${Math.max(4, rect.top - pad)}px`;
    highlight.style.width = `${Math.max(40, rect.width + pad * 2)}px`;
    highlight.style.height = `${Math.max(40, rect.height + pad * 2)}px`;

    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 12;
    const gap = 14;
    const targetRect = {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    };

    const blockedSelectors = ["#menuToggle", "#navControlsContainer", "#ncopGeocoderWrapper"];
    const blockedRects = blockedSelectors
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .filter(isVisible)
      .map((el) => expandRect(el.getBoundingClientRect(), 10));

    const clampLeft = (v) =>
      Math.max(margin, Math.min(v, window.innerWidth - tooltipRect.width - margin));
    const clampTop = (v) =>
      Math.max(margin, Math.min(v, window.innerHeight - tooltipRect.height - margin));

    const candidates = [
      {
        left: clampLeft(rect.left + rect.width / 2 - tooltipRect.width / 2),
        top: clampTop(rect.top + rect.height + gap),
      },
      {
        left: clampLeft(rect.right + gap),
        top: clampTop(rect.top + rect.height / 2 - tooltipRect.height / 2),
      },
      {
        left: clampLeft(rect.left - tooltipRect.width - gap),
        top: clampTop(rect.top + rect.height / 2 - tooltipRect.height / 2),
      },
      {
        left: clampLeft(rect.left + rect.width / 2 - tooltipRect.width / 2),
        top: clampTop(rect.top - tooltipRect.height - gap),
      },
    ];

    let pick = candidates.find((candidate) => {
      const tooltipBox = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + tooltipRect.width,
        bottom: candidate.top + tooltipRect.height,
      };
      if (rectsOverlap(tooltipBox, targetRect)) return false;
      return !blockedRects.some((blocked) => rectsOverlap(tooltipBox, blocked));
    }) || candidates[0];

    // Hard guard for the menu-toggle step: keep tooltip away from top-left menu control.
    const currentStep = this.#steps[this.#currentIndex];
    if (currentStep?.selector === "#menuToggle") {
      const menuRect = document.querySelector("#menuToggle")?.getBoundingClientRect();
      if (menuRect) {
        const safeLeft = clampLeft(menuRect.right + gap + 12);
        const safeTop = clampTop(menuRect.top);
        pick = { left: safeLeft, top: safeTop };
      }
    }

    tooltip.style.left = `${pick.left}px`;
    tooltip.style.top = `${pick.top}px`;

  }

  #startRefreshLoop() {
    this.#stopRefreshLoop();
    this.#refreshTimer = window.setInterval(() => {
      if (!this.#active) return;
      const step = this.#steps[this.#currentIndex];
      if (!step) return;
      const element = document.querySelector(step.selector);
      this.#positionForElement(element);
    }, TOUR_REFRESH_MS);
  }

  #stopRefreshLoop() {
    if (this.#refreshTimer) {
      window.clearInterval(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  #setControlActive(active) {
    const btn = document.getElementById("tourGuideBtn");
    if (!btn) return;
    btn.classList.toggle("active", active);
  }

  #maybePromptTour() {
    try {
      const disabled = window.localStorage.getItem(TOUR_PROMPT_DISABLED_KEY) === "1";
      if (disabled) return;

      const lastShownRaw = window.localStorage.getItem(TOUR_PROMPT_LAST_SHOWN_KEY);
      const lastShown = lastShownRaw ? Number(lastShownRaw) : 0;
      const now = Date.now();
      if (lastShown && now - lastShown < TOUR_PROMPT_COOLDOWN_MS) return;

      window.localStorage.setItem(TOUR_PROMPT_LAST_SHOWN_KEY, String(now));
      window.setTimeout(() => this.#showPrompt(), 600);
    } catch {
      window.setTimeout(() => this.#showPrompt(), 600);
    }
  }

  #showPrompt() {
    const existing = document.getElementById("gcop-tour-prompt");
    if (existing) return;

    const modal = document.createElement("div");
    modal.id = "gcop-tour-prompt";
    modal.className = "gcop-tour-prompt";
    modal.innerHTML = `
      <div class="gcop-tour-prompt-card">
        <div class="gcop-tour-prompt-title">Take a Quick Product Tour?</div>
        <div class="gcop-tour-prompt-text">
          This guided tour explains controls, tools, layers, and the time slider workflow.
        </div>
        <div class="gcop-tour-prompt-actions">
          <button class="gcop-tour-prompt-btn gcop-tour-prompt-later" id="gcop-tour-prompt-later">Later</button>
          <button class="gcop-tour-prompt-btn gcop-tour-prompt-disable" id="gcop-tour-prompt-disable">Don't ask again</button>
          <button class="gcop-tour-prompt-btn gcop-tour-prompt-start" id="gcop-tour-prompt-start">Start Tour</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("active"));

    const close = () => {
      modal.classList.remove("active");
      window.setTimeout(() => modal.remove(), 220);
    };

    document.getElementById("gcop-tour-prompt-start")?.addEventListener("click", async () => {
      close();
      await sleep(180);
      this.start();
    });

    document.getElementById("gcop-tour-prompt-later")?.addEventListener("click", () => {
      close();
    });

    document.getElementById("gcop-tour-prompt-disable")?.addEventListener("click", () => {
      try {
        window.localStorage.setItem(TOUR_PROMPT_DISABLED_KEY, "1");
      } catch {
        // no-op
      }
      close();
    });
  }
}
