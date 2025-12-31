import os, sys
from pathlib import Path
import environ

# GDAL_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\gdal307.dll'
# GEOS_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\geos_c.dll'

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../project
env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(os.path.join(BASE_DIR.parent, ".env"))  # repo/.env

# --- Core ---
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="noob")
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default="noob")
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default="noob")
SECRET_KEY = env("DJANGO_SECRET_KEY", default="noob")
DEBUG = env.bool("DJANGO_DEBUG", default=True)

# NOTE: Keep as you had it (core logic)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["127.0.0.1", "localhost"])

# --- Google Earth Engine ---
GEE_PROJECT_ID = env("GEE_PROJECT_ID", default="flood-mapping-dashboard-471116")

# --- Apps ---
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
    "pwa",  # PWA support
    "ncop_internal",
    "django_extensions",
]

# --- Middleware ---
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
    "ncop_internal.middleware.MobileAppTokenMiddleware",  # Add this line
]

ROOT_URLCONF = "ncop_project.urls"

# --- Templates ---
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [
            BASE_DIR / "templates",
            BASE_DIR.parent / "frontend" / "templates",
        ],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ]
        },
    },
]

WSGI_APPLICATION = "ncop_project.wsgi.application"
ASGI_APPLICATION = "ncop_project.asgi.application"

# --- Database (PostGIS) ---
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

# --- I18N ---
LANGUAGE_CODE = "en-us"
TIME_ZONE = "Asia/Karachi"
USE_I18N = True
USE_TZ = True

# --- Static/Media ---
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"

STATICFILES_DIRS = []
legacy_static = BASE_DIR / "static" / "src"
vite_dist = BASE_DIR.parent / "frontend" / "dist"
for p in (legacy_static, vite_dist):
    if p.exists():
        STATICFILES_DIRS.append(p)

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

# --- CORS ---
CORS_ALLOW_ALL_ORIGINS = env.bool("CORS_ALLOW_ALL_ORIGINS", default=True)

# --- Django-Vite ---
DJANGO_VITE = {
    "default": {
        "dev_mode": env.bool("VITE_DEV_MODE", default=DEBUG),
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "dev_server_host": env("VITE_DEV_SERVER_HOST", default="localhost"),
        "dev_server_port": env.int("VITE_DEV_SERVER_PORT", default=5173),
    }
}

# Prefer ENV override; otherwise use repo-relative path (same pattern as other paths)
STORY_JSON_DIR = Path(
    env("STORY_JSON_DIR", default=BASE_DIR.parent / "frontend" / "src" / "assets" / "story_jasons")
)

# ============================================================================
# PWA CONFIGURATION
# ============================================================================
PWA_APP_NAME = env("PWA_APP_NAME", default="NCOP Dashboard")
PWA_APP_SHORT_NAME = env("PWA_APP_SHORT_NAME", default="NCOP")
PWA_APP_DESCRIPTION = env(
    "PWA_APP_DESCRIPTION",
    default="National Climate and Operational Platform - Real-time disaster monitoring and climate analytics"
)
PWA_APP_THEME_COLOR = env("PWA_APP_THEME_COLOR", default="#0066CC")
PWA_APP_BACKGROUND_COLOR = env("PWA_APP_BACKGROUND_COLOR", default="#FFFFFF")
PWA_APP_DISPLAY = env("PWA_APP_DISPLAY", default="standalone")
PWA_APP_SCOPE = env("PWA_APP_SCOPE", default="/")
PWA_APP_ORIENTATION = env("PWA_APP_ORIENTATION", default="any")
PWA_APP_START_URL = env("PWA_APP_START_URL", default="/")
PWA_APP_STATUS_BAR_COLOR = env("PWA_APP_STATUS_BAR_COLOR", default="default")
PWA_APP_DIR = env("PWA_APP_DIR", default="ltr")
PWA_APP_LANG = env("PWA_APP_LANG", default="en-US")

PWA_APP_ICONS = [
    {"src": "/static/pwa/icons/icon-72x72.png", "sizes": "72x72", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-96x96.png", "sizes": "96x96", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-128x128.png", "sizes": "128x128", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-144x144.png", "sizes": "144x144", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-152x152.png", "sizes": "152x152", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-384x384.png", "sizes": "384x384", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
    {"src": "/static/pwa/icons/icon-maskable-192x192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
    {"src": "/static/pwa/icons/icon-maskable-512x512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
]

PWA_APP_SPLASH_SCREEN = [
    {"src": "/static/pwa/splash/splash-640x1136.png",
     "media": "(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)"},
    {"src": "/static/pwa/splash/splash-750x1334.png",
     "media": "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)"},
    {"src": "/static/pwa/splash/splash-1242x2208.png",
     "media": "(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3)"},
    {"src": "/static/pwa/splash/splash-1125x2436.png",
     "media": "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)"},
    {"src": "/static/pwa/splash/splash-1536x2048.png",
     "media": "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2)"},
    {"src": "/static/pwa/splash/splash-1668x2224.png",
     "media": "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2)"},
    {"src": "/static/pwa/splash/splash-2048x2732.png",
     "media": "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2)"},
]

PWA_SERVICE_WORKER_PATH = os.path.join(BASE_DIR.parent, "frontend", "dist", "serviceworker.js")
PWA_APP_CACHE_STRATEGY = env("PWA_APP_CACHE_STRATEGY", default="NetworkFirst")
PWA_APP_CACHE_NAME = env("PWA_APP_CACHE_NAME", default="ncop-cache-v1")
PWA_APP_CACHE_MAX_AGE = env.int("PWA_APP_CACHE_MAX_AGE", default=86400)  # 24 hours

# ============================================================================
# IMPORTANT: CSRF TRUSTED ORIGINS (safe default empty; set in env-specific files)
# ============================================================================
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])
