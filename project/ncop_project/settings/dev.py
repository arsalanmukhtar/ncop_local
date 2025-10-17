from .base import *

DEBUG = True

# In dev you typically allow the LAN so Vite can HMR over IP
ALLOWED_HOSTS = ALLOWED_HOSTS + env.list("EXTRA_ALLOWED_HOSTS", default=[])

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# If you run Vite on LAN IP, set these in .env and restart:
# VITE_DEV_SERVER_HOST=0.0.0.0
# VITE_DEV_SERVER_PORT=5173
# (django-vite will still talk to the host/IP you put in templates via HMR client)
