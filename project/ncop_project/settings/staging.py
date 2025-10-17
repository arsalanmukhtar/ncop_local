from .base import *

DEBUG = False

# Make sure to provide these via environment in your staging environment
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["your.staging.host"])

# django-vite should resolve built assets via manifest in staging
DJANGO_VITE["default"]["dev_mode"] = False

# Basic security hardening for staging
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 60
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_SSL_REDIRECT = env.bool("SECURE_SSL_REDIRECT", default=False)
