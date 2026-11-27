/**
 * Dynamically assigns image sources based on data attributes or selectors.
 * Usage:
 *   setAssets({ ndmaLogo, background })
 *   // matches <img data-asset="ndmaLogo">, <img data-asset="background">
 *
 * You can also map selectors directly:
 *   setAssets({ '#logoEl': ndmaLogo }) // sets src for element with id="logoEl"
 */
export function setAssets(assets = {}, selectorPrefix = "[data-asset]") {
  // data-asset matching
  document.querySelectorAll(selectorPrefix).forEach((el) => {
    const key = el.getAttribute("data-asset");
    if (key && assets[key]) el.src = assets[key];
  });

  // explicit selector mapping (#id, .class, attribute selector, etc.)
  for (const [selector, url] of Object.entries(assets)) {
    if (
      selector.startsWith("#") ||
      selector.startsWith(".") ||
      selector.includes("[")
    ) {
      const el = document.querySelector(selector);
      if (el) el.src = url;
    }
  }
}