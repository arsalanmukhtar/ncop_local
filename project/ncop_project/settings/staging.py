from .base import *
import socket

DEBUG = False

# Get local machine IP for staging (Waitress will serve on this)
def get_local_ip():
    """Get the local machine IP address"""
    try:
        # Connect to external service to determine local IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

LOCAL_IP = get_local_ip()

# Allowed hosts: Local IP + localhost for staging with Waitress
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=[
    LOCAL_IP,           # e.g., "192.168.x.x"
    "127.0.0.1",        # localhost
    "localhost",        # localhost name
    f"{LOCAL_IP}:8080", # Waitress port
    "*.local",          # mDNS support
])

# django-vite should resolve built assets via manifest in staging
DJANGO_VITE["default"]["dev_mode"] = False

# Waitress-specific settings
WSGI_APPLICATION = "ncop_project.wsgi_staging.application"

# Database: Use staging database (or same as dev for testing)
DATABASES["default"]["NAME"] = env("POSTGRES_DB_STAGING", default="ncop_staging")
DATABASES["default"]["HOST"] = env("POSTGRES_HOST_STAGING", default="localhost")
DATABASES["default"]["USER"] = env("POSTGRES_USER_STAGING", default="ncop_user")
DATABASES["default"]["PASSWORD"] = env("POSTGRES_PASSWORD_STAGING", default="ncop_password")
DATABASES["default"]["PORT"] = env("POSTGRES_PORT_STAGING", default="5432")

# Security hardening for staging (relaxed for local IP testing)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# For local IP testing, disable SSL enforcement
if LOCAL_IP == "127.0.0.1" or LOCAL_IP.startswith("192.168") or LOCAL_IP.startswith("10."):
    SESSION_COOKIE_SECURE = False
    CSRF_COOKIE_SECURE = False
    SECURE_SSL_REDIRECT = False
    SECURE_HSTS_SECONDS = 0
else:
    # If using external IP with HTTPS
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=False)
    SECURE_HSTS_SECONDS = 60

SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# Logging for staging
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{levelname} {asctime} {module} {message}",
            "style": "{",
        },
        "simple": {
            "format": "{levelname} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "level": "DEBUG",
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
        "file": {
            "level": "INFO",
            "class": "logging.FileHandler",
            "filename": BASE_DIR.parent / "logs" / "staging.log",
            "formatter": "verbose",
        },
    },
    "root": {
        "handlers": ["console", "file"],
        "level": "INFO",
    },
    "django": {
        "handlers": ["console", "file"],
        "level": "INFO",
        "propagate": False,
    },
}

# Email backend for staging (console output for testing)
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"

# Cache for staging (local memory)
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-staging-cache",
        "TIMEOUT": 300,
    }
}

# Vite build manifest (for built frontend)
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        # "verify_ssl": env.bool("DJANGO_VITE_VERIFY_SSL", default=False),
    }
}

# Media files
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

# Static files
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"

# Whitenoise for serving static files with Waitress
MIDDLEWARE = [
    "whitenoise.middleware.WhiteNoiseMiddleware",  # Add this for Waitress
] + MIDDLEWARE

# WhiteNoise configuration
WHITENOISE_AUTOREFRESH = True
WHITENOISE_USE_FINDERS = True

# CORS for staging (allow local network)
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[
    f"http://{LOCAL_IP}:8080",
    f"http://{LOCAL_IP}:3000",
    f"http://{LOCAL_IP}:5173",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://localhost:8080",
    "http://localhost:3000",
    "http://localhost:5173",
])

# Allow insecure transport for local IP (HTTP)
if LOCAL_IP.startswith("192.168") or LOCAL_IP.startswith("10.") or LOCAL_IP == "127.0.0.1":
    os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# Disable Django security warnings for staging with local IP
ALLOWED_REDIRECT_HOSTS = ALLOWED_HOSTS

# API Keys (use environment variables)
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="")
METEOBLUE_API_KEY = env("METEOBLUE_API_KEY", default="")
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default="")

print(f"✅ NCOP Staging initialized")
print(f"   Local IP: {LOCAL_IP}")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")