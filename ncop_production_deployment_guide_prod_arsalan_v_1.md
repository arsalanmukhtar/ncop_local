# NCOP Production Deployment Guide – prod-arsalan
**Version:** 1.0  
**Last Updated:** 12 Nov 2025  
**Maintained by:** AI Team  
**Environment:** prod-arsalan (Ubuntu VM)

---

## Table of Contents
1. Overview & Architecture  
2. Understanding the Three Environments  
3. Initial Setup: Creating `prod-arsalan`  
4. Asset Strategy (Vite vs Django static)  
5. Final Working Configuration (Authoritative)  
6. Deployment Workflow (Scripted & Manual)  
7. Troubleshooting Guide  
8. Quick Reference (Paths, Commands)  
9. Appendix A: Asset Pipeline (Vite → Django → Nginx)  
10. Appendix B: Stage vs Production Comparison  
11. Change Log / Known Issues

---

## 1) Overview & Architecture
**NCOP** is a full‑stack web platform comprising:
- **Backend:** Django  
- **Frontend:** React + Vite  
- **Database:** PostgreSQL + PostGIS  
- **App Server:** Waitress (WSGI)  
- **Web Server / Reverse Proxy:** Nginx (serves static/media, proxies app)

**Production goals:**
- Mirror staging (`stage-arsalan`)
- Serve **pre‑built** Vite assets (no dev server/HMR)
- Hardened, stable, cache‑efficient delivery via Nginx
- Clean separation of **Vite assets** and **Django static**

---

## 2) Understanding the Three Environments
### 2.1 `dev-arsalan` (Development – “Workshop”)
- Django development server  
- Vite dev server with HMR  
- Fast edits, no production guarantees

**Access:** `http://localhost:8000`

### 2.2 `stage-arsalan` (Staging – “Showroom”)
- Waitress  
- WhiteNoise  
- Pre‑built Vite bundles  
- Production‑like checks

**Access:** `http://172.18.7.36:9000`

### 2.3 `prod-arsalan` (Production – “Customer’s House”)
- Waitress (127.0.0.1:8000) + Nginx (port 80)  
- WhiteNoise for Django static management  
- Nginx serves Vite assets directly  
- Full security/caching

**Access:** `http://172.18.7.36`

---

## 3) Initial Setup: Creating `prod-arsalan`
```
ncop_local/
├── ncopenv311/                              # Python 3.11 venv
├── ncop_local_prod/                         # Production codebase
│   ├── frontend/                            # React/Vite
│   │   ├── src/
│   │   │   ├── entries/                     # Entry points (auth_login.js, dashboard_main.js, ...)
│   │   │   └── assets/                      # Images, icons, etc.
│   │   ├── dist/                            # Vite build output (created by npm run build)
│   │   │   └── assets/                      # Hashed CSS/JS
│   │   ├── vite.config.*
│   │   └── package.json
│   └── project/                             # Django backend
│       ├── manage.py
│       ├── ncop_project/
│       │   ├── settings/
│       │   │   ├── base.py
│       │   │   ├── dev.py
│       │   │   ├── staging.py
│       │   │   └── prod.py                  # ← focus here
│       │   ├── wsgi_prod.py                 # WSGI entry
│       │   └── urls.py
│       ├── templates/
│       ├── static/
│       │   └── dist/                        # collectstatic target
│       └── media/                           # user uploads
```

---

## 4) Asset Strategy (Vite vs Django static)
There are **two** distinct asset classes:

### A) Vite Assets (React build output)
- **Location:** `frontend/dist/assets/`
- **Examples:** `auth_login-y_ywPWRi.js`, `dashboard_main-DQjo4yzw.css`
- **Produced by:** `npm run build`
- **Served by Nginx:** via **`/assets/*`** (and legacy **`/static/assets/*`** for compatibility)

