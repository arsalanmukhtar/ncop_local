"""
Development settings — inherits from base and toggles dev-only overrides.

Used by ``manage.py runserver --settings=ncop_project.settings.dev`` and the
default ``manage.py`` DJANGO_SETTINGS_MODULE.
"""

from .base import *  # noqa: F401,F403

DEBUG = True

# Extend base ALLOWED_HOSTS so the LAN IP used by Vite HMR can be added via env.
ALLOWED_HOSTS = ALLOWED_HOSTS + env.list("EXTRA_ALLOWED_HOSTS", default=[])

# Email to stdout so password-reset tokens are visible during development.
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.local"

# Vite HMR in dev: force dev_mode on and serve assets from "/" (Vite's own base)
# rather than the production "/static/" prefix.
DJANGO_VITE["default"]["dev_mode"] = True
DJANGO_VITE["default"]["static_url_prefix"] = "/"
