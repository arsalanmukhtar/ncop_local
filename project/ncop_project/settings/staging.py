"""
Staging settings — replica of dev behavior served by Waitress on port 8080.

Entry point: ``ncop_project.wsgi_staging:application``.
"""

import os

from .base import *  # noqa: F401,F403

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
DEBUG = False
WSGI_APPLICATION = "ncop_project.wsgi_staging.application"

# ---------------------------------------------------------------------------
# Vite — use built manifest, keep the "/" prefix used by the dev bundles.
# ---------------------------------------------------------------------------
DJANGO_VITE["default"]["dev_mode"] = False
DJANGO_VITE["default"]["static_url_prefix"] = "/"

# ---------------------------------------------------------------------------
# Database — staging defaults to a local postgres role, overridable via env.
# Engine is env-driven so a staging box without PostGIS can fall back to plain
# postgresql without editing settings.
# ---------------------------------------------------------------------------
DATABASES["default"]["ENGINE"] = env(
    "POSTGRES_ENGINE",
    default="django.contrib.gis.db.backends.postgis",
)
DATABASES["default"]["USER"] = env("POSTGRES_USER", default="postgres")
DATABASES["default"]["PASSWORD"] = env("POSTGRES_PASSWORD", default="postgres")

# ---------------------------------------------------------------------------
# Email — console output so password-reset links surface in the Waitress log.
# ---------------------------------------------------------------------------
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# ---------------------------------------------------------------------------
# Security — relaxed for a LAN/localhost staging deploy behind HTTP.
# ---------------------------------------------------------------------------
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# Allow Google OAuth flows over plain HTTP on the staging host.
os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# ---------------------------------------------------------------------------
# CORS — Waitress on 8080, Vite on 5173.
# ---------------------------------------------------------------------------
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[
    "http://127.0.0.1:8080",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://localhost:5173",
])

# ---------------------------------------------------------------------------
# Cache — in-process, fine for single-worker staging.
# ---------------------------------------------------------------------------
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-staging-cache",
        "TIMEOUT": 300,
    }
}

# ---------------------------------------------------------------------------
# Static files — no manifest lookup in staging so a missing file does not 500.
# ---------------------------------------------------------------------------
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# Startup banner — visible on `waitress-serve` spin-up.
# ---------------------------------------------------------------------------
print("[OK] NCOP Staging initialized (dev-arsalan replica on Waitress)")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print("   Ready to run with Waitress on port 8080")