### B) Django Static Files (Admin, DRF, etc.)
- **Location:** `project/static/dist/`
- **Examples:** `admin/css/base.css`, `rest_framework/css/default.css`
- **Produced by:** `python manage.py collectstatic`
- **Served by Nginx:** via **`/static/*`** only

**Key principle:** *Never* mix Vite outputs into Django’s `STATICFILES_DIRS`. Keep delivery segregated. This prevents path duplication such as `/static/assets/assets/...`.

---

## 5) Final Working Configuration (Authoritative)

### 5.1 Django `prod.py`
**File:** `project/ncop_project/settings/prod.py`

```python
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
```

**Notes:**
- `static_url_prefix` is `/` so manifest’s `assets/...` resolves to `/assets/...`.
- `STATICFILES_DIRS = []` ensures Django won’t touch Vite outputs.

---

### 5.2 Nginx vhost (production)
**File:** `/etc/nginx/sites-available/ncop-prod`  → symlink to `/etc/nginx/sites-enabled/ncop-prod`

```nginx
upstream waitress_app {
    server 127.0.0.1:8000 fail_timeout=0;
}

server {
    listen 80;
    server_name 172.18.7.36;

    access_log /var/log/nginx/ncop_access.log combined;
    error_log  /var/log/nginx/ncop_error.log warn;

    client_max_body_size 100M;

    # Vite (correct path)
    location /assets/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
        try_files $uri =404;
    }

    # Vite (legacy/back-compat path)
    location /static/assets/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
        try_files $uri =404;
    }

    # Django collectstatic
    location /static/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript image/svg+xml;
        try_files $uri =404;
    }

    # Media uploads
    location /media/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/project/media/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    # App proxy (Waitress)
    location / {
        proxy_pass http://waitress_app;

        proxy_set_header Host                $http_host;
        proxy_set_header X-Real-IP           $remote_addr;
        proxy_set_header X-Forwarded-For     $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto   $scheme;
        proxy_set_header X-Forwarded-Host    $server_name;
        proxy_set_header X-Forwarded-Port    $server_port;

        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
}
```

**Enable & reload:**
```bash
sudo rm -f /etc/nginx/sites-enabled/ncop-prod
sudo ln -s /etc/nginx/sites-available/ncop-prod /etc/nginx/sites-enabled/ncop-prod
sudo nginx -t && sudo systemctl reload nginx
```

---

### 5.3 Waitress service
**File:** `/etc/systemd/system/ncop-waitress.service`

```ini
[Unit]
Description=NCOP Production Waitress Service
After=network.target postgresql.service

[Service]
Type=simple
User=cladmin
Group=cladmin
WorkingDirectory=/home/cladmin/ncop_local/ncop_local_prod/project
Environment="PATH=/home/cladmin/ncop_local/ncopenv311/bin"

ExecStart=/home/cladmin/ncop_local/ncopenv311/bin/python -m waitress \
    --port=8000 \
    --host=127.0.0.1 \
    ncop_project.wsgi_prod:application

Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Apply:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable ncop-waitress.service
sudo systemctl restart ncop-waitress.service
```

---

### 5.4 File permissions (to avoid 403)
Grant minimal traversal + read so Nginx (`www-data`) can serve assets:
```bash
sudo chmod o+x /home/cladmin
sudo chmod o+x /home/cladmin/ncop_local
sudo chmod o+x /home/cladmin/ncop_local/ncop_local_prod

sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/media 2>/dev/null || true
```

---

