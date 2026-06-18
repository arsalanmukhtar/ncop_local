// Local Storage Manager for NCOP Application
class NCOPStorageManager {    constructor() {
        this.storagePrefix = 'ncop_';
        this.currentUser = null;        this.defaultSettings = {
            // Map Settings
            mapCenter: [74.3, 31.5], // Pakistan coordinates
            mapZoom: 6,
            mapBearing: 0,
            mapPitch: 0,
            labelsEnabled: true,
            
            // UI Settings
            userPanelVisible: false,
            basemapPanelVisible: false,
            
            // Theme Settings
            theme: 'default',
            
            // User Preferences
            autoSaveInterval: 30000, // 30 seconds
            notifications: true,
            
            // Last Activity
            lastLogin: null,
            lastActivity: null,
            sessionData: {}
        };
        
        this.init();
    }
    
    init() {
        // Get current user from Django context if available
        if (window.USER_ID) {
            this.currentUser = window.USER_ID;
        }
        
        // Initialize user settings if they don't exist
        this.initializeUserSettings();
        
        // Set up auto-save
        this.setupAutoSave();
        
        // console.log('🗄️ NCOP Storage Manager initialized for user:', this.currentUser);
    }
    
    // Generate user-specific storage key
    getUserKey(key) {
        if (this.currentUser) {
            return `${this.storagePrefix}user_${this.currentUser}_${key}`;
        }
        return `${this.storagePrefix}guest_${key}`;
    }
    
    // Initialize user settings with defaults
    initializeUserSettings() {
        const settings = this.getAllSettings();
        if (!settings || Object.keys(settings).length === 0) {
            this.saveAllSettings(this.defaultSettings);
            // console.log('📝 Initialized default settings for user');
        }
    }
    
    // Save individual setting
    saveSetting(key, value) {
        try {
            const storageKey = this.getUserKey(key);
            localStorage.setItem(storageKey, JSON.stringify({
                value: value,
                timestamp: Date.now(),
                user: this.currentUser
            }));
            // console.log(`💾 Saved ${key}:`, value);
        } catch (error) {
            console.error('❌ Error saving to localStorage:', error);
        }
    }
    
    // Get individual setting
    getSetting(key, defaultValue = null) {
        try {
            const storageKey = this.getUserKey(key);
            const stored = localStorage.getItem(storageKey);
            
            if (stored) {
                const parsed = JSON.parse(stored);
                return parsed.value;
            }
            
            // Return default from defaultSettings or provided default
            return this.defaultSettings[key] !== undefined ? this.defaultSettings[key] : defaultValue;
        } catch (error) {
            console.error('❌ Error reading from localStorage:', error);
            return this.defaultSettings[key] !== undefined ? this.defaultSettings[key] : defaultValue;
        }
    }
    
    // Save all settings at once
    saveAllSettings(settings) {
        Object.keys(settings).forEach(key => {
            this.saveSetting(key, settings[key]);
        });
    }
    
    // Get all settings
    getAllSettings() {
        const settings = {};
        Object.keys(this.defaultSettings).forEach(key => {
            settings[key] = this.getSetting(key);
        });
        return settings;
    }
    
    // Map-specific methods
    saveMapState(mapInstance) {
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        const bearing = mapInstance.getBearing();
        const pitch = mapInstance.getPitch();
        
        this.saveSetting('mapCenter', [center.lng, center.lat]);
        this.saveSetting('mapZoom', zoom);
        this.saveSetting('mapBearing', bearing);
        this.saveSetting('mapPitch', pitch);
        
        // console.log('🗺️ Map state saved');
    }
    
    restoreMapState(mapInstance) {
        const center = this.getSetting('mapCenter');
        const zoom = this.getSetting('mapZoom');
        const bearing = this.getSetting('mapBearing');
        const pitch = this.getSetting('mapPitch');
        
        if (center && zoom !== null) {
            mapInstance.jumpTo({
                center: center,
                zoom: zoom,
                bearing: bearing,
                pitch: pitch
            });
            // console.log('🗺️ Map state restored');
        }    }
    
    saveLabelsState(enabled) {
        this.saveSetting('labelsEnabled', enabled);
    }
    
    getLabelsState() {
        return this.getSetting('labelsEnabled');
    }
    
    // UI State methods
    saveUserPanelState(visible) {
        this.saveSetting('userPanelVisible', visible);
    }
    
    getUserPanelState() {
        return this.getSetting('userPanelVisible');
    }
    
    saveBasemapPanelState(visible) {
        this.saveSetting('basemapPanelVisible', visible);
    }
    
    getBasemapPanelState() {
        return this.getSetting('basemapPanelVisible');
    }
    
    // Session management
    saveSessionData(key, value) {
        const sessionData = this.getSetting('sessionData', {});
        sessionData[key] = {
            value: value,
            timestamp: Date.now()
        };
        this.saveSetting('sessionData', sessionData);
    }
    
    getSessionData(key) {
        const sessionData = this.getSetting('sessionData', {});
        return sessionData[key] ? sessionData[key].value : null;
    }
    
    // Activity tracking
    updateLastActivity() {
        this.saveSetting('lastActivity', Date.now());
    }
    
    updateLastLogin() {
        this.saveSetting('lastLogin', Date.now());
    }
    
    getLastActivity() {
        return this.getSetting('lastActivity');
    }
    
    getLastLogin() {
        return this.getSetting('lastLogin');
    }
    
    // Auto-save functionality
    setupAutoSave() {
        const interval = this.getSetting('autoSaveInterval', 30000);
        
        setInterval(() => {
            this.updateLastActivity();
        }, interval);
        
        // Save on page unload
        window.addEventListener('beforeunload', () => {
            this.updateLastActivity();
        });
    }
    
    // Clear user data
    clearUserData() {
        const keys = Object.keys(localStorage);
        const userPrefix = this.getUserKey('');
        
        keys.forEach(key => {
            if (key.startsWith(userPrefix.slice(0, -1))) { // Remove trailing underscore
                localStorage.removeItem(key);
            }
        });
        
        // console.log('🗑️ User data cleared');
    }
    
    // Export settings for backup
    exportSettings() {
        const settings = this.getAllSettings();
        const exportData = {
            user: this.currentUser,
            timestamp: Date.now(),
            version: '1.0',
            settings: settings
        };
        
        return JSON.stringify(exportData, null, 2);
    }
    
    // Import settings from backup
    importSettings(jsonData) {
        try {
            const importData = JSON.parse(jsonData);
            
            if (importData.settings) {
                this.saveAllSettings(importData.settings);
                // console.log('📥 Settings imported successfully');
                return true;
            }
        } catch (error) {
            console.error('❌ Error importing settings:', error);
        }
        
        return false;
    }
    
    // Get storage usage info
    getStorageInfo() {
        const keys = Object.keys(localStorage);
        const userKeys = keys.filter(key => key.startsWith(this.getUserKey('')));
        
        let totalSize = 0;
        userKeys.forEach(key => {
            totalSize += localStorage.getItem(key).length;
        });
        
        return {
            totalKeys: userKeys.length,
            totalSize: totalSize,
            sizeKB: (totalSize / 1024).toFixed(2),
            maxSize: '5-10MB (browser dependent)',
            keys: userKeys
        };
    }
    
    // Check if localStorage is available
    static isAvailable() {
        try {
            const test = '__localStorage_test__';
            localStorage.setItem(test, test);
            localStorage.removeItem(test);
            return true;
        } catch (error) {
            return false;
        }
    }
}

export default NCOPStorageManager;
