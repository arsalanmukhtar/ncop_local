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
import sys
from pathlib import Path

import environ

# ---------------------------------------------------------------------------
# Paths & environment
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # .../project
REPO_ROOT = BASE_DIR.parent                               # .../ncop_local

# huggingface_hub/transformers default their model cache to the user's home
# directory on the SYSTEM drive (~/.cache/huggingface) — on this machine
# that's a nearly-full C: drive, which silently risks failed/degraded
# downloads for local ML models (see ncop_internal/translate.py's local
# Urdu translation model). Redirected here, at the very top of settings, so
# it's set before transformers/huggingface_hub is ever imported anywhere in
# the process — same drive/pattern as chat_engine.py's own project/cache/
# directory for its Chroma vector store.
os.environ.setdefault("HF_HOME", str(BASE_DIR / "cache" / "huggingface"))
# Even with a local cache, transformers' from_pretrained() calls out to
# huggingface.co on every load to check for file updates by default — on a
# restricted/slow network path that can hang for a long time (observed:
# /api/translate/ requests left pending indefinitely) before it ever gets
# to running the model. The model is only ever loaded from a cache
# populated by an explicit prior download here (see translate.py), never
# needs to change at runtime, so there's no reason to ever hit the network
# for it again — offline mode makes every load instant (or fails fast with
# a clear "not in cache" error, instead of hanging, if it's ever missing).
os.environ.setdefault("HF_HUB_OFFLINE", "1")

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

# PROJ / GDAL data directories.  MUST run before django.contrib.gis loads
# GDAL (which happens during app startup), otherwise proj_context caches a
# missing-proj.db state and every subsequent gdal.Warp(..., dstSRS="EPSG:*")
# silently fails.  A silent failure is the worst case here: gdal.Warp
# returns a Dataset whose pixels are all NoData; gdal.DEMProcessing then
# writes a technically-valid PNG that is 100% transparent.  Nginx serves
# it with HTTP 200; Mapbox loads it without a console error; the map
# stays empty.  This has been observed on both:
#   * Windows dev — where QGIS/OSGeo4W set a stale PROJ_LIB pointing at a
#     non-existent path that OSGeo's own `proj_context` respects blindly.
#   * Linux prod — where the pip GDAL wheel ships without any bundled
#     data/ dir, so PROJ_LIB is unset; system libproj is used unless a
#     packager installed it at an unusual location.
#
# Behaviour: pick the FIRST candidate path that both exists AND contains
# `proj.db` for PROJ_LIB (or a real GDAL data dir for GDAL_DATA), and set
# the env var to it.  If the currently-set env var already points at a
# valid path, respect it.  If nothing valid is found, leave the env vars
# alone and log a warning at startup — this is a hard operational error
# on prod that shouldn't fail silently.
def _pick_first_valid_dir(candidates, sentinel_file):
    """Return the first path in `candidates` that exists and contains
    `sentinel_file`; None otherwise."""
    for p in candidates:
        if p and os.path.isdir(p) and os.path.isfile(os.path.join(p, sentinel_file)):
            return p
    return None

