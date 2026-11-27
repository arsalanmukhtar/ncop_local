"""
Production settings — HTTPS, HSTS, manifest-backed static files.

Entry point: ``ncop_project.wsgi:application`` behind Waitress + Nginx
(confirmed against ``urls.py``'s own comment and the ``ncop-waitress.service``
systemd unit actually used in deployment — this docstring previously said
"Gunicorn", which was stale/incorrect).
"""

from .base import *  # noqa: F401,F403

# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------
DEBUG = False
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["your.production.host"])

# Django 5 requires these for cross-origin POSTs over HTTPS (e.g. when the
# app is served behind a reverse proxy with a different external hostname).
# Comma-separated full-origin list, e.g.
#   CSRF_TRUSTED_ORIGINS=https://ncop.ndma.gov.pk,https://www.ncop.ndma.gov.pk
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# ---------------------------------------------------------------------------
# Vite — always use the built manifest in production.
# ---------------------------------------------------------------------------
DJANGO_VITE["default"]["dev_mode"] = False

# ---------------------------------------------------------------------------
# Security hardening
# ---------------------------------------------------------------------------
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 31536000  # 1 year
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=True)
