"""
Staging settings for NCOP Project
Replica of dev-arsalan environment running on Waitress server (behind Nginx + Let's Encrypt)
"""

from .base import *
import os

# =============================================================================
# CORE DEBUG & SETTINGS
# =============================================================================
DEBUG = False

ALLOWED_HOSTS = env.list(
    "DJANGO_ALLOWED_HOSTS",
    default=[
        "127.0.0.1",
        "localhost",
        "robotswithfeelspy.ndma.gov.pk",
        ".ndma.gov.pk",
        # keep IPs only if you truly need them
        "172.18.7.39",
        "182.188.28.163",
    ],
)

# ✅ Recommended: build correct absolute URLs when behind reverse proxy
USE_X_FORWARDED_HOST = True

# ✅ IMPORTANT: Nginx must send X-Forwarded-Proto https
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# =============================================================================
# AUTO LOGIN (OBFUSCATED TOKEN)
# =============================================================================
# Enabled only if ALLOW_AUTO_LOGIN=true in env (you set it true)
ALLOW_AUTO_LOGIN = env.bool("ALLOW_AUTO_LOGIN", default=False)

# default user (you set it)
AUTO_LOGIN_DEFAULT_USER = env("AUTO_LOGIN_DEFAULT_USER", default="")

# signing secret for token (you set it)
AUTO_LOGIN_TOKEN_SECRET = env("AUTO_LOGIN_TOKEN_SECRET", default=SECRET_KEY)

# token max age seconds (you set it)
AUTO_LOGIN_TOKEN_MAX_AGE = env.int("AUTO_LOGIN_TOKEN_MAX_AGE", default=60)

# ✅ Read the SAME env names you already use:
#Auto Login user credentials
# username=mustafa
# hash=pbkdf2_sha256$...
AUTO_LOGIN_USERNAME = env("username", default="")  # do not rename; keep as-is
AUTO_LOGIN_PASSWORD_HASH = env("hash", default="")  # do not rename; keep as-is

# =============================================================================
# CSRF TRUSTED ORIGINS
# =============================================================================
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

_required_csrf = [
    "https://robotswithfeelspy.ndma.gov.pk",
    "https://*.ndma.gov.pk",
]
for origin in _required_csrf:
    if origin not in CSRF_TRUSTED_ORIGINS:
        CSRF_TRUSTED_ORIGINS.append(origin)

# =============================================================================
# VITE FRONTEND CONFIGURATION (STAGING: built assets)
# =============================================================================
DJANGO_VITE["default"]["dev_mode"] = False
DJANGO_VITE["default"]["manifest_path"] = BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json"
DJANGO_VITE["default"].pop("static_url_prefix", None)  # avoid /static/static edge cases

# =============================================================================
# WSGI
# =============================================================================
WSGI_APPLICATION = "ncop_project.wsgi_staging.application"

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
# SSL / COOKIE / REDIRECT SECURITY  (HTTPS via Nginx + Let's Encrypt)
# =============================================================================
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
SESSION_COOKIE_SECURE = env.bool("SESSION_COOKIE_SECURE", default=True)
CSRF_COOKIE_SECURE = env.bool("CSRF_COOKIE_SECURE", default=True)

SESSION_COOKIE_SAMESITE = env("SESSION_COOKIE_SAMESITE", default="Lax")
CSRF_COOKIE_SAMESITE = env("CSRF_COOKIE_SAMESITE", default="Lax")

SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=0)
SECURE_HSTS_INCLUDE_SUBDOMAINS = env.bool("SECURE_HSTS_INCLUDE_SUBDOMAINS", default=False)
SECURE_HSTS_PRELOAD = env.bool("SECURE_HSTS_PRELOAD", default=False)

# =============================================================================
# CORS CONFIGURATION
# =============================================================================
CORS_ALLOWED_ORIGINS = env.list(
    "CORS_ALLOWED_ORIGINS",
    default=[
        "https://robotswithfeelspy.ndma.gov.pk",
        # During transition only (remove later):
        "http://robotswithfeelspy.ndma.gov.pk",
        "http://127.0.0.1:4096",
        "http://localhost:4096",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://172.18.7.39:4096",
        "http://182.188.28.163:4096",
    ],
)

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# =============================================================================
# CACHE CONFIGURATION
# =============================================================================
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-staging-cache",
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
    "root": {"handlers": ["console"], "level": "INFO"},
    "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
}

# =============================================================================
# STATIC FILES & WHITENOISE
# =============================================================================
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

DJANGO_VITE["default"].pop("static_url_prefix", None)

# =============================================================================
# API KEYS
# =============================================================================
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default=MAPBOX_ACCESS_TOKEN)
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default=METEOBLUE_TOKEN)
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default=WAQI_API_TOKEN)

# =============================================================================
# PWA STAGING CONFIGURATION
# =============================================================================
PWA_APP_START_URL = "/"
PWA_APP_SCOPE = "/"
PWA_APP_DEBUG = True

print("✅ NCOP Staging initialized (Waitress behind Nginx/SSL)")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   CSRF Trusted: {CSRF_TRUSTED_ORIGINS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print("   PWA Enabled: True")
print(f"   PWA Start URL: {PWA_APP_START_URL}")
print("   Backend should be reached via: https://robotswithfeelspy.ndma.gov.pk")
