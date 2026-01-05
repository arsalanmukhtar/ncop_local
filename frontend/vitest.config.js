import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Global setup for all tests
    setupFiles: ['./src/tests/setup.js'],
    
    // Test environment
    environment: 'jsdom',
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/tests/',
        '**/*.config.js',
        '**/dist/'
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80
        }
      }
    },
    
    // Include patterns
    include: [
      'src/**/*.{js,ts,jsx,tsx}',
      '!src/**/*.test.{js,ts,jsx,tsx}',
      '!src/tests/**/*'
    ],
    
    // Exclude patterns
    exclude: [
      'node_modules/',
      'dist/',
      'coverage/',
      '**/*.config.js'
    ],
    
    // Test timeout (ms)
    testTimeout: 10000,
    
    // Hook timeout (ms)
    hookTimeout: 10000,
    
    // Globals available in tests
    globals: {
      mapboxgl: 'readonly',
      window: 'readonly',
      document: 'readonly',
      console: 'readonly',
      localStorage: 'readonly',
      sessionStorage: 'readonly',
      navigator: 'readonly'
    }
  }
})