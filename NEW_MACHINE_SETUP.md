# NCOP — New Machine / VM Setup Guide

Step-by-step instructions to get this application running on a **new
machine or VM**, exactly as it runs on the current dev box — covering
all three branches (`dev-arsalan`, `stage-arsalan`, `prod-arsalan`),
every required piece of software, every environment variable, and a
detailed fix for the GDAL DLL-loading error this app is known to hit on
a fresh Windows machine.

Read this top to bottom on a first-time setup. Section 6 ("Fixing the
GDAL DLL error") is the one most people land on directly after hitting
`ImportError: DLL load failed while importing _gdal`.

---

## 1. What this app needs, at a glance

| Component | Version used on the working machine | Why |
|---|---|---|
| Python | 3.11 (venv folder is literally named `ncopenv311`) | Django backend; GDAL wheel is pinned to `cp311` |
| Node.js | 18+ (any current LTS) | Vite 5 / rolldown-vite 7 frontend build |
| PostgreSQL + PostGIS | any recent PostGIS-enabled Postgres | `django.contrib.gis.db.backends.postgis` |
| GDAL (Python bindings) | 3.4.3, **self-contained wheel** | Raster warping/colorizing throughout `ncop_internal` |
| Git | any recent version | Branch-based dev → stage → prod pipeline |
| A Google Earth Engine–enabled GCP project | — | `ee.Initialize()` runs at Django import time; nothing GEE-dependent works without this |

Everything else (WhiteboxTools binary, the local Urdu translation
model, the Chroma vector DB for the assistant) downloads/builds itself
on first use — see §9.

---

## 2. Clone and branch layout

```bash
git clone <repo-url> ncop_local
cd ncop_local
git branch -a
```

Three long-lived branches, each mapped to one deployment target:

| Branch | Settings module | Server | Port |
|---|---|---|---|
| `dev-arsalan` | `ncop_project.settings.dev` | Django dev server (`runserver`) | 8000 |
| `stage-arsalan` | `ncop_project.settings.staging` | Waitress (`wsgi_staging:application`) | 8080 |
| `prod-arsalan` | `ncop_project.settings.prod` | Waitress behind Nginx (`ncop-waitress.service`) | 8000 (proxied) |

All three inherit from `project/ncop_project/settings/base.py` via
`from .base import *` — nothing in `dev.py`/`staging.py`/`prod.py`
duplicates a setting, only overrides it. If something is missing in
one environment, check `base.py` first.

Pick the branch you're deploying and check it out before continuing:

```bash
git checkout dev-arsalan      # or stage-arsalan / prod-arsalan
```

---

## 3. Python environment

```bash
cd ncop_local
python -m venv ncopenv311
# Windows
ncopenv311\Scripts\activate
# Linux/macOS
source ncopenv311/bin/activate

python -V   # must print 3.11.x
```

**Do NOT run `pip install -r requirements.txt` yet** — the GDAL line
in that file is a machine-specific local wheel path and will fail on a
new machine. Fix GDAL first (§6), then come back and run:

```bash
pip install -r requirements.txt
```

`requirements.txt` also has one manual step called out in its own
comments: **install PyTorch explicitly before the rest**, or a plain
`pip install -r requirements.txt` may resolve the much larger default
CUDA wheel instead of the CPU-only one this app actually needs (the
local Urdu translation model runs CPU-only):

```bash
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.13.0
pip install -r requirements.txt
```

---

## 4. Frontend environment

```bash
cd frontend
npm install
```

For local dev, leave it running:

```bash
npm run dev        # Vite dev server, port 5173
```

For staging/prod, build once (re-run after every pull):

```bash
npm run build       # writes frontend/dist + frontend/dist/.vite/manifest.json
```

---

## 5. Database (PostgreSQL + PostGIS)

1. Install PostgreSQL with the PostGIS extension available.
2. Create a database and role matching whatever you'll put in `.env`
   (see §7):

   ```sql
   CREATE DATABASE ncop;
   CREATE USER ncop WITH PASSWORD 'ncop';
   GRANT ALL PRIVILEGES ON DATABASE ncop TO ncop;
   \c ncop
   CREATE EXTENSION postgis;
   ```

3. `dev`/`prod` use `django.contrib.gis.db.backends.postgis` (PostGIS
   required). `staging` reads its engine from `POSTGRES_ENGINE` in
   `.env` and defaults to plain `django.db.backends.postgresql` if you
   don't have PostGIS on that box — but PostGIS is what the rest of
   this app assumes, so install it if at all possible.

4. Once `.env` is filled in and the venv is active:

   ```bash
   cd project
   python manage.py migrate --settings=ncop_project.settings.dev
   python manage.py createsuperuser --settings=ncop_project.settings.dev
   ```

---

## 6. Fixing the GDAL DLL error (the main event)

### What actually goes wrong

`requirements.txt` pins GDAL via a **local file path**, not a package
index:

```
GDAL @ file:///D:/muhammad_arsalan/ncop_v1/ncop_local/misc/GDAL-3.4.3-cp311-cp311-win_amd64.whl#...
```

That path is specific to the original dev machine's own `D:` drive
layout. On any other machine it either doesn't resolve at all (`pip`
fails outright), or — if you happen to copy the same `misc/` folder
across — it installs a wheel that was **built to be paired with an
external GDAL runtime** (originally `C:\Program Files\QGIS
3.24.3\bin`), not a self-contained one. Result: `from osgeo import
gdal` fails **on its own**, outside Django entirely, with:

