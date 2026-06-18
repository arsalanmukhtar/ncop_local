// UserControl.js

/**
 * Handles the top-right user control button and panel visibility.
 */
export class UserControl {
    constructor() {
        this.render();
        this.addEventListeners();
    }

    /**
     * Renders the custom user button HTML.
     */
    render() {
        const mapContainer = document.getElementById("map");
        const userContainer = document.createElement("div");
        userContainer.className = "custom-user-control";
        userContainer.innerHTML = `
            <button id="userToggle" class="custom-user-btn" title="User Info">
                <i data-lucide="user"></i>
            </button>
        `;
        mapContainer.appendChild(userContainer);
        lucide.createIcons();
    }

    /**
     * Adds event listeners for the user button and outside clicks.
     */
    addEventListeners() {
        const userToggle = document.getElementById("userToggle");
        const userPanel = document.getElementById("userPanel");

        if (userToggle && userPanel) {
            userToggle.addEventListener("click", function () {
                userPanel.classList.toggle("user-panel-visible");
            });

            document.addEventListener("click", function (event) {
                if (
                    !userPanel.contains(event.target) &&
                    !userToggle.contains(event.target)
                ) {
                    userPanel.classList.remove("user-panel-visible");
                }
            });
        }
    }
}
