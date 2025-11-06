"""
Staging settings for NCOP Project
Replica of dev-arsalan environment running on Waitress server
"""

from .base import *
import os

# ===== CORE DEBUG & SETTINGS =====
DEBUG = False
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["127.0.0.1", "localhost"])

# ===== VITE FRONTEND CONFIGURATION =====
# Keep dev_mode=True for HMR to work while running `npm run dev`
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": "/",  # Changed from STATIC_URL to just "/"
    }
}
# ===== WSGI APPLICATION =====
WSGI_APPLICATION = "ncop_project.wsgi_staging.application"

# ===== DATABASE CONFIGURATION =====
# Use same database as dev
DATABASES["default"]["ENGINE"] = env(
    "POSTGRES_ENGINE", 
    default="django.contrib.gis.db.backends.postgis"
)
DATABASES["default"]["NAME"] = env("POSTGRES_DB", default="ncop")
DATABASES["default"]["HOST"] = env("POSTGRES_HOST", default="localhost")
DATABASES["default"]["USER"] = env("POSTGRES_USER", default="postgres")
DATABASES["default"]["PASSWORD"] = env("POSTGRES_PASSWORD", default="postgres")
DATABASES["default"]["PORT"] = env("POSTGRES_PORT", default="5432")

# ===== EMAIL CONFIGURATION =====
# Console output for testing (same as dev)
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# ===== SECURITY CONFIGURATION =====
# Relaxed for localhost staging
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# ===== CORS CONFIGURATION =====
# Allow localhost on multiple ports
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[
    "http://127.0.0.1:8080",  # Waitress
    "http://127.0.0.1:5173",  # Vite dev server
    "http://localhost:8080",   # Waitress (hostname)
    "http://localhost:5173",   # Vite dev server (hostname)
])

# Allow insecure transport for localhost (HTTP)
os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# ===== CACHE CONFIGURATION =====
# Local memory cache for staging
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-staging-cache",
        "TIMEOUT": 300,
    }
}

# ===== LOGGING CONFIGURATION =====
# Simple console logging
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{levelname} {asctime} {module} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "level": "DEBUG",
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
    },
    "root": {
        "handlers": ["console"],
        "level": "INFO",
    },
    "django": {
        "handlers": ["console"],
        "level": "INFO",
        "propagate": False,
    },
}

# ===== STATIC FILES & WHITENOISE =====
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# ===== API KEYS =====
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="")
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default="")
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default="")

# ===== STARTUP MESSAGE =====
print(f"✅ NCOP Staging initialized (dev-arsalan replica on Waitress)")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print(f"   Ready to run with Waitress on port 8080")