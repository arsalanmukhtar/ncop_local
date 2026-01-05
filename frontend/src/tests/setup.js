// Test setup file for Vitest
import { vi } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/dom'
import userEvent from '@testing-library/user-event'

// Mock mapboxgl
global.mapboxgl = {
  accessToken: 'test-token',
  Map: vi.fn(),
  Popup: vi.fn(),
  Marker: vi.fn(),
  LngLat: vi.fn(),
  NavigationControl: vi.fn(),
  GeolocateControl: vi.fn(),
  ScaleControl: vi.fn(),
  FullscreenControl: vi.fn()
}

// Mock window APIs
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  },
  writable: true
})

Object.defineProperty(window, 'sessionStorage', {
  value: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn()
  },
  writable: true
})

Object.defineProperty(window, 'location', {
  value: {
    href: 'http://localhost:5173',
    origin: 'http://localhost:5173'
  },
  writable: true
})

// Mock fetch API
global.fetch = vi.fn()

// Make testing library available globally
global.screen = screen
global.fireEvent = fireEvent
global.waitFor = waitFor
global.within = within
global.userEvent = userEvent

// Setup and cleanup
beforeEach(() => {
  // Clear all mocks before each test
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  // Clean up DOM
  document.body.innerHTML = ''
})