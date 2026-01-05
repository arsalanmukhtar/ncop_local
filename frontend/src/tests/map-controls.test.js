import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'
import { MapControls } from '../modules/map-controls.js'

describe('MapControls', () => {
  let mapControls
  let mockMap
  let mockStorage
  
  beforeEach(() => {
    mockMap = {
      on: vi.fn(),
      off: vi.fn(),
      getStyle: vi.fn(() => ({ layers: [] })),
      setLayoutProperty: vi.fn(),
      setCenter: vi.fn(),
      setZoom: vi.fn(),
      setBearing: vi.fn(),
      setPitch: vi.fn(),
      getCenter: vi.fn(() => ({ lng: 0, lat: 0 })),
      getZoom: vi.fn(() => 10),
      getBearing: vi.fn(() => 0),
      getPitch: vi.fn(() => 0),
      setStyle: vi.fn(),
      setProjection: vi.fn(),
      addSource: vi.fn(),
      removeSource: vi.fn(),
      addLayer: vi.fn(),
      removeLayer: vi.fn(),
      querySourceFeatures: vi.fn(),
      queryRenderedFeatures: vi.fn()
    }
    
    mockStorage = {
      saveSetting: vi.fn(),
      getSetting: vi.fn()
    }
    
    mapControls = new MapControls(mockMap, mockStorage)
  })
  
  afterEach(() => {
    vi.clearAllMocks()
  })
  
  describe('constructor', () => {
    it('should initialize with map and storage instances', () => {
      expect(mapControls).toBeDefined()
      expect(mapControls.#map).toBe(mockMap)
      expect(mapControls.#storage).toBe(mockStorage)
    })
  })
  
  describe('toggleMapLabels', () => {
    beforeEach(() => {
      mockMap.getStyle.mockReturnValue({
        layers: [
          { type: 'symbol', layout: { 'text-field': 'name' }},
          { type: 'fill' },
          { type: 'line' },
          { type: 'background' }
        ]
      })
    })
    
    it('should enable map labels', () => {
      mapControls.toggleMapLabels(true)
      
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
        expect.any(String),
        'visibility',
        'visible'
      )
    })
    
    it('should disable map labels', () => {
      mapControls.toggleMapLabels(false)
      
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
        expect.any(String),
        'visibility',
        'none'
      )
    })
    
    it('should only target symbol layers with text-field', () => {
      mapControls.toggleMapLabels(true)
      
      expect(mockMap.setLayoutProperty).toHaveBeenCalledTimes(1)
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
        expect.any(String),
        'visibility',
        expect.any(String)
      )
    })
    
    it('should handle map style without layers gracefully', () => {
      mockMap.getStyle.mockReturnValue({})
      
      expect(() => mapControls.toggleMapLabels(true)).not.toThrow()
    })
  })
  
  describe('changeMapProjection', () => {
    it('should change map projection', () => {
      mapControls.changeMapProjection('globe')
      
      expect(mockMap.setProjection).toHaveBeenCalledWith('globe')
    })
    
    it('should save projection to storage', () => {
      mapControls.changeMapProjection('globe')
      
      expect(mockStorage.saveSetting).toHaveBeenCalledWith('mapProjection', 'globe')
    })
    
    it('should handle projection change errors gracefully', () => {
      mockMap.setProjection.mockImplementation(() => {
        throw new Error('Unsupported projection')
      })
      
      expect(() => mapControls.changeMapProjection('invalid')).not.toThrow()
    })
  })
  
  describe('enableTerrain', () => {
    it('should enable 3D terrain', () => {
      mapControls.enableTerrain()
      
      expect(mockMap.setPitch).toHaveBeenCalledWith(45)
      expect(mockStorage.saveSetting).toHaveBeenCalledWith('terrainEnabled', true)
    })
  })
  
  describe('loadSavedMapState', () => {
    it('should load saved map state', () => {
      const savedState = {
        center: [70, 30],
        zoom: 8,
        bearing: 90,
        pitch: 45,
        projection: 'globe',
        terrainEnabled: true,
        labelsEnabled: false
      }
      
      mockStorage.getSetting.mockImplementation((key) => savedState[key])
      
      mapControls.loadSavedMapState()
      
      expect(mockMap.setCenter).toHaveBeenCalledWith(savedState.center)
      expect(mockMap.setZoom).toHaveBeenCalledWith(savedState.zoom)
      expect(mockMap.setBearing).toHaveBeenCalledWith(savedState.bearing)
      expect(mockMap.setPitch).toHaveBeenCalledWith(savedState.pitch)
      expect(mockMap.setProjection).toHaveBeenCalledWith(savedState.projection)
    })
    
    it('should use defaults when no saved state', () => {
      mockStorage.getSetting.mockReturnValue(null)
      
      mapControls.loadSavedMapState()
      
      expect(mockMap.setCenter).toHaveBeenCalledWith([74.3, 31.5])  // Default
      expect(mockMap.setZoom).toHaveBeenCalledWith(6)  // Default
      expect(mockMap.setBearing).toHaveBeenCalledWith(0)  // Default
      expect(mockMap.setPitch).toHaveBeenCalledWith(0)  // Default
    })
    
    it('should apply terrain after delay', async () => {
      const savedState = { terrainEnabled: true }
      mockStorage.getSetting.mockImplementation((key) => savedState[key])
      
      vi.useFakeTimers()
      
      mapControls.loadSavedMapState()
      
      vi.advanceTimersByTime(800)  // 800ms delay
      
      expect(mockMap.setPitch).toHaveBeenCalledWith(45)
      
      vi.useRealTimers()
    })
  })
  
  describe('toggleMapLabels with storage', () => {
    beforeEach(() => {
      mockStorage.getSetting.mockReturnValue(true)
    })
    
    it('should load and apply saved labels state', () => {
      mapControls.loadSavedMapState()
      
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
        expect.any(String),
        'visibility',
        'visible'
      )
    })
    
    it('should apply saved disabled state', () => {
      mockStorage.getSetting.mockReturnValue(false)
      
      mapControls.loadSavedMapState()
      
      expect(mockMap.setLayoutProperty).toHaveBeenCalledWith(
        expect.any(String),
        'visibility',
        'none'
      )
    })
  })
  
  describe('error handling', () => {
    it('should handle invalid projection names', () => {
      expect(() => mapControls.changeMapProjection('')).not.toThrow()
      expect(() => mapControls.changeMapProjection(null)).not.toThrow()
      expect(() => mapControls.changeMapProjection(undefined)).not.toThrow()
    })
    
    it('should handle map errors during projection change', () => {
      const consoleSpy = vi.spyOn(console, 'error')
      
      mockMap.setProjection.mockImplementation(() => {
        throw new Error('Map error')
      })
      
      mapControls.changeMapProjection('globe')
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to change projection:',
        expect.any(Error)
      )
    })
  })
})