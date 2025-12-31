"""
Mobile App Development Settings
"""

from .base import *
import os

# =============================================================================
# CORE DEBUG & SETTINGS
# =============================================================================
DEBUG = True

ALLOWED_HOSTS = env.list(
    "DJANGO_ALLOWED_HOSTS",
    default=[
        "127.0.0.1",
        "localhost",
        "0.0.0.0",
        "172.18.7.39",
        "182.188.28.163",
    ],
)

# =============================================================================
# AUTO LOGIN DISABLED FOR DEV
# =============================================================================
ALLOW_AUTO_LOGIN = False

# =============================================================================
# CSRF TRUSTED ORIGINS
# =============================================================================
CSRF_TRUSTED_ORIGINS = env.list(
    "CSRF_TRUSTED_ORIGINS",
    default=[
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
)

# =============================================================================
# STATIC FILES
# =============================================================================
STATIC_URL = "/static/"  # ← Back to /static/ for Django
STATIC_ROOT = BASE_DIR / "static" / "dist"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# =============================================================================
# VITE FRONTEND CONFIGURATION (DEV MODE)
# =============================================================================
DJANGO_VITE["default"]["dev_mode"] = True
DJANGO_VITE["default"]["dev_server_host"] = env("VITE_DEV_SERVER_HOST", default="localhost")
DJANGO_VITE["default"]["dev_server_port"] = env.int("VITE_DEV_SERVER_PORT", default=5173)

# CRITICAL FIX for django-vite 3.x: Set static_url_prefix to empty string explicitly
# This prevents /static/ from being prepended in dev mode
DJANGO_VITE["default"]["static_url_prefix"] = ""

# Also set the full dev server URL to bypass static URL logic entirely
vite_host = env("VITE_DEV_SERVER_HOST", default="localhost")
vite_port = env.int("VITE_DEV_SERVER_PORT", default=5173)
DJANGO_VITE["default"]["dev_server_protocol"] = "http"

# =============================================================================
# WSGI
# =============================================================================
WSGI_APPLICATION = "ncop_project.wsgi.application"

# =============================================================================
# DATABASE CONFIGURATION
# =============================================================================
DATABASES["default"]["ENGINE"] = env("POSTGRES_ENGINE", default=DATABASES["default"]["ENGINE"])
DATABASES["default"]["NAME"] = env("POSTGRES_DB", default=DATABASES["default"]["NAME"])
DATABASES["default"]["HOST"] = env("POSTGRES_HOST", default=DATABASES["default"]["HOST"])
DATABASES["default"]["USER"] = env("POSTGRES_USER", default=DATABASES["default"]["USER"])
DATABASES["default"]["PASSWORD"] = env("POSTGRES_PASSWORD", default=DATABASES["default"]["PASSWORD"])
DATABASES["default"]["PORT"] = env("POSTGRES_PORT", default=DATABASES["default"]["PORT"])

# =============================================================================
# EMAIL CONFIGURATION
# =============================================================================
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# =============================================================================
# SSL / COOKIE / REDIRECT SECURITY (DISABLED FOR DEV)
# =============================================================================
SECURE_SSL_REDIRECT = False
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False

SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"

SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# =============================================================================
# CORS CONFIGURATION
# =============================================================================
CORS_ALLOWED_ORIGINS = env.list(
    "CORS_ALLOWED_ORIGINS",
    default=[
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
)

CORS_ALLOW_CREDENTIALS = True

# Allow insecure transport for development
os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# =============================================================================
# CACHE CONFIGURATION
# =============================================================================
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-mobile-dev-cache",
        "TIMEOUT": 300,
    }
}

# =============================================================================
# LOGGING CONFIGURATION
# =============================================================================
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {"format": "{levelname} {asctime} {module} {message}", "style": "{"},
    },
    "handlers": {
        "console": {"level": "DEBUG", "class": "logging.StreamHandler", "formatter": "verbose"},
    },
    "root": {"handlers": ["console"], "level": "DEBUG"},
    "django": {"handlers": ["console"], "level": "DEBUG", "propagate": False},
}

# =============================================================================
# API KEYS
# =============================================================================
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default=MAPBOX_ACCESS_TOKEN)
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default=METEOBLUE_TOKEN)
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default=WAQI_API_TOKEN)

# =============================================================================
# PWA DEV CONFIGURATION
# =============================================================================
PWA_APP_START_URL = "/"
PWA_APP_SCOPE = "/"
PWA_APP_DEBUG = True

print("✅ NCOP Mobile App Development Mode")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print(f"   Static URL: {STATIC_URL}")
print("   Auto-login: Disabled")