// layer-attribute-popup.js
// Themed popup for displaying vector tile feature attributes on click

class LayerAttributePopup {
    constructor(map, layerConfigs) {
        this.map = map;
        this.layerConfigs = layerConfigs;
        this.popupEl = this._createPopupElement();
        this._bindEvents();
    }

    _createPopupElement() {
        const el = document.createElement('div');
        el.className = 'layer-attribute-popup hidden';
        el.innerHTML = '<div class="popup-content"></div>';
        document.body.appendChild(el);
        return el;
    }

    _bindEvents() {
        // Hide popup when clicking outside
        document.addEventListener('mousedown', (e) => {
            if (!this.popupEl.classList.contains('hidden') && !this.popupEl.contains(e.target)) {
                this.hide();
            }
        });
    }

    show(feature, layerId, clickPoint = null) {
        const config = this.layerConfigs[layerId];
        if (!config) return;
        const content = this.popupEl.querySelector('.popup-content');
        let html = `<div class="popup-label">${config.label || layerId}</div>`;
        html += '<div class="popup-attributes-scroll"><table class="popup-attributes">';
        for (const key in feature.properties) {
            const prettyKey = prettyAttributeName(key);
            html += `<tr><td class="attr-key">${prettyKey}</td><td class="attr-value">${feature.properties[key]}</td></tr>`;
        }
        html += '</table></div>';
        content.innerHTML = html;
        // Position popup centered above the clicked point, before showing
        if (clickPoint) {
            this.popupEl.style.visibility = 'hidden';
            this.popupEl.classList.remove('hidden');
            // Wait for DOM to render to get width/height
            requestAnimationFrame(() => {
                const rect = this.popupEl.getBoundingClientRect();
                const popupWidth = rect.width;
                const popupHeight = rect.height;
                const left = clickPoint.x - popupWidth / 2;
                const top = clickPoint.y - popupHeight - 16;
                this.popupEl.style.left = `${Math.max(left, 8)}px`;
                this.popupEl.style.top = `${Math.max(top, 8)}px`;
                this.popupEl.style.visibility = 'visible';
            });
        } else {
            this.popupEl.classList.remove('hidden');
        }
    }

    hide() {
        this.popupEl.classList.add('hidden');
    }
}

function prettyAttributeName(attr) {
    // Replace underscores/dashes with spaces, capitalize each word
    return attr
        .replace(/[_-]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

export default LayerAttributePopup;
