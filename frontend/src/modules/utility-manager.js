// UtilityManager.js

/**
 * Encapsulates global utility functions (export/import settings, storage info)
 * and handles keyboard shortcuts.
 */
export class UtilityManager {
    #storage = window.ncop_storage;

    constructor() {
        this.#exposeGlobals();
        this.#addKeyboardShortcuts();
        this.#logInfo();
    }

    /**
     * Exposes utility functions globally under window.ncop_utils.
     */
    #exposeGlobals() {
        window.ncop_utils = {
            exportSettings: this.exportSettings.bind(this),
            importSettings: this.importSettings.bind(this),
            clearAllData: this.clearAllData.bind(this),
            showStorageInfo: this.showStorageInfo.bind(this),
            resetToDefaults: this.resetToDefaults.bind(this),
        };
    }

    #addKeyboardShortcuts() {
        document.addEventListener("keydown", (e) => {
            if (e.ctrlKey && e.shiftKey) {
                switch (e.key) {
                    case "E": // Ctrl+Shift+E: Export settings
                        e.preventDefault();
                        this.exportSettings();
                        break;
                    case "I": // Ctrl+Shift+I: Import settings
                        e.preventDefault();
                        this.importSettings();
                        break;
                    case "D": // Ctrl+Shift+D: Show storage info
                        e.preventDefault();
                        this.showStorageInfo();
                        break;
                }
            }
        });
    }

    #logInfo() {
        // console.log("🔧 NCOP Utilities loaded. Available commands: (ncop_utils.[command])");
    }

    // --- Core Utility Methods ---

    exportSettings() {
        if (this.#storage) {
            const data = this.#storage.exportSettings();
            const blob = new Blob([data], { type: "application/json" });
            const url = URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.href = url;
            a.download = `ncop-settings-${new Date().toISOString().split("T")[0]
                }.json`;
            a.click();

            URL.revokeObjectURL(url);
            // console.log("📥 Settings exported");
        }
    }

    importSettings() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";

        input.onchange = (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const jsonData = e.target.result;
                    if (this.#storage && this.#storage.importSettings(jsonData)) {
                        alert("Settings imported successfully! Please refresh the page.");
                    } else {
                        alert("Failed to import settings. Please check the file format.");
                    }
                };
                reader.readAsText(file);
            }
        };
        input.click();
    }

    clearAllData() {
        if (
            confirm(
                "Are you sure you want to clear all saved data? This cannot be undone."
            )
        ) {
            if (this.#storage) {
                this.#storage.clearUserData();
                alert("All data cleared! Please refresh the page.");
            }
        }
    }

    showStorageInfo() {
        if (this.#storage) {
            const info = this.#storage.getStorageInfo();
            console.table(info);

            const message = `
Storage Information:
- Total Keys: ${info.totalKeys}
- Total Size: ${info.sizeKB} KB
- Max Size: ${info.maxSize}
- User: ${window.USERNAME || "Guest"}
            `;
            alert(message);
        }
    }

    resetToDefaults() {
        if (
            confirm(
                "Reset all settings to defaults? This will clear your preferences."
            )
        ) {
            if (this.#storage) {
                this.#storage.clearUserData();
                this.#storage.initializeUserSettings();
                alert("Settings reset to defaults! Please refresh the page.");
            }
        }
    }
}
