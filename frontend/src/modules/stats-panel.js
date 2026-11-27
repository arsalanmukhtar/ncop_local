// stats-panel.js
// Shared shell for NCOP's standalone "Open Stats Panel" panels that follow
// the heatwave stats panel (#heatwave-stats-modal): same markup and CSS
// classes (stats grid left, tabbed chart right, loader, footnote, resize
// handle) and the same drag/resize code (attachHeatwaveDragAndResize).
// Each panel gets its own element and accent class; the caller fills the
// content and draws charts. Used by iwmi-stats-modal.js and
// hawanama-stats-modal.js.
//
//   const panel = createStatsPanel({ id: "x-stats-modal", accentClass: "x-modal", ariaLabel: "…", onTab });
//   await panel.ensure();             // builds the element once
//   panel.open(); panel.setText("name", "…"); panel.$("stats").innerHTML = "…";
//   panel.chart = new Chart(panel.$("canvas").getContext("2d"), …);
//   panel.hide();
// Element ids are `${id}-${part}` for part in: kicker, name, meta, badge,
// stats, tabs, title, sub, legend, canvas, loader, footnote.

export function createStatsPanel({ id, accentClass, ariaLabel, kicker = "", onTab = null, onClose = null }) {
  const panel = {
    chart: null,
    ctx: null,

    el() {
      return document.getElementById(id);
    },

    $(part) {
      return document.getElementById(`${id}-${part}`);
    },

    setText(part, text) {
      const el = panel.$(part);
      if (el) el.textContent = text;
    },

    setLoader(on) {
      const el = panel.$("loader");
      if (el) el.style.display = on ? "flex" : "none";
    },

    destroyChart() {
      if (panel.chart) {
        try { panel.chart.destroy(); } catch (_) {}
        panel.chart = null;
      }
    },

    setBadge(text, variant) {
      const badge = panel.$("badge");
      if (!badge) return;
      badge.textContent = text;
      badge.className = `heatwave-modal__badge ncop-popup__badge ncop-popup__badge--${variant || "neutral"}`;
    },

    setTabs(tabs) {
      const host = panel.$("tabs");
      if (!host) return;
      host.innerHTML = tabs.map((t, i) =>
        `<button class="heatwave-modal__tab${i === 0 ? " is-active" : ""}" data-mode="${t.mode}" type="button">${t.label}</button>`).join("");
    },

    open() {
      const el = panel.el();
      if (!el) return;
      el.classList.remove("hidden");
      el.classList.add("is-open");
    },

    hide() {
      const el = panel.el();
      if (!el) return;
      el.classList.add("hidden");
      el.classList.remove("is-open");
      panel.destroyChart();
      panel.ctx = null;
      if (onClose) onClose();
    },

    /** True while `ctx` is still the context shown (guards late async renders). */
    isCurrent(ctx) {
      return panel.ctx === ctx;
    },

    async ensure() {
      let modal = panel.el();
      if (modal) return modal;
      modal = document.createElement("div");
      modal.id = id;
      modal.className = `heatwave-modal ${accentClass || ""} hidden`;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-label", ariaLabel || "Stats");
      modal.innerHTML = `
        <div class="heatwave-modal__head" data-heatwave-drag>
          <div class="heatwave-modal__drag-grip" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="heatwave-modal__title-block">
            <div class="heatwave-modal__kicker" id="${id}-kicker">${kicker}</div>
            <div class="heatwave-modal__title" id="${id}-name">—</div>
            <div class="heatwave-modal__subtitle" id="${id}-meta"></div>
          </div>
          <span class="heatwave-modal__badge ncop-popup__badge ncop-popup__badge--neutral" id="${id}-badge">—</span>
          <button type="button" class="heatwave-modal__close" aria-label="Close" data-heatwave-close data-stats-panel-close>×</button>
        </div>
        <div class="heatwave-modal__body">
          <aside class="heatwave-modal__left">
            <div class="heatwave-modal__stats" id="${id}-stats"></div>
          </aside>
          <section class="heatwave-modal__right">
            <div class="heatwave-modal__tabs" role="tablist" id="${id}-tabs"></div>
            <div class="heatwave-modal__chart-wrap">
              <div class="heatwave-modal__chart-head">
                <div class="heatwave-modal__chart-title" id="${id}-title">—</div>
                <div class="heatwave-modal__chart-sub" id="${id}-sub">Loading…</div>
              </div>
              <div class="stats-panel__legend" id="${id}-legend"></div>
              <div class="heatwave-modal__canvas-host">
                <canvas id="${id}-canvas"></canvas>
                <div class="heatwave-modal__loader" id="${id}-loader"><span></span><span></span><span></span></div>
              </div>
              <div class="heatwave-modal__footnote" id="${id}-footnote"></div>
            </div>
          </section>
        </div>
        <div class="heatwave-modal__resize" data-heatwave-resize aria-label="Resize">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 6 L6 14 M14 10 L10 14" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
        </div>`;
      document.body.appendChild(modal);

      modal.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-stats-panel-close]")) {
          panel.hide();
          return;
        }
        const tab = ev.target.closest(".heatwave-modal__tab");
        if (tab && panel.ctx) {
          modal.querySelectorAll(".heatwave-modal__tab").forEach((t) => t.classList.toggle("is-active", t === tab));
          if (onTab) onTab(panel.ctx, tab.getAttribute("data-mode"));
        }
      });
      // Same drag/resize as the heatwave panel. Loaded lazily: a static
      // import would form a cycle (layer-attribute-popup.js imports the
      // popups that open these panels).
      try {
        const { attachHeatwaveDragAndResize } = await import("./layer-attribute-popup.js");
        attachHeatwaveDragAndResize(modal);
      } catch (err) {
        console.warn(`[stats-panel] ${id}: drag/resize unavailable`, err);
      }
      return modal;
    },
  };
  return panel;
}

/** One legend chip per {color, label}, for a panel's legend row. */
export function statsPanelLegend(entries) {
  return entries.map((e) =>
    `<span class="stats-panel__legend-item"><span class="stats-panel__legend-dot" style="background:${e.color};"></span>${String(e.label ?? "")
      .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</span>`).join("");
}
