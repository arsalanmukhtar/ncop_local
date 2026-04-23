"""
Shared Django settings for ncop_project.

Environment-specific modules (dev.py, staging.py, prod.py) import from this
file via ``from .base import *`` and override as needed. Values are read from
the repo-root ``.env`` file via django-environ.

Any symbol declared here is importable as ``ncop_project.settings.base.<name>``.
Keep public symbol names stable — ``ncop_internal.views`` still imports
``MAPBOX_ACCESS_TOKEN``, ``METEOBLUE_TOKEN``, ``WAQI_API_TOKEN`` and
``STORY_JSON_DIR`` from this module.
"""

import os
from pathlib import Path

import environ

# ---------------------------------------------------------------------------
# Paths & environment
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../project
REPO_ROOT = BASE_DIR.parent                               # .../ncop_local

env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(os.path.join(REPO_ROOT, ".env"))

# ---------------------------------------------------------------------------
# GeoDjango native libraries
#
# The hardcoded Windows paths match the working dev machine; they are only
# bound to the Django setting when the file actually exists so that Linux
# staging/prod (where the path does not exist) fall back to Django's own
# library discovery instead of a dangling invalid path.
# ---------------------------------------------------------------------------
_gdal_candidate = r"C:\Program Files\QGIS 3.24.3\bin\gdal304.dll"
_geos_candidate = r"C:\Program Files\QGIS 3.24.3\bin\geos_c.dll"
if os.path.isfile(_gdal_candidate):
    GDAL_LIBRARY_PATH = _gdal_candidate
if os.path.isfile(_geos_candidate):
    GEOS_LIBRARY_PATH = _geos_candidate

# ---------------------------------------------------------------------------
# Core Django
# ---------------------------------------------------------------------------
SECRET_KEY = env("DJANGO_SECRET_KEY", default="noob")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["127.0.0.1", "localhost", "172.18.0.5"])

ROOT_URLCONF = "ncop_project.urls"
WSGI_APPLICATION = "ncop_project.wsgi.application"
ASGI_APPLICATION = "ncop_project.asgi.application"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ---------------------------------------------------------------------------
# Third-party API credentials (consumed by ncop_internal.views)
# ---------------------------------------------------------------------------
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="noob")
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default="noob")
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default="noob")
GEE_PROJECT_ID = env("GEE_PROJECT_ID", default="flood-mapping-dashboard-471116")

# ---------------------------------------------------------------------------
# Applications
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.gis",
    "rest_framework",
    "corsheaders",
    "django_vite",
    "ncop_internal",
    "django_extensions",
]

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

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [
            BASE_DIR / "templates",
            REPO_ROOT / "frontend" / "templates",
        ],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ---------------------------------------------------------------------------
# Database (PostGIS)
# ---------------------------------------------------------------------------
DATABASES = {
    "default": {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": env("POSTGRES_DB", default="ncop"),
        "USER": env("POSTGRES_USER", default="ncop"),
        "PASSWORD": env("POSTGRES_PASSWORD", default="ncop"),
        "HOST": env("POSTGRES_HOST", default="localhost"),
        "PORT": env("POSTGRES_PORT", default="5432"),
    }
}

# ---------------------------------------------------------------------------
# Internationalization
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Karachi"
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# Static & media
# ---------------------------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"

# Only include source directories that actually exist to avoid collectstatic
# warnings on fresh checkouts before the first Vite build.
STATICFILES_DIRS = [
    p for p in (
        BASE_DIR / "static" / "src",
        REPO_ROOT / "frontend" / "dist",
    ) if p.exists()
]

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
CORS_ALLOW_ALL_ORIGINS = env.bool("CORS_ALLOW_ALL_ORIGINS", default=True)

# ---------------------------------------------------------------------------
# Django-Vite
# ---------------------------------------------------------------------------
DJANGO_VITE = {
    "default": {
        "dev_mode": env.bool("VITE_DEV_MODE", default=DEBUG),
        "manifest_path": REPO_ROOT / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": STATIC_URL,
        "dev_server_host": env("VITE_DEV_SERVER_HOST", default="localhost"),
        "dev_server_port": env.int("VITE_DEV_SERVER_PORT", default=5173),
    }
}

# ---------------------------------------------------------------------------
# Story content
# ---------------------------------------------------------------------------
STORY_JSON_DIR = Path(
    env("STORY_JSON_DIR", default=REPO_ROOT / "frontend" / "src" / "assets" / "story_jasons")
)