## 6) Deployment Workflow
### 6.1 One‑shot deploy script
**File:** `/home/cladmin/deploy_prod.sh`
```bash
#!/bin/bash
set -e

echo "🚀 Starting deployment to prod-arsalan..."
cd /home/cladmin/ncop_local/ncop_local_prod
source /home/cladmin/ncop_local/ncopenv311/bin/activate

echo "📥 Pulling latest code..."
git pull origin prod-arsalan

echo "📦 Installing Python deps..."
pip install -r project/requirements.txt

echo "📦 Installing Node deps..."
cd frontend && npm install && cd ..

echo "🏗️  Building Vite assets..."
cd frontend
rm -rf dist/
npm run build
[ -d dist/assets ] || { echo "❌ Vite build failed"; exit 1; }
cd ..

echo "📋 collectstatic..."
cd project
rm -rf static/dist/
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod
[ -d static/dist/admin ] || { echo "❌ collectstatic failed"; exit 1; }
cd ..

echo "🔐 Fixing perms..."
sudo chmod o+x /home/cladmin
sudo chmod o+x /home/cladmin/ncop_local
sudo chmod o+x /home/cladmin/ncop_local/ncop_local_prod
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/media 2>/dev/null || true

echo "🔄 Restarting services..."
sudo systemctl stop ncop-waitress.service
sudo systemctl reload nginx
sudo systemctl start ncop-waitress.service
sleep 3

echo "📊 Verifying..."
systemctl is-active --quiet ncop-waitress.service && echo "   ✅ Waitress running" || (echo "   ❌ Waitress not running"; exit 1)
systemctl is-active --quiet nginx && echo "   ✅ Nginx running" || (echo "   ❌ Nginx not running"; exit 1)

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/login/ || echo "000")
echo "   Login (direct WSGI) → HTTP $HTTP_STATUS"

echo "🎉 Deployment complete: http://172.18.7.36"
```

```bash
chmod +x /home/cladmin/deploy_prod.sh
```

### 6.2 Manual steps (equivalent)
1) Activate venv & pull code  
2) Install Python/Node deps  
3) Build Vite  
4) `collectstatic`  
5) Fix perms  
6) Restart services  
7) Verify with `curl` and logs

---

## 7) Troubleshooting Guide
### 7.1 404 on Vite assets
**Checks**
```bash
ls -la /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/
sudo -u www-data test -r /home/.../frontend/dist/assets/<file>.js && echo OK || echo NO
sudo tail -50 /var/log/nginx/ncop_error.log
```
**Fixes**  
- Rebuild Vite  
- Correct Nginx `alias` path  
- Fix permissions (o+rX, directory o+x)

### 7.2 Double path `/static/assets/assets/`
**Cause**: Vite outputs mixed into Django static, or URL prefixing doubled.  
**Fix**:
- Ensure `STATICFILES_DIRS = []` in `prod.py`  
- Serve Vite only via Nginx `/assets/` (plus legacy `/static/assets/`)  
- Do **not** wrap Vite URLs in `{% static %}`

### 7.3 Manifest not found
**Check**
```bash
python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.conf import settings, os
p = settings.DJANGO_VITE['default']['manifest_path']
print('Manifest:', p, 'exists:', os.path.exists(p))
EOF
```
**Fix**: Correct path to `BASE_DIR.parent / 'frontend' / 'dist' / '.vite' / 'manifest.json'` and rebuild Vite.

### 7.4 Service won’t start
- `journalctl -u ncop-waitress.service -n 100 --no-pager`  
- Check port 8000 availability (`lsof -i :8000`)  
- Re‑install missing Python deps

### 7.5 Static not loading (Django admin)
- Ensure `collectstatic` ran to `project/static/dist/`  
- Verify Nginx `/static/` alias and permissions

### 7.6 Favicon 404 (minor)
Add a tiny placeholder:
```bash
: > /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/favicon.ico
```

---

## 8) Quick Reference
**Services**
```bash
sudo systemctl status ncop-waitress.service
sudo systemctl restart ncop-waitress.service
sudo journalctl -u ncop-waitress.service -f

sudo systemctl reload nginx
sudo nginx -t
sudo tail -f /var/log/nginx/ncop_error.log
sudo tail -f /var/log/nginx/ncop_access.log
```

