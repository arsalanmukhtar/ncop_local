import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import NCOPStorageManager from '../modules/local-storage-manager.js'

describe('NCOPStorageManager', () => {
  let storageManager
  
  beforeEach(() => {
    // Mock localStorage
    const localStorageMock = {
      store: {},
      getItem: vi.fn((key) => localStorageMock.store[key] || null),
      setItem: vi.fn((key, value) => {
        localStorageMock.store[key] = value.toString()
      }),
      removeItem: vi.fn((key) => {
        delete localStorageMock.store[key]
      }),
      clear: vi.fn(() => {
        localStorageMock.store = {}
      }),
      length: 0,
      key: vi.fn(index => Object.keys(localStorageMock.store)[index] || null)
    }
    
    global.localStorage = localStorageMock
    storageManager = new NCOPStorageManager()
  })
  
  afterEach(() => {
    vi.clearAllMocks()
  })
  
  describe('constructor', () => {
    it('should initialize successfully', () => {
      expect(storageManager).toBeDefined()
      expect(storageManager.isAvailable()).toBe(true)
    })
    
    it('should handle unavailable localStorage', () => {
      global.localStorage = undefined
      
      expect(() => new NCOPStorageManager()).not.toThrow()
      
      const unavailableStorage = new NCOPStorageManager()
      expect(unavailableStorage.isAvailable()).toBe(false)
    })
  })
  
  describe('availability detection', () => {
    it('should detect when localStorage is available', () => {
      expect(NCOPStorageManager.isAvailable()).toBe(true)
    })
    
    it('should detect when localStorage is not available', () => {
      const originalLocalStorage = global.localStorage
      global.localStorage = undefined
      
      expect(NCOPStorageManager.isAvailable()).toBe(false)
      
      global.localStorage = originalLocalStorage
    })
  })
  
  describe('settings management', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should save settings correctly', () => {
      storageManager.saveSetting('test-key', 'test-value')
      
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'ncop_test-key',
        JSON.stringify('test-value')
      )
    })
    
    it('should get settings correctly', () => {
      localStorage.store['ncop_test-key'] = JSON.stringify('test-value')
      
      const result = storageManager.getSetting('test-key')
      
      expect(result).toBe('test-value')
    })
    
    it('should return null for non-existent settings', () => {
      const result = storageManager.getSetting('non-existent-key')
      
      expect(result).toBe(null)
    })
    
    it('should remove settings correctly', () => {
      storageManager.saveSetting('test-key', 'test-value')
      storageManager.removeSetting('test-key')
      
      expect(localStorage.removeItem).toHaveBeenCalledWith('ncop_test-key')
    })
    
    it('should handle complex objects in settings', () => {
      const complexObject = {
        mapCenter: [74.3, 31.5],
        mapZoom: 8,
        preferences: { theme: 'dark', language: 'en' }
      }
      
      storageManager.saveSetting('complex-setting', complexObject)
      
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'ncop_complex-setting',
        JSON.stringify(complexObject)
      )
      
      const result = storageManager.getSetting('complex-setting')
      expect(result).toEqual(complexObject)
    })
  })
  
  describe('map state management', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should save map state correctly', () => {
      const mapState = {
        center: [74.3, 31.5],
        zoom: 8,
        bearing: 0,
        pitch: 0
      }
      
      const mockMap = {
        getCenter: vi.fn(() => ({ lng: 74.3, lat: 31.5 })),
        getZoom: vi.fn(() => 8),
        getBearing: vi.fn(() => 0),
        getPitch: vi.fn(() => 0)
      }
      
      storageManager.saveMapState(mockMap)
      
      expect(localStorage.setItem).toHaveBeenCalledWith('ncop_map_state', expect.stringContaining('74.3'))
      expect(localStorage.setItem).toHaveBeenCalledWith('ncop_map_state', expect.stringContaining('8'))
    })
    
    it('should get map settings individually', () => {
      localStorage.store['ncop_map_state'] = JSON.stringify({
        center: [74.3, 31.5],
        zoom: 8,
        bearing: 0,
        pitch: 0
      })
      
      expect(storageManager.getMapCenter()).toEqual([74.3, 31.5])
      expect(storageManager.getMapZoom()).toBe(8)
      expect(storageManager.getMapBearing()).toBe(0)
      expect(storageManager.getMapPitch()).toBe(0)
      expect(storageManager.getMapProjection()).toBe('mercator')
    })
    
    it('should return default values when map state not saved', () => {
      const center = storageManager.getMapCenter()
      const zoom = storageManager.getMapZoom()
      const bearing = storageManager.getMapBearing()
      const pitch = storageManager.getMapPitch()
      const projection = storageManager.getMapProjection()
      
      expect(center).toEqual([74.3, 31.5])  // Default center
      expect(zoom).toBe(6)  // Default zoom
      expect(bearing).toBe(0)  // Default bearing
      expect(pitch).toBe(0)  // Default pitch
      expect(projection).toBe('mercator')  // Default projection
    })
  })
  
  describe('labels state management', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should save labels state', () => {
      storageManager.saveLabelsState(true)
      
      expect(localStorage.setItem).toHaveBeenCalledWith('ncop_labels_enabled', 'true')
    })
    
    it('should get labels state', () => {
      localStorage.store['ncop_labels_enabled'] = 'true'
      
      expect(storageManager.getLabelsState()).toBe(true)
      
      localStorage.store['ncop_labels_enabled'] = 'false'
      expect(storageManager.getLabelsState()).toBe(false)
    })
    
    it('should return default labels state when not saved', () => {
      const labelsState = storageManager.getLabelsState()
      
      expect(labelsState).toBe(true)  // Default is true
    })
  })
  
  describe('user preference management', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should save user preferences', () => {
      const preferences = {
        theme: 'dark',
        language: 'en',
        autoRefresh: true,
        refreshInterval: 30000
      }
      
      storageManager.saveUserPreferences(preferences)
      
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'ncop_user_preferences',
        JSON.stringify(preferences)
      )
    })
    
    it('should get user preferences', () => {
      const preferences = {
        theme: 'dark',
        language: 'en',
        autoRefresh: true,
        refreshInterval: 30000
      }
      
      localStorage.store['ncop_user_preferences'] = JSON.stringify(preferences)
      
      const result = storageManager.getUserPreferences()
      
      expect(result).toEqual(preferences)
    })
    
    it('should return default preferences when not saved', () => {
      const preferences = storageManager.getUserPreferences()
      
      expect(preferences).toEqual({
        theme: 'day',
        language: 'en',
        autoRefresh: false,
        refreshInterval: 60000
      })
    })
  })
  
  describe('last login tracking', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should update last login time', () => {
      const beforeTime = Date.now()
      storageManager.updateLastLogin()
      
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'ncop_last_login',
        expect.stringContaining(beforeTime.toString())
      )
    })
    
    it('should get last login time', () => {
      const loginTime = Date.now()
      localStorage.store['ncop_last_login'] = loginTime.toString()
      
      const result = storageManager.getLastLogin()
      
      expect(result).toBe(loginTime)
    })
  })
  
  describe('data consistency', () => {
    beforeEach(() => {
      localStorage.clear()
    })
    
    it('should handle corrupted localStorage data gracefully', () => {
      localStorage.store['ncop_test-key'] = 'invalid-json'
      
      const consoleSpy = vi.spyOn(console, 'error')
      
      expect(() => storageManager.getSetting('test-key')).not.toThrow()
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse')
      )
    })
    
    it('should handle quota exceeded errors', () => {
      localStorage.setItem.mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
      
      const consoleSpy = vi.spyOn(console, 'error')
      
      storageManager.saveSetting('test-key', 'test-value')
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'LocalStorage quota exceeded:',
        expect.any(Error)
      )
    })
  })
})