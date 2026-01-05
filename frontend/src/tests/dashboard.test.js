import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import DashboardManager from '../modules/dashboard.js'
import NCOPStorageManager from '../modules/local-storage-manager.js'
import { MapControls } from '../modules/map-controls.js'

// Mock mapbox
const mockMap = {
  addControl: vi.fn(),
  removeControl: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  getStyle: vi.fn(() => ({ layers: [] })),
  setStyle: vi.fn(),
  setCenter: vi.fn(),
  setZoom: vi.fn(),
  setBearing: vi.fn(),
  setPitch: vi.fn(),
  getCenter: vi.fn(() => [0, 0]),
  getZoom: vi.fn(() => 10),
  getBearing: vi.fn(() => 0),
  getPitch: vi.fn(() => 0)
}

describe('DashboardManager', () => {
  let dashboardManager
  
  beforeEach(() => {
    // Reset window.mapboxgl mock
    global.window.mapboxgl = {
      Map: vi.fn(() => mockMap),
      accessToken: 'test-token'
    }
    
    // Reset localStorage mock
    localStorage.clear()
    
    // Mock story manager
    global.initStoryManager = vi.fn(() => ({ mountStory: vi.fn() }))
    global.waitForEl = vi.fn(() => Promise.resolve(document.createElement('div')))
    
    dashboardManager = new DashboardManager()
  })
  
  afterEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })
  
  describe('initialization', () => {
    it('should initialize successfully when mapbox token is available', () => {
      expect(dashboardManager).toBeDefined()
      expect(window.mapboxgl.Map).toHaveBeenCalled()
    })
    
    it('should log error when mapbox token is missing', () => {
      global.window.mapboxgl.accessToken = null
      
      const consoleSpy = vi.spyOn(console, 'error')
      new DashboardManager()
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Mapbox access token not found')
      )
    })
    
    it('should expose global map instance', () => {
      new DashboardManager().init()
      
      expect(window.map).toBe(mockMap)
      expect(window.ncop_map).toBe(mockMap)
    })
  })
  
  describe('map initialization', () => {
    beforeEach(() => {
      // Mock DOM elements
      document.body.innerHTML = '<div id="map"></div>'
    })
    
    it('should create map with default settings', () => {
      dashboardManager.#initializeMap()
      
      expect(window.mapboxgl.Map).toHaveBeenCalledWith(
        expect.objectContaining({
          container: 'map',
          style: 'mapbox://styles/mapbox/streets-v12',
          center: [74.3, 31.5],
          zoom: 6,
          hash: true
        })
      )
    })
    
    it('should use saved settings from storage when available', () => {
      const mockStorage = {
        getSetting: vi.fn((key) => {
          const settings = {
            mapCenter: [70, 30],
            mapZoom: 8,
            mapProjection: 'globe'
          }
          return settings[key]
        })
      }
      global.window.ncop_storage = mockStorage
      
      dashboardManager = new DashboardManager()
      dashboardManager.#initializeMap()
      
      expect(window.mapboxgl.Map).toHaveBeenCalledWith(
        expect.objectContaining({
          center: [70, 30],
          zoom: 8,
          projection: 'globe'
        })
      )
    })
  })
  
  describe('component initialization', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div id="map"></div>
        <div class="ncop-container"></div>
      `
    })
    
    it('should initialize story manager', async () => {
      await dashboardManager.init()
      
      expect(global.waitForEl).toHaveBeenCalledWith('#story-root')
      expect(global.initStoryManager).toHaveBeenCalled()
    })
    
    it('should initialize UI components', async () => {
      await dashboardManager.init()
      
      // Should create theme toggler
      expect(document.querySelector('.theme-toggle-wrapper')).toBeTruthy()
      
      // Should setup exclusive panels
      const wrapper = document.querySelector('.map-controls-wrapper')
      expect(wrapper).toBeTruthy()
    })
  })
  
  describe('theme toggling', () => {
    beforeEach(() => {
      document.body.innerHTML = `
        <div class="ncop-container"></div>
        <button class="theme-toggle-btn"></button>
      `
      global.window.lucide = { createIcons: vi.fn() }
    })
    
    it('should toggle between day and night themes', async () => {
      await dashboardManager.init()
      
      const toggleBtn = screen.getByRole('button', { name: /Toggle Day\/Night Mode/i })
      
      // Initial state should be day
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
      
      // Click to toggle to night
      await userEvent.click(toggleBtn)
      
      expect(document.documentElement.getAttribute('data-theme')).toBe('night')
      expect(toggleBtn.querySelector('i').getAttribute('data-lucide')).toBe('sun')
      
      // Click to toggle back to day
      await userEvent.click(toggleBtn)
      
      expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
      expect(toggleBtn.querySelector('i').getAttribute('data-lucide')).toBe('moon')
    })
    
    it('should save theme preference to storage', async () => {
      const mockStorage = {
        saveSetting: vi.fn()
      }
      global.window.ncop_storage = mockStorage
      
      await dashboardManager.init()
      const toggleBtn = screen.getByRole('button')
      
      await userEvent.click(toggleBtn)
      
      expect(mockStorage.saveSetting).toHaveBeenCalledWith('theme', 'night')
    })
  })
  
  describe('map event handling', () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="map"></div>'
      dashboardManager.#initializeMap()
    })
    
    it('should handle map load event', () => {
      const onLoadSpy = vi.spyOn(dashboardManager, '#onMapLoad')
      
      // Simulate map load
      mockMap.on.mock.calls.find(call => call[0] === 'load')[1]()
      
      expect(onLoadSpy).toHaveBeenCalled()
    })
    
    it('should handle map move end event', () => {
      const onMoveEndSpy = vi.spyOn(dashboardManager, '#onMapMoveEnd')
      const mockStorage = { saveMapState: vi.fn() }
      dashboardManager.#storage = mockStorage
      
      // Simulate map move
      mockMap.on.mock.calls.find(call => call[0] === 'moveend')[1]()
      
      expect(onMoveEndSpy).toHaveBeenCalled()
      expect(mockStorage.saveMapState).toHaveBeenCalledWith(mockMap)
    })
    
    it('should handle map errors', () => {
      const onErrorSpy = vi.spyOn(dashboardManager, '#handleMapError')
      
      // Simulate map error
      mockMap.on.mock.calls.find(call => call[0] === 'error')[1]({
        error: { message: '404', status: 404 }
      })
      
      expect(onErrorSpy).toHaveBeenCalledWith({
        error: { message: '404', status: 404 }
      })
    })
  })
  
  describe('error handling', () => {
    it('should handle style loading errors gracefully', () => {
      const consoleSpy = vi.spyOn(console, 'warn')
      const setStyleSpy = vi.spyOn(mockMap, 'setStyle')
      
      dashboardManager.#handleMapError({
        error: { message: '404', status: 404 }
      })
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Style loading error detected')
      )
      expect(setStyleSpy).toHaveBeenCalledWith('mapbox://styles/mapbox/streets-v12')
    })
    
    it('should handle critical errors without crashing', () => {
      const consoleSpy = vi.spyOn(console, 'error')
      
      dashboardManager.#handleMapError({
        error: { message: 'Critical error', status: 500 }
      })
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Critical error: Cannot load fallback basemap')
      )
    })
  })
})