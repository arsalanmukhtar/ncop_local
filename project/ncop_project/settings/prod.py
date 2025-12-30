"""
Production settings for NCOP Project
Configured for production deployment with Cloudflare
"""

from .base import *

DEBUG = False

# Production hosts - use your real domain(s)
ALLOWED_HOSTS = env.list(
    "DJANGO_ALLOWED_HOSTS",
    default=[
        "your.production.host",
        "ncop.yourdomain.com",
    ]
)

# Build bundles only
DJANGO_VITE["default"]["dev_mode"] = False

# ============================================================================
# SECURITY HARDENING (prod only)
# ============================================================================
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True
USE_X_FORWARDED_PORT = True

SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True

SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True

SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_BROWSER_XSS_FILTER = True
X_FRAME_OPTIONS = "SAMEORIGIN"

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_HTTPONLY = True
CSRF_COOKIE_SAMESITE = "Lax"

# IMPORTANT: CSRF trusted origins for your REAL domain (HTTPS)
# Set in .env:
# CSRF_TRUSTED_ORIGINS=https://ncop.yourdomain.com
if not CSRF_TRUSTED_ORIGINS:
    CSRF_TRUSTED_ORIGINS = ["https://ncop.yourdomain.com"]

# ============================================================================
# PWA PRODUCTION CONFIGURATION
# ============================================================================
PWA_APP_START_URL = env("PWA_APP_START_URL", default="https://ncop.yourdomain.com/")
PWA_APP_SCOPE = "/"
PWA_APP_DEBUG = False
PWA_APP_FORCE_HTTPS = True

PWA_APP_CACHE_STRATEGY = "CacheFirst"
PWA_APP_CACHE_MAX_AGE = 604800  # 7 days

# ============================================================================
# CORS (prod)
# ============================================================================
CORS_ALLOWED_ORIGINS = env.list(
    "CORS_ALLOWED_ORIGINS",
    default=[
        "https://ncop.yourdomain.com",
    ]
)

print(f"✅ NCOP Production initialized")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   PWA Start URL: {PWA_APP_START_URL}")
print(f"   HTTPS Enforced: {SECURE_SSL_REDIRECT}")
