"""
Mobile App Production Settings
With obfuscated token authentication for mobile clients
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
        "172.18.7.39",
        "182.188.28.163",
    ],
)

USE_X_FORWARDED_HOST = True
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# =============================================================================
# MOBILE APP TOKEN AUTHENTICATION
# =============================================================================
MOBILE_APP_TOKEN_PARAM = env("MOBILE_APP_TOKEN_PARAM", default="p")
MOBILE_APP_TOKEN_VALUE = env("MOBILE_APP_TOKEN_VALUE", default="tyhntynbtggbhjyuvnujvnyuvjtyujtuijvtynb")

# =============================================================================
# AUTO LOGIN (OBFUSCATED TOKEN)
# =============================================================================
ALLOW_AUTO_LOGIN = env.bool("ALLOW_AUTO_LOGIN", default=True)
AUTO_LOGIN_DEFAULT_USER = env("AUTO_LOGIN_DEFAULT_USER", default="mustafa")
AUTO_LOGIN_TOKEN_SECRET = env("AUTO_LOGIN_TOKEN_SECRET", default=SECRET_KEY)
AUTO_LOGIN_TOKEN_MAX_AGE = env.int("AUTO_LOGIN_TOKEN_MAX_AGE", default=172800)
AUTO_LOGIN_USERNAME = env("username", default="mustafa")
AUTO_LOGIN_PASSWORD_HASH = env("hash", default="pbkdf2_sha256$870000$HWoKiudR32NzOtF3hzaqG6$2UyPpFoFFLzSMLf4xA6jICynibCSSEJceb/o1RWKp3A=")

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
# VITE FRONTEND CONFIGURATION (PRODUCTION: built assets)
# =============================================================================
DJANGO_VITE["default"]["dev_mode"] = False
DJANGO_VITE["default"]["manifest_path"] = BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json"
DJANGO_VITE["default"].pop("static_url_prefix", None)

# =============================================================================
# WSGI
# =============================================================================
WSGI_APPLICATION = "ncop_project.wsgi_mobile_prod.application"

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
# SSL / COOKIE / REDIRECT SECURITY (HTTPS via Nginx + Let's Encrypt)
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
    default=["https://robotswithfeelspy.ndma.gov.pk"],
)

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# =============================================================================
# CACHE CONFIGURATION
# =============================================================================
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-mobile-prod-cache",
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
        "console": {"level": "INFO", "class": "logging.StreamHandler", "formatter": "verbose"},
        "file": {
            "level": "ERROR",
            "class": "logging.FileHandler",
            "filename": BASE_DIR / "logs" / "mobile_prod_errors.log",
            "formatter": "verbose",
        },
    },
    "root": {"handlers": ["console", "file"], "level": "INFO"},
    "django": {"handlers": ["console", "file"], "level": "INFO", "propagate": False},
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
# PWA PRODUCTION CONFIGURATION
# =============================================================================
PWA_APP_START_URL = "/"
PWA_APP_SCOPE = "/"
PWA_APP_DEBUG = False

print("✅ NCOP Mobile Production initialized (Waitress behind Nginx/SSL)")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   CSRF Trusted: {CSRF_TRUSTED_ORIGINS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print(f"   Mobile Token Param: {MOBILE_APP_TOKEN_PARAM}")
print("   Auto-login: Enabled")
print("   Backend URL: https://robotswithfeelspy.ndma.gov.pk")