from .base import *

DEBUG = True

# In dev you typically allow the LAN so Vite can HMR over IP
ALLOWED_HOSTS = ALLOWED_HOSTS + env.list("EXTRA_ALLOWED_HOSTS", default=[])

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# CRITICAL FIX: Complete DJANGO_VITE configuration for dev mode
# Include all necessary keys to prevent django-vite from using wrong defaults
DJANGO_VITE = {
    "default": {
        "dev_mode": True,
        "dev_server_host": env("VITE_DEV_SERVER_HOST", default="localhost"),
        "dev_server_port": env.int("VITE_DEV_SERVER_PORT", default=5173),
        # Manifest path (needed for fallback even in dev mode)
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        # Static URL prefix - should be "/" in dev mode to match Vite's base
        "static_url_prefix": "/",
    }
}

# If you run Vite on LAN IP, set these in .env and restart:
# VITE_DEV_SERVER_HOST=0.0.0.0
# VITE_DEV_SERVER_PORT=5173
# VITE_HMR_HOST=your.local.ip
# (django-vite will still talk to the host/IP you put in templates via HMR client)