**Paths**
- Codebase: `/home/cladmin/ncop_local/ncop_local_prod/`  
- Django settings: `project/ncop_project/settings/prod.py`  
- Vite source: `frontend/src/`  
- Vite build: `frontend/dist/assets/`  
- Django static (collected): `project/static/dist/`  
- Nginx vhost: `/etc/nginx/sites-available/ncop-prod`  
- Waitress service: `/etc/systemd/system/ncop-waitress.service`

**Testing**
```bash
curl -I http://127.0.0.1:8000/               # direct WSGI
curl -I http://172.18.7.36/                  # via Nginx
curl -I http://172.18.7.36/assets/<file>.js  # Vite
curl -I http://172.18.7.36/static/admin/css/base.css
```

---

## 9) Appendix A: Asset Pipeline (Vite → Django → Nginx)
1) Source: `frontend/src/entries/*.js`  
2) Build: `npm run build` → `frontend/dist/assets/*` + `.vite/manifest.json`  
3) Django template tags resolve entries via manifest to `/assets/...` URLs  
4) Nginx serves `/assets/*` from Vite build; `/static/*` from collectstatic

**Result:** Fast, immutable caching for Vite bundles, clean separation from Django static.

---

## 10) Appendix B: Stage vs Production
| Aspect | stage-arsalan | prod-arsalan |
|---|---|---|
| Port | 9000 | 80 (Nginx) / 8000 (Waitress internal) |
| Web Server | Waitress only | Nginx + Waitress |
| Static/Assets | WhiteNoise | Nginx aliases |
| Caching | Basic | Long‑lived immutable for assets |
| Use Case | Pre‑prod testing | Live traffic |

---

## 11) Change Log / Known Issues
**v1.0 (12 Nov 2025)**  
- Establish prod baseline with segregated assets.  
- Fix: legacy `/static/assets/*` 404 via Nginx alias.  
- Fix: permissions for Nginx traversal/read.  
- Fix: manifest path.  
- Remove duplicate/conflicting Nginx site configs.

**Known Items**
- Old templates referencing `/static/assets/*` are supported by Nginx, but should be updated to `/assets/*` or use `django-vite` tags for manifest‑hashed URLs.
- Enable HTTPS and HSTS in fronting reverse proxy when certs are available.

---

## 12) Quick Deployment Commands (stage-arsalan → prod-arsalan)
> **Purpose:** Minimal, copy‑pasteable commands to pull from `stage-arsalan`, rebuild the frontend, collect static, and control services on production.

### 12.1 Pull Latest Code from `stage-arsalan`
```bash
# Navigate to production directory
cd /home/cladmin/ncop_local/ncop_local_prod

# Activate virtual environment
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Pull latest code from stage-arsalan branch
# (optional) ensure you are on the branch you intend to deploy
# git checkout stage-arsalan

git fetch origin
git pull --ff-only origin stage-arsalan
```

### 12.2 Build Frontend Assets (Vite)
```bash
# Navigate to frontend directory
cd /home/cladmin/ncop_local/ncop_local_prod/frontend

# Clean old build (recommended)
rm -rf dist/

# (optional) install deps if package.json changed
npm install

# Build Vite assets
npm run build

# Verify build succeeded
ls -lh dist/assets/ | head -10
```

### 12.3 Collect Django Static Files
```bash
# Navigate to Django project directory
cd /home/cladmin/ncop_local/ncop_local_prod/project

# Remove old collected static (recommended)
rm -rf static/dist/

# Collect static files (admin, DRF, etc.)
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod

# Verify collection succeeded
ls -la static/dist/
```

### 12.4 Fix File Permissions (after build)
```bash
# Allow Nginx to read Vite assets
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist

# Allow Nginx to read Django static files
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
```

### 12.5 Service Control Commands
**Waitress (Django App Server)**
```bash
# Stop / Start / Restart / Status / Logs
sudo systemctl stop    ncop-waitress.service
sudo systemctl start   ncop-waitress.service
sudo systemctl restart ncop-waitress.service
sudo systemctl status  ncop-waitress.service
sudo journalctl -u ncop-waitress.service -f
```