def _bootstrap_gdal_paths():
    # Assemble the candidate list per var: current env value first
    # (respect operator override), then wheel bundle, then common Linux
    # system paths.  On Windows dev the wheel bundle wins; on Linux prod
    # the /usr/share/proj path typically wins.
    try:
        import osgeo as _osgeo_probe
        wheel_dir = os.path.dirname(_osgeo_probe.__file__)
    except Exception:
        wheel_dir = None

    proj_candidates = [
        os.environ.get("PROJ_LIB"),
        os.environ.get("PROJ_DATA"),  # PROJ >= 9 renamed the var; check both
        os.path.join(wheel_dir, "data", "proj") if wheel_dir else None,
        # Linux system installs (apt: libproj-dev / conda / homebrew).
        "/usr/share/proj",
        "/usr/local/share/proj",
        "/opt/homebrew/share/proj",
        # Conda envs relative to sys.prefix.
        os.path.join(sys.prefix, "share", "proj"),
        os.path.join(sys.prefix, "Library", "share", "proj"),
    ]
    picked = _pick_first_valid_dir(proj_candidates, "proj.db")
    if picked:
        os.environ["PROJ_LIB"]  = picked
        os.environ["PROJ_DATA"] = picked  # belt-and-braces for PROJ 9+
    else:
        print(
            "[ncop] WARNING: no valid PROJ_LIB found — GDAL raster warps to "
            "EPSG:3857 may silently produce empty rasters.  Set PROJ_LIB to "
            "a directory containing proj.db (typically /usr/share/proj on "
            "Linux) via the environment before starting the app."
        )

    gdal_candidates = [
        os.environ.get("GDAL_DATA"),
        os.path.join(wheel_dir, "data", "gdal") if wheel_dir else None,
        "/usr/share/gdal",
        "/usr/local/share/gdal",
        "/opt/homebrew/share/gdal",
        os.path.join(sys.prefix, "share", "gdal"),
        os.path.join(sys.prefix, "Library", "share", "gdal"),
    ]
    picked = _pick_first_valid_dir(gdal_candidates, "gdalvrt.xsd") or \
             _pick_first_valid_dir(gdal_candidates, "GDALLogoBW.svg")
    if picked:
        os.environ["GDAL_DATA"] = picked
    # GDAL_DATA is less critical for our warp+colorize pipeline; no warning.

_bootstrap_gdal_paths()

# ---------------------------------------------------------------------------
# Core Django
# ---------------------------------------------------------------------------
SECRET_KEY = env("DJANGO_SECRET_KEY", default="noob")
DEBUG = env.bool("DJANGO_DEBUG", default=True)
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", default=["127.0.0.1", "localhost", "172.18.0.19", "172.18.1.5"])

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
GROQ_API_KEY = env("GROQ_API_KEY", default="noob")
# Second Groq account's key — used ONLY as an automatic fallback when the
# primary key hits its daily token-per-day cap (see chat_engine.get_llm's
# `key_index` param). Empty/unset is fine: chat_engine treats that as "no
# fallback available" and simply surfaces the primary key's 429 as normal.
GROQ_API_KEY_FALLBACK = env("GROQ_API_KEY_FALLBACK", default="")

# ---------------------------------------------------------------------------
# Django REST Framework — first use is the NCOP Assistant chat endpoint
# (ncop_internal.chatbot); its throttle scope is rate-limited here rather
# than with custom throttle logic. Note: since this app has no shared cache
# backend configured anywhere (dev/staging/prod all fall back to Django's
# per-process, unshared LocMemCache — see settings/staging.py), this rate
# limit is enforced PER WORKER PROCESS, not globally across all Gunicorn/
# Waitress workers. Acceptable given how the rest of the app already runs,
# but worth knowing before assuming this caps total traffic site-wide.
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_THROTTLE_RATES": {
        "ncop_assistant_chat": "20/min",
        # Sent as several small SEQUENTIAL chunks per story now (see
        # story-dynamic-weather.js's TRANSLATE_CHUNK_SIZE — added to avoid
        # a real production 504, one oversized request timing out nginx),
        # not one single request — a full Dynamic Weather Report (150+
        # distinct captions) can be ~10 chunked requests in one translate
        # pass. This is a free, local, no-external-cost endpoint (no Groq
        # involved), so a generous rate here only bounds CPU contention on
        # the shared VM, not spend — 40/min comfortably covers even a
        # large story's full chunk sequence with headroom.
        "ncop_translate": "40/min",
    },
}

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
# PMD Monitor (Cloud-based Early Warning Supporting System — vendor-hosted
# NWP portal at a private IP).  Credentials for the authenticated proxy in
# ncop_internal.views (_mon_sess/_mon_get/_mon_get_bytes) that fetches WRFPRS
# precipitation forecast GeoTIFFs and colorizes them server-side into PNGs
# consumed by the temporal-slider integration for the "PMD Predictions"
# layer group.  Defaults are the credentials the vendor issued for the
# operational account; overrideable via environment variables so a rotated
# password never needs a code change.
# ---------------------------------------------------------------------------
PMD_MONITOR_URL  = env("PMD_MONITOR_URL",  default="https://115.186.56.181:12304")
PMD_MONITOR_USER = env("PMD_MONITOR_USER", default="PMD")
PMD_MONITOR_PASS = env("PMD_MONITOR_PASS", default="Ab123456")

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
