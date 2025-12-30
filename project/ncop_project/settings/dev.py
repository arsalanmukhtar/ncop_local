"""
Development settings for NCOP Project
"""

from .base import *

DEBUG = True

# In dev you typically allow LAN so Vite can HMR over IP
ALLOWED_HOSTS = ALLOWED_HOSTS + env.list("EXTRA_ALLOWED_HOSTS", default=[])

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# IMPORTANT: do NOT replace the whole dict (keeps manifest_path/static_url_prefix from base)
DJANGO_VITE["default"]["dev_mode"] = True
DJANGO_VITE["default"]["dev_server_host"] = env("VITE_DEV_SERVER_HOST", default="localhost")
DJANGO_VITE["default"]["dev_server_port"] = env.int("VITE_DEV_SERVER_PORT", default=5173)

# ============================================================================
# PWA DEVELOPMENT CONFIGURATION
# ============================================================================
PWA_APP_DEBUG = True

# In dev keep localhost start (your existing logic)
PWA_APP_START_URL = "http://localhost:8000/"

PWA_APP_CACHE_STRATEGY = "NetworkFirst"
PWA_APP_CACHE_MAX_AGE = 300  # 5 minutes

# If you test over https locally, set CSRF_TRUSTED_ORIGINS in .env
# CSRF_TRUSTED_ORIGINS already exists in base.py via env