```
ImportError: DLL load failed while importing _gdal
```

Root cause, in order:

1. `site-packages\osgeo\` only ships `gdal304.dll` and `geos_c.dll` —
   a working GDAL 3.4 needs roughly 40 more dependency DLLs (proj,
   sqlite3, curl, tiff, geotiff, jpeg, expat, openjpeg, hdf5, netcdf,
   …), which this incomplete wheel never bundled.
2. `base.py` currently hardcodes a check for
   `C:\Program Files\QGIS 3.24.3\bin\gdal304.dll` as the GDAL runtime
   to point Django at. On a machine without that exact QGIS install,
   that path doesn't exist, `GDAL_LIBRARY_PATH` never gets set, and
   Django falls back to `ctypes.util.find_library("gdal304")` — which
   finds the incomplete `site-packages\osgeo\gdal304.dll` and then
   fails loading *its* missing dependencies.
3. There is no OSGeo4W install anywhere on the machine either (no
   `C:\OSGeo4W`, no other `gdal*.dll` on `C:` or `D:`) to fall back to.

`pyproj`, `shapely`, and `geopandas` all work fine on a fresh machine
because each of *those* wheels bundles its own copy of PROJ/GEOS. GDAL
is the one package whose pinned wheel is incomplete.

### The fix — install a self-contained GDAL wheel (recommended)

Modern Windows GDAL wheels (Christoph Gohlke's `geospatial-wheels`
builds) bundle **every** dependency DLL inside the `osgeo/` package
folder itself, so no separate system install is needed at all.

```bash
# with the venv active
pip uninstall -y GDAL
```

Download a wheel matching your Python version (`cp311`) and OS
(`win_amd64`) from:

**https://github.com/cgohlke/geospatial-wheels/releases**

e.g. `gdal-3.9.3-cp311-cp311-win_amd64.whl` (any recent 3.x GDAL
release works — this app's own code doesn't depend on the exact 3.4.3
build, that pin was only ever an artifact of the original wheel).

```bash
pip install "C:\path\to\gdal-3.9.3-cp311-cp311-win_amd64.whl"
python -c "from osgeo import gdal; print(gdal.__version__)"
```

That last command **must print a version number** with no traceback
before you go any further. If it does, `runserver`/Waitress will start
cleanly — `base.py`'s hardcoded QGIS path check simply won't match
(harmless, since `os.path.isfile()` guards it) and GDAL will load via
Python's normal import mechanism instead, using the wheel's own
bundled DLLs.

Then update `requirements.txt` on your own branch/fork to stop
pointing at a machine-specific local path — replace the `GDAL @
file:///...` line with the plain package name and whatever version you
installed, e.g.:

