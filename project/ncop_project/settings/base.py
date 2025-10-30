import os, sys
from pathlib import Path
import environ

GDAL_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\gdal307.dll'
GEOS_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\geos_c.dll'

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../project
env = environ.Env(DEBUG=(bool, False))
environ.Env.read_env(os.path.join(BASE_DIR.parent, ".env"))  # repo/.env

# --- Core ---
MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="noob")
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default="noob")
SECRET_KEY = env("DJANGO_SECRET_KEY", default="noob")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["127.0.0.1", "localhost"])

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
]

ROOT_URLCONF = "ncop_project.urls"

# --- Templates ---
# You have templates under: project/templates AND frontend/templates (from earlier steps)
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

# Only include dirs that actually exist (avoid warnings before first build)
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
        "static_url_prefix": STATIC_URL,
        "dev_server_host": env("VITE_DEV_SERVER_HOST", default="localhost"),
        "dev_server_port": env.int("VITE_DEV_SERVER_PORT", default=5173),
    }
}