**Nginx (Web Server)**
```bash
# Stop / Start / Restart / Reload / Status / Test Config
sudo systemctl stop    nginx
sudo systemctl start   nginx
sudo systemctl restart nginx
sudo systemctl reload  nginx
sudo systemctl status  nginx
sudo nginx -t
```

### 12.6 Complete Deployment Sequence (Copy‑Paste)
```bash
# 1) Navigate & activate
cd /home/cladmin/ncop_local/ncop_local_prod
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# 2) Pull latest from stage-arsalan
git fetch origin
git pull --ff-only origin stage-arsalan

# 3) Build frontend
cd frontend
rm -rf dist/
npm install
npm run build
cd ..

# 4) Collect static
cd project
rm -rf static/dist/
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod
cd ..

# 5) Fix permissions
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist

# 6) Restart services (reload Nginx; restart Waitress)
sudo systemctl reload nginx
sudo systemctl restart ncop-waitress.service

# 7) Verify
sleep 3
sudo systemctl status ncop-waitress.service
curl -I http://172.18.7.36/login/
```

### 12.7 Quick Verification Commands
```bash
# Check if services are running
sudo systemctl is-active ncop-waitress.service && echo "✅ Waitress running" || echo "❌ Waitress stopped"
sudo systemctl is-active nginx && echo "✅ Nginx running" || echo "❌ Nginx stopped"

# Test application via Nginx
curl -I http://172.18.7.36/

# Recent app errors
sudo journalctl -u ncop-waitress.service --since "5 minutes ago" | grep -i error || echo "✅ No errors"

# Test asset loading (Vite + Django admin)
curl -I http://172.18.7.36/assets/auth_login-y_ywPWRi.js
curl -I http://172.18.7.36/static/admin/css/base.css
```

### 12.8 Quick Troubleshooting
```bash
# Waitress won’t start → view logs
sudo journalctl -u ncop-waitress.service -n 50 --no-pager

# Nginx issues → test config + check error log
sudo nginx -t
sudo tail -50 /var/log/nginx/ncop_error.log

# Assets 403 → fix permissions
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist

# Assets 404 → rebuild
cd /home/cladmin/ncop_local/ncop_local_prod/frontend
npm run build

# Force restart order
sudo systemctl stop ncop-waitress.service
sudo systemctl stop nginx
sleep 2
sudo systemctl start nginx
sudo systemctl start ncop-waitress.service
```

### 12.9 Service Command Reference Card
| Action | Waitress | Nginx |
|---|---|---|
| Stop | `sudo systemctl stop ncop-waitress.service` | `sudo systemctl stop nginx` |
| Start | `sudo systemctl start ncop-waitress.service` | `sudo systemctl start nginx` |
| Restart | `sudo systemctl restart ncop-waitress.service` | `sudo systemctl restart nginx` |
| Reload Config | _N/A (restart instead)_ | `sudo systemctl reload nginx` |
| Status | `sudo systemctl status ncop-waitress.service` | `sudo systemctl status nginx` |
| Logs | `sudo journalctl -u ncop-waitress.service -f` | `sudo tail -f /var/log/nginx/ncop_error.log` |
| Test Config | _N/A_ | `sudo nginx -t` |

**Pro Tips**
```bash
# Only reload Nginx if config test passes
sudo nginx -t && sudo systemctl reload nginx || echo "Config test failed!"

# Restart app, then tail last 20 log lines
sudo systemctl restart ncop-waitress.service
sudo journalctl -u ncop-waitress.service -n 20 --no-pager

# Quick health check
curl -I http://172.18.7.36/ && echo "✅ App is responding"
```

---

## 13) Appendix: Security & SSL (Next Steps)
- Terminate HTTPS at Nginx with valid certificates (LetsEncrypt or internal CA).
- Enable `SECURE_*` flags in Django once HTTPS is active (HSTS, cookie security).
- Consider separate read‑only system user for build artifacts.