```
GDAL==3.9.3
```

(and note in a comment, same as the original, that it's *this specific
self-contained wheel* the app was validated against — a bare `pip
install GDAL==3.9.3` from PyPI without the `--find-links`/wheel-index
Gohlke provides may not resolve to the self-contained build on every
system; the safest repeatable path is still downloading the `.whl`
directly from the releases page above and `pip install`-ing it by
path, one time per machine).

### Alternative — use OSGeo4W instead

If you'd rather rely on a system-wide GDAL install instead of a
self-contained wheel:

1. Run the OSGeo4W network installer and let it install to the
   **default** location, `C:\OSGeo4W` (not a custom path) — install
   the `gdal` package from the "Desktop" or "Advanced" install path.
2. Keep the pip-installed `GDAL` Python version roughly matching the
   OSGeo4W GDAL version, **or** `pip uninstall GDAL` entirely and rely
   purely on OSGeo4W's own bundled Python bindings (only works if
   you're running the exact Python OSGeo4W ships, which is usually not
   the same interpreter as your venv — this is why the self-contained
   wheel above is the recommended path, not this one).
3. `base.py` needs updating either way — see the next subsection.

### Recommended follow-up: make `base.py`'s own GDAL detection portable

The hardcoded `C:\Program Files\QGIS 3.24.3\bin\gdal304.dll` check in
`base.py` (around line 57) is itself a source of this whole class of
problem — it only ever matches the *original* dev machine. Once GDAL
is working via the self-contained wheel above, this hardcoded path is
harmless (it's just skipped), but for a setup that's meant to be
reproduced machine-to-machine going forward, replace it with logic
that derives the GDAL/GEOS DLL location from **whatever `osgeo` wheel
is actually installed**, e.g.:

```python
import os
import glob

def _bootstrap_gdal_dll_path():
    if os.name != "nt":
        return  # Linux/macOS wheels don't need this — see the existing PROJ/GDAL_DATA logic below
    try:
        import osgeo
        osgeo_dir = os.path.dirname(osgeo.__file__)
    except ImportError:
        return
    # A self-contained wheel bundles its own DLLs directly in osgeo/ —
    # register that directory so Windows' DLL loader can resolve them.
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(osgeo_dir)
    gdal_dlls = glob.glob(os.path.join(osgeo_dir, "gdal*.dll"))
    geos_dlls = glob.glob(os.path.join(osgeo_dir, "geos_c*.dll"))
    if gdal_dlls:
        globals()["GDAL_LIBRARY_PATH"] = gdal_dlls[0]
    if geos_dlls:
        globals()["GEOS_LIBRARY_PATH"] = geos_dlls[0]

_bootstrap_gdal_dll_path()

# Keep the QGIS/OSGeo4W hardcoded checks AFTER this as a fallback for
# anyone still relying on a system install instead of the wheel.
_gdal_candidate = r"C:\Program Files\QGIS 3.24.3\bin\gdal304.dll"
_geos_candidate = r"C:\Program Files\QGIS 3.24.3\bin\geos_c.dll"
if os.path.isfile(_gdal_candidate):
    GDAL_LIBRARY_PATH = _gdal_candidate
if os.path.isfile(_geos_candidate):
    GEOS_LIBRARY_PATH = _geos_candidate
```

This makes any future "replicate to a new VM" pass self-fixing for
GDAL specifically, as long as a self-contained wheel is installed —
no more per-machine path hunting. (Not applied automatically by this
guide — apply it as a real, tested code change and commit it on the
branch you're deploying, don't just paste it in blind.)

---

## 7. Environment variables — `.env`

Create `project/../.env` (repo root — same folder as this file) by
copying `.env.example`:

```bash
cp .env.example .env
```

Then fill in every value. Full variable reference, cross-checked
against every `env(...)`/`env.bool(...)`/`env.list(...)` call actually
made across `base.py`, `dev.py`, `staging.py`, and `prod.py` (some of
these aren't in `.env.example` yet but are still read, with a
fallback default baked into `base.py` if you omit them):

| Variable | Used by | Notes |
|---|---|---|
| `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_HOST` / `POSTGRES_PORT` | all envs | Matches §5's DB setup |
| `POSTGRES_ENGINE` | staging only | Defaults to PostGIS backend; override to plain `django.db.backends.postgresql` if that box has no PostGIS |
| `DJANGO_SECRET_KEY` | all envs | **Set a real, random value in staging/prod** — the base default (`"noob"`) is a placeholder only, `manage.py check --deploy` will flag it |
| `DJANGO_DEBUG` | all envs | `True` for dev, `False` for staging/prod |
| `DJANGO_ALLOWED_HOSTS` | all envs | Comma-separated; prod has **no safe default** (`your.production.host` placeholder) — must be set |
| `EXTRA_ALLOWED_HOSTS` | dev only | Extra hosts appended on top of the base list (e.g. a LAN IP for testing on another device) |
| `CSRF_TRUSTED_ORIGINS` | prod only | Comma-separated **full origins** (`https://host`), required for cross-origin POSTs behind a reverse proxy |
| `MAPBOX_ACCESS_TOKEN` | all envs | Real Mapbox token — the map won't render without one |
| `METEOBLUE_TOKEN` | all envs | Weather layer |
| `WAQI_API_TOKEN` | all envs | Air-quality layer |
| `GEE_PROJECT_ID` | all envs | A real Google Cloud project with Earth Engine enabled — see §8, this is NOT optional, most of the flood/GIS backend imports `ee` at module load time |
| `GROQ_API_KEY` | all envs | NCOP Assistant chatbot |
| `GROQ_API_KEY_FALLBACK` | all envs | Optional — used only when the primary key hits its daily cap |
| `VITE_DEV_MODE` / `VITE_DEV_SERVER_HOST` / `VITE_DEV_SERVER_PORT` / `VITE_HMR_HOST` | dev/staging | Only matters if running Vite's own dev server; irrelevant once you've done `npm run build` |
| `CORS_ALLOW_ALL_ORIGINS` | all envs | Defaults `True` in base — tighten for prod if needed |
| `CORS_ALLOWED_ORIGINS` | staging only | Explicit origin allow-list |
| `SECURE_SSL_REDIRECT` | prod only | Defaults `True` — set `False` only if TLS terminates somewhere Django can't see the scheme correctly |
| `PMD_MONITOR_URL` / `PMD_MONITOR_USER` / `PMD_MONITOR_PASS` | all envs | Has a working default baked into `base.py` already — override only if the vendor rotates credentials |
| `STORY_JSON_DIR` | all envs | Defaults to the repo's own `frontend/src/assets/story_jasons` — only override if you relocate story content |

`.env.staging` (repo root) already has a filled-in reference example
for the staging environment specifically — copy values from it as a
starting point for that branch rather than typing everything by hand,
but don't commit real secrets to a NEW copy of that file.

---

## 8. Google Earth Engine authentication (separate from `.env`)

`ee.Initialize(project=GEE_PROJECT_ID)` runs **at Django module import
time** (`ncop_internal/views.py`) — before any request is served, and
on every autoreload. If this fails, you'll see:

```
[FAILED] GEE Initialization Failed: <error>
```

printed at startup (not a crash — the app keeps running with GEE-backed
features degraded), matching the "no unhandled crash, no emoji in this
one print block" convention already in that function.

GEE credentials are **not** read from `.env` — the `earthengine-api`
Python package uses its own default credential discovery. Two ways to
authenticate, pick one:

**Option A — interactive OAuth (simplest for a dev/staging box):**

```bash
earthengine authenticate
```

Follow the browser prompt once; it stores a token under the machine's
own user profile (`%APPDATA%\earthengine\credentials` on Windows,
`~/.config/earthengine/credentials` on Linux). Needs to be re-run once
per machine/user account, not per deploy.

**Option B — service account (recommended for a headless
staging/prod VM):**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

(or the Windows equivalent, `setx GOOGLE_APPLICATION_CREDENTIALS ...`)
— the service account needs Earth Engine access granted on the SAME
`GEE_PROJECT_ID` you put in `.env`.

Either way, confirm it worked by just starting the app and watching
for the `[OK] Google Earth Engine Initialized Successfully` banner
before assuming anything GIS-related will work.

---

## 9. First-run, one-time downloads (no action needed, just be aware)

These happen automatically on first real use, not at install time —
don't be surprised by extra time/network activity the very first time
each feature is exercised:

- **WhiteboxTools** (`whitebox` package) — auto-downloads the
  platform-correct compiled binary the first time any flood-modeling
  HAND pipeline call runs. Verify this actually succeeds on a fresh
  VM; it needs outbound network access.
- **Local Urdu translation model** (`facebook/nllb-200-distilled-600M`,
  ~2.4GB) — downloads once on first use of the story-mode Urdu
  narration feature, cached under `project/cache/huggingface` (see
  `HF_HOME` in `base.py`). After that first download,
  `HF_HUB_OFFLINE=1` is set automatically so it never touches the
  network again.
- **NCOP Assistant knowledge base** (Chroma) — not automatic; you need
  to run this once per fresh checkout (and again any time the docs/
  layer catalog change):

  ```bash
  cd project
  python manage.py ingest_chat_knowledge --settings=ncop_project.settings.dev
  ```

---

## 10. Running each environment

### Development (`dev-arsalan`, localhost:8000)

```bash
git checkout dev-arsalan
ncopenv311\Scripts\activate          # or source .../activate on Linux/macOS

cd project
python manage.py migrate --settings=ncop_project.settings.dev
python manage.py runserver --settings=ncop_project.settings.dev
```

In a second terminal:

```bash
cd frontend
npm run dev
```

### Staging (`stage-arsalan`, localhost:8080, Waitress)

```bash
git checkout stage-arsalan
git pull origin dev-arsalan --no-commit --no-ff   # bring dev's changes in

cd frontend
npm run build

cd ../project
python manage.py collectstatic --noinput --settings=ncop_project.settings.staging
python -m waitress --port=8080 --host=127.0.0.1 ncop_project.wsgi_staging:application
```

### Production (`prod-arsalan`, behind Nginx)

```bash
git checkout prod-arsalan
git pull origin stage-arsalan --no-commit --no-ff

cd frontend
npm run build

cd ../project
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod
```

Then, on Linux, allow Nginx to actually read the built assets (a real,
previously-hit permission gotcha, not hypothetical):

```bash
sudo chmod -R o+rX /path/to/ncop_local/frontend/dist
sudo chmod -R o+rX /path/to/ncop_local/project/static/dist
sudo systemctl restart ncop-waitress.service
sudo systemctl status ncop-waitress.service
sudo journalctl -u ncop-waitress.service -f
```

---

## 11. Verification checklist

Run through this in order on the new machine — each step should
succeed before moving to the next:

1. `python -c "from osgeo import gdal; print(gdal.__version__)"` — no
   traceback, prints a version.
2. `python manage.py check --settings=ncop_project.settings.dev` — no
   `SystemCheckError`; security warnings about `SECRET_KEY`/HSTS/HTTPS
   are expected under `dev` settings and are not GDAL-related.
3. Start the server — console shows `[OK] Google Earth Engine
   Initialized Successfully` (not `[FAILED]`).
4. `npx vite build` inside `frontend/` — completes with `✓ built in
   ...s` and no errors (pre-existing warnings about `lottie-web`'s own
   `eval()` usage and chunk-size are expected and unrelated).
5. Open the dashboard in a browser — the map itself renders (confirms
   `MAPBOX_ACCESS_TOKEN` is real and valid).
6. Toggle any GEE-backed layer (e.g. anything under "GIS Layers" that
   renders via `DynamicGEELayerView`) — confirms Earth Engine auth
   (§8) actually works end-to-end, not just at import time.
7. Open the NCOP Assistant panel and ask it a question — confirms
   `GROQ_API_KEY` is real and the knowledge base was ingested (§9).

If every step above passes, the new machine matches the working one.
