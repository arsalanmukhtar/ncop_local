"""
Production Settings for NCOP Project (prod-arsalan)
Runs on Ubuntu VM with Waitress + WhiteNoise + Nginx.
"""
from .base import *
import os

DEBUG = False
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["172.18.7.36", "localhost", "127.0.0.1"])

# Vite – built bundles only
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": "/",  # keep URLs like /assets/*.js per manifest entries
    }
}

# Static segregation: do NOT include frontend/dist
STATICFILES_DIRS = []
legacy_static = BASE_DIR / "static" / "src"
if legacy_static.exists():
    STATICFILES_DIRS.append(legacy_static)

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"
# Redirect login_required to your existing login view
STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

WHITENOISE_AUTOREFRESH = False
WHITENOISE_USE_FINDERS = False

DATABASES = {
    "default": {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": env("POSTGRES_DB", default="ncop_prod"),
        "USER": env("POSTGRES_USER", default="postgres"),
        "PASSWORD": env("POSTGRES_PASSWORD", default="postgres"),
        "HOST": env("POSTGRES_HOST", default="localhost"),
        "PORT": env("POSTGRES_PORT", default="5432"),
    }
}

WSGI_APPLICATION = "ncop_project.wsgi_prod.application"

print("=" * 70)
print("✅ NCOP Production (prod-arsalan) Settings Loaded")
print(f"   Debug: {DEBUG}")
print(f"   Allowed Hosts: {ALLOWED_HOSTS}")
print(f"   Vite Dev Mode: {DJANGO_VITE['default']['dev_mode']}")
print(f"   Static URL: {STATIC_URL}")
print(f"   Static Root: {STATIC_ROOT}")
print(f"   Ready for Waitress + Nginx on Ubuntu VM")
print("=" * 70)