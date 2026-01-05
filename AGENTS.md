# NCOP Project - Agent Development Guide

This guide provides build commands, testing procedures, and coding conventions for agentic coding agents working in the NCOP (National Climate Operations Platform) repository.

## Project Structure

- **Backend**: Django project in `project/` directory with PostGIS database
- **Frontend**: Vite + JavaScript application in `frontend/` directory
- **Static Assets**: Built frontend assets served from `project/static/dist/`

## Build & Development Commands

### Frontend (Vite)
```bash
# Navigate to frontend directory
cd frontend

# Development server with HMR
npm run dev

# Production build
npm run build

# Build and copy manifest to Django
npm run build-and-copy

# Preview production build
npm run preview
```

### Backend (Django)
```bash
# Navigate to project directory
cd project

# Development server
python manage.py runserver

# Database migrations
python manage.py makemigrations
python manage.py migrate

# Create superuser
python manage.py createsuperuser

# Collect static files
python manage.py collectstatic

# Django shell
python manage.py shell
```

### Testing Commands
```bash
# Run all tests
cd project && python manage.py test

# Run specific app tests
cd project && python manage.py test ncop_internal

# Run single test file
cd project && python manage.py test ncop_internal.tests.test_views

# Run with verbose output
cd project && python manage.py test --verbosity=2

# Frontend testing (if available)
cd frontend && npm test
```

## Code Style Guidelines

### JavaScript/ES6+ Conventions

#### Imports & Dependencies
- Use ES6 import/export syntax consistently
- Group imports in this order: 1) Third-party libraries, 2) Local modules, 3) Relative imports
- Always include `.js` extension for relative imports in Vite projects
- Use named exports for utilities, default exports for main classes

```javascript
// ✅ Correct import ordering
import mapboxgl from 'mapbox-gl';
import { MapControls } from './map-controls.js';
import { UtilityManager } from './utility-manager.js';
```

#### Naming Conventions
- **Classes**: PascalCase (e.g., `DashboardManager`, `MapControls`)
- **Functions/Methods**: camelCase (e.g., `initializeMap()`, `toggleMapLabels()`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `DEFAULT_ZOOM_LEVEL`)
- **Private members**: Use `#` prefix for truly private class fields
- **Global variables**: Use descriptive names with `window.` prefix when necessary

#### Code Organization
- Use class-based architecture for complex components
- Separate concerns: UI logic, data management, and event handling
- Export classes and functions at module level, avoid side effects
- Use JSDoc comments for public APIs and complex functions

```javascript
/**
 * Handles Mapbox map interactions and state management
 * @param {mapboxgl.Map} mapInstance - The Mapbox map instance
 * @param {NCOPStorageManager} storageInstance - Storage manager for persistence
 */
export class MapControls {
    #map;
    #storage;
    
    constructor(mapInstance, storageInstance) {
        this.#map = mapInstance;
        this.#storage = storageInstance;
    }
}
```

### Python/Django Conventions

#### Imports & Dependencies
- Organize imports: 1) Standard library, 2) Third-party, 3) Django, 4) Local
- Use specific imports instead of wildcards (`from django.shortcuts import render, redirect`)
- Group related imports together

```python
# ✅ Correct import organization
from django.conf import settings
from django.contrib import messages
from django.shortcuts import render, redirect
from .models import UserProfile
from .utils import helper_function
```

#### Naming Conventions
- **Models**: PascalCase (e.g., `UserProfile`, `DataLayer`)
- **Views/Functions**: snake_case (e.g., `dashboard_view`, `get_user_data`)
- **Variables**: snake_case (e.g., `user_data`, `map_center`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_ZOOM_LEVEL`)
- **Private methods**: Prefix with underscore (e.g., `_process_data()`)

#### Django Patterns
- Use class-based views for complex logic, function-based views for simple cases
- Implement proper error handling with try/catch blocks
- Use Django's built-in decorators (`@login_required`, `@csrf_exempt`)
- Follow Django's request-response cycle patterns

```python
# ✅ Class-based view example
class DashboardView(LoginRequiredMixin, View):
    def get(self, request):
        try:
            context = self._get_context_data(request)
            return render(request, 'dashboard.html', context)
        except Exception as e:
            messages.error(request, f"Error loading dashboard: {e}")
            return redirect('home')
    
    def _get_context_data(self, request):
        # Helper method for context preparation
        return {'user': request.user}
```

### CSS/Styling Conventions

#### Tailwind CSS Integration
- Use Tailwind utility classes for rapid development
- Define custom CSS variables for brand colors in `:root`
- Follow BEM methodology for custom component classes
- Use CSS custom properties for theme switching

```css
/* ✅ Custom CSS with Tailwind integration */
:root {
    --ndma-green: #2ecc71;
    --ndma-blue: #46b2ff;
}

.map-controls-wrapper {
    @apply glass-morphism bg-black/20 backdrop-blur-sm;
    border: 1px solid var(--ndma-green);
}
```

## Error Handling Guidelines

### JavaScript
- Use try/catch blocks for async operations and API calls
- Implement graceful fallbacks for map loading errors
- Log errors with context information
- Provide user-friendly error messages

```javascript
try {
    this.#map.setStyle(mapStyle);
} catch (error) {
    console.error('Map style loading failed:', error);
    this.#fallbackToDefaultStyle();
}
```

### Python/Django
- Use Django's built-in error handling (Http404, PermissionDenied)
- Implement proper exception handling in views
- Log errors with appropriate levels
- Return meaningful error responses for APIs

## Environment Configuration

### Required Environment Variables
- `MAPBOX_ACCESS_TOKEN`: Mapbox GL JS access token
- `DJANGO_SECRET_KEY`: Django secret key
- `POSTGRES_DB/USER/PASSWORD/HOST/PORT`: Database connection
- `GEE_PROJECT_ID`: Google Earth Engine project ID

### Development Setup
1. Copy `.env.example` to `.env` and configure variables
2. Install Python dependencies from `requirements.txt`
3. Install Node.js dependencies in `frontend/`
4. Run database migrations
5. Start both development servers

## Git Workflow

### Branch Strategy
- `main`: Production-ready code
- `dev-arsalan`: Development branch
- `stage-arsalan`: Staging branch

### Commit Guidelines
- Use descriptive commit messages
- Reference issue numbers when applicable
- Keep commits focused on single features/fixes

## Security Considerations

- Never commit secrets or API keys
- Use environment variables for sensitive configuration
- Implement proper CSRF protection
- Validate all user inputs
- Use Django's built-in security middleware

## Performance Guidelines

### Frontend
- Lazy load map layers and components
- Use efficient event delegation
- Implement proper cleanup for event listeners
- Optimize bundle size with tree shaking

### Backend
- Use Django's caching framework
- Implement database query optimization
- Use select_related/prefetch_related for queries
- Consider async tasks for long-running operations

## Testing Strategy

### Backend Tests
- Unit tests for models and utility functions
- Integration tests for views and APIs
- Test database migrations
- Use Django's test client for request testing

### Frontend Tests
- Component testing for UI interactions
- Integration tests for map functionality
- Test error handling and edge cases
- Validate responsive design behavior

## Deployment Notes

### Production Build Process
1. Build frontend assets: `npm run build`
2. Collect static files: `python manage.py collectstatic`
3. Run database migrations
4. Configure production settings in `settings/prod.py`

### Static File Serving
- Frontend builds to `frontend/dist/`
- Django serves static files from `project/static/dist/`
- Use WhiteNoise for static file serving in production
- Configure CDN for improved performance