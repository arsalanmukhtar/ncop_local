# NCOP Production Deployment Handbook
## Complete Guide for Stage to Production Deployment

**Version:** 2.0  
**Last Updated:** November 12, 2025  
**Prepared by:** GCOP Tech Team  
**Organization:** National Disaster Management Authority (NDMA), Pakistan

---

## 📋 Table of Contents

### Part I: Introduction & Overview
- [1.1 About This Handbook](#11-about-this-handbook)
- [1.2 What is NCOP?](#12-what-is-ncop)
- [1.3 Understanding the Architecture](#13-understanding-the-architecture)
- [1.4 Quick Deployment Summary](#14-quick-deployment-summary)

### Part II: Environment Setup
- [2.1 Understanding the Three Environments](#21-understanding-the-three-environments)
- [2.2 Project Structure](#22-project-structure)
- [2.3 Ubuntu Production Environment Setup](#23-ubuntu-production-environment-setup)
- [2.4 System Requirements](#24-system-requirements)

### Part III: Development to Staging (Stage-Arsalan)
- [3.1 Stage Branch Process](#31-stage-branch-process)
- [3.2 Setting Up Staging Environment](#32-setting-up-staging-environment)
- [3.3 Staging Deployment Workflow](#33-staging-deployment-workflow)

### Part IV: Production Deployment (Prod-Arsalan)
- [4.1 Production Environment Overview](#41-production-environment-overview)
- [4.2 Initial Production Setup](#42-initial-production-setup)
- [4.3 Django Configuration](#43-django-configuration)
- [4.4 Nginx Configuration](#44-nginx-configuration)
- [4.5 Waitress Service Configuration](#45-waitress-service-configuration)

### Part V: Asset Management & Build Process
- [5.1 Understanding Vite Assets](#51-understanding-vite-assets)
- [5.2 Django Static Files](#52-django-static-files)
- [5.3 The Asset Pipeline](#53-the-asset-pipeline)
- [5.4 Frontend Build Process](#54-frontend-build-process)

### Part VI: Deployment Workflow
- [6.1 Complete Deployment Steps](#61-complete-deployment-steps)
- [6.2 Automated Deployment Script](#62-automated-deployment-script)
- [6.3 Manual Deployment Process](#63-manual-deployment-process)
- [6.4 Post-Deployment Verification](#64-post-deployment-verification)

### Part VII: Troubleshooting Guide
- [7.1 Common Issues & Solutions](#71-common-issues--solutions)
- [7.2 The Double Path Problem](#72-the-double-path-problem)
- [7.3 File Permission Issues](#73-file-permission-issues)
- [7.4 Manifest Path Errors](#74-manifest-path-errors)
- [7.5 Service Startup Problems](#75-service-startup-problems)
- [7.6 Static File Loading Errors](#76-static-file-loading-errors)
- [7.7 Debugging Commands](#77-debugging-commands)

### Part VIII: Reference & Appendices
- [8.1 Service Management Commands](#81-service-management-commands)
- [8.2 Quick Deployment Commands](#82-quick-deployment-commands)
- [8.3 Configuration Files Reference](#83-configuration-files-reference)
- [8.4 File Locations & Paths](#84-file-locations--paths)
- [8.5 Python Dependencies](#85-python-dependencies)
- [8.6 JavaScript Module Documentation](#86-javascript-module-documentation)

---

## Part I: Introduction & Overview

### 1.1 About This Handbook

This handbook is your complete guide to deploying the NCOP (National Climate & Observation Platform) application from staging to production. It's written in simple, clear language so that anyone can follow along, whether you're a seasoned developer or just getting started.

**Who Should Use This Handbook:**
- DevOps engineers managing deployments
- System administrators setting up servers
- Developers working on NCOP
- Team leads coordinating releases
- Anyone involved in the NCOP deployment process

**What You'll Learn:**
- How to set up production environments from scratch
- How to deploy updates safely and efficiently
- How to troubleshoot common deployment issues
- How to maintain and monitor production systems

### 1.2 What is NCOP?

NCOP (National Climate & Observation Platform) is a full-stack web application developed by NDMA to provide real-time climate and disaster monitoring capabilities.

**Technology Stack:**
- **Backend**: Django 5.1 (Python web framework)
- **Frontend**: React with Vite (modern JavaScript)
- **Database**: PostgreSQL 14 with PostGIS (geospatial extension)
- **Web Server**: Nginx 1.18 (production reverse proxy)
- **App Server**: Waitress 2.1 (WSGI application server)
- **Static Files**: WhiteNoise 6.7 (efficient static file serving)

**Key Features:**
- Interactive dashboard with real-time data visualization
- Geospatial mapping with multiple layer support
- Temporal data analysis with time-slider controls
- User authentication and authorization
- RESTful API for data access
- Responsive design for desktop and mobile

### 1.3 Understanding the Architecture

Think of the NCOP system as a restaurant:

```
┌─────────────────────────────────────────────────────┐
│                    BROWSER                          │
│              (The Customer)                         │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                   NGINX (Port 80)                   │
│              (The Host/Greeter)                     │
│  - Routes traffic to the right place                │
│  - Serves files directly when possible              │
└────────────┬────────────────────┬────────────────────┘
             │                    │
             ↓                    ↓
   ┌─────────────────┐   ┌──────────────────┐
   │  VITE ASSETS    │   │  DJANGO STATIC   │
   │  /assets/*      │   │  /static/*       │
   │ (Your React App)│   │ (Admin, Forms)   │
   └─────────────────┘   └──────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│             WAITRESS (Port 8000)                    │
│              (The Kitchen)                          │
│  - Runs Django application                          │
│  - Processes requests                               │
│  - Generates HTML                                   │
└────────────────────┬────────────────────────────────┘
                     │
                     ↓
┌─────────────────────────────────────────────────────┐
│                POSTGRESQL                           │
│              (The Storage)                          │
│  - Stores all application data                      │
│  - Handles spatial queries                          │
└─────────────────────────────────────────────────────┘
```

**Data Flow:**
1. User visits http://172.18.7.36 in browser
2. Nginx receives the request
3. Nginx checks: Is this a static file? 
   - Yes → Serve directly from disk
   - No → Forward to Waitress/Django
4. Django generates HTML page
5. Browser loads HTML and requests assets
6. Nginx serves `/assets/*` and `/static/*` files
7. Browser renders the interactive dashboard

### 1.4 Quick Deployment Summary

**For experienced users who just need a quick reminder:**

```bash
# Navigate to production
cd /home/cladmin/ncop_local/ncop_local_prod
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Pull, build, collect, deploy
git pull origin stage-arsalan
cd frontend && npm run build && cd ..
cd project && python manage.py collectstatic --noinput --settings=ncop_project.settings.prod && cd ..
sudo chmod -R o+rX frontend/dist project/static/dist
sudo systemctl restart ncop-waitress.service && sudo systemctl reload nginx

# Verify
curl -I http://172.18.7.36/login/
```

**Detailed step-by-step instructions are in [Part VI](#part-vi-deployment-workflow).**

---

## Part II: Environment Setup

### 2.1 Understanding the Three Environments

NCOP uses three separate environments, each serving a specific purpose:

#### **dev-arsalan** (Development Environment)
- **Location**: Developer's local machine
- **IP/Port**: http://localhost:8000
- **Purpose**: Active development and testing
- **Server**: Django development server
- **Hot Reloading**: Yes (instant updates)
- **Database**: Local PostgreSQL
- **Branch**: `dev-arsalan`

**Think of it as:** Your workshop where you build and test new features

**Characteristics:**
- `DEBUG = True` (detailed error messages)
- Vite dev server with Hot Module Reloading
- Changes appear instantly without rebuilding
- Not secure for public access
- Fast iteration and debugging

#### **stage-arsalan** (Staging Environment)
- **Location**: Production server
- **IP/Port**: http://172.18.7.36:9000
- **Purpose**: Pre-production testing
- **Server**: Waitress WSGI server
- **Hot Reloading**: No (uses built assets)
- **Database**: Shared production PostgreSQL
- **Branch**: `stage-arsalan`

**Think of it as:** Your showroom where you demonstrate finished work

**Characteristics:**
- `DEBUG = False` (production-like settings)
- Pre-built Vite assets (no live server)
- Same configuration as production
- Safe environment for final testing
- Accessible only within office network

#### **prod-arsalan** (Production Environment)
- **Location**: Production server
- **IP/Port**: http://172.18.7.36
- **Purpose**: Live system for end users
- **Server**: Waitress + Nginx
- **Hot Reloading**: No (uses built assets)
- **Database**: Production PostgreSQL
- **Branch**: `prod-arsalan`

**Think of it as:** The final product delivered to users

**Characteristics:**
- `DEBUG = False` (no error details exposed)
- Full security hardening enabled
- Nginx reverse proxy for performance
- Monitored and logged extensively
- Accessible to authorized users

### 2.2 Project Structure

```
ncop_local/
├── ncopenv311/                           # Python virtual environment
│   ├── bin/
│   ├── lib/
│   └── ...
│
├── ncop_local_prod/                      # Production codebase
│   │
│   ├── frontend/                         # React/Vite frontend
│   │   ├── src/
│   │   │   ├── entries/                  # Entry points for pages
│   │   │   │   ├── auth_login.js         # Login page
│   │   │   │   ├── auth_signup.js        # Signup page
│   │   │   │   ├── dashboard_main.js     # Dashboard
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── modules/                  # JavaScript modules
│   │   │   │   ├── map-layers.js         # Map layer management
│   │   │   │   ├── time-slider-functionality.js
│   │   │   │   ├── temporal-layer-legends.js
│   │   │   │   ├── layer-attribute-popup.js
│   │   │   │   ├── layer-info-panel.js
│   │   │   │   ├── sidebar-menu.js
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── styles/                   # CSS stylesheets
│   │   │   │   ├── dashboard.css
│   │   │   │   └── ...
│   │   │   │
│   │   │   └── assets/                   # Images, icons
│   │   │       ├── images/
│   │   │       │   ├── accordion_icons/
│   │   │       │   ├── layer_legends/
│   │   │       │   └── bg_images/
│   │   │       └── ...
│   │   │
│   │   ├── dist/                         # Built assets (created by npm run build)
│   │   │   ├── assets/                   # Hashed JS/CSS/images
│   │   │   │   ├── auth_login-y_ywPWRi.js
│   │   │   │   ├── dashboard_main-DQjo4yzw.css
│   │   │   │   └── ...
│   │   │   │
│   │   │   ├── .vite/
│   │   │   │   └── manifest.json         # Asset manifest
│   │   │   │
│   │   │   └── index.html
│   │   │
│   │   ├── templates/                    # HTML templates
│   │   ├── vite.config.js                # Vite configuration
│   │   ├── package.json                  # Node dependencies
│   │   └── package-lock.json
│   │
│   └── project/                          # Django backend
│       ├── manage.py                     # Django management command
│       │
│       ├── ncop_project/                 # Main project folder
│       │   ├── settings/                 # Settings modules
│       │   │   ├── __init__.py
│       │   │   ├── base.py               # Shared settings
│       │   │   ├── dev.py                # Development
│       │   │   ├── staging.py            # Staging
│       │   │   └── prod.py               # Production ← KEY FILE
│       │   │
│       │   ├── wsgi_prod.py              # WSGI entry point
│       │   ├── asgi.py
│       │   ├── urls.py
│       │   └── ...
│       │
│       ├── ncop_internal/                # Django app
│       │   ├── models.py
│       │   ├── views.py
│       │   ├── urls.py
│       │   └── ...
│       │
│       ├── templates/                    # Django templates
│       │   ├── dashboard.html
│       │   ├── index.html
│       │   └── ...
│       │
│       ├── static/                       # Django static files
│       │   ├── src/                      # Source static files
│       │   └── dist/                     # Collected static (created by collectstatic)
│       │       ├── admin/                # Django admin assets
│       │       ├── rest_framework/       # DRF assets
│       │       ├── gis/                  # GIS widget assets
│       │       └── django_extensions/
│       │
│       └── media/                        # User uploads
│
└── .env                                  # Environment variables

```

**Key Directory Purposes:**

| Directory | Purpose | Served By |
|-----------|---------|-----------|
| `frontend/src/` | Source files for React app | Not directly accessible |
| `frontend/dist/assets/` | Built Vite assets | Nginx at `/assets/*` |
| `project/static/dist/` | Collected Django static | Nginx at `/static/*` |
| `project/templates/` | HTML templates | Django renders |
| `project/media/` | User uploads | Nginx at `/media/*` |

### 2.3 Ubuntu Production Environment Setup

The production server runs on Ubuntu 24.04 LTS at **172.18.7.36**.

#### Installing Python 3.11

Ubuntu comes with Python 3.10, but NCOP requires Python 3.11. We add it separately without replacing the system Python:

```bash
# Add Python 3.11 repository
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get update

# Install Python 3.11
sudo apt-get install -y python3.11 python3.11-venv python3.11-dev

# Verify installation
python3.11 --version
# Expected: Python 3.11.x
```

**Important**: We keep both Python 3.10 (system) and Python 3.11 (project). This prevents breaking Ubuntu's core functionality.

#### Installing GDAL (Geospatial Library)

GDAL is essential for map processing, satellite data, and spatial analysis:

```bash
# Add UbuntuGIS repository for latest GDAL
sudo add-apt-repository -y ppa:ubuntugis/ppa
sudo apt-get update

# Install GDAL and development tools
sudo apt-get install -y gdal-bin libgdal-dev build-essential pkg-config

# Verify installation
gdalinfo --version
# Expected: GDAL 3.8.x
```

#### Creating Python Virtual Environment

```bash
# Navigate to project directory
cd /home/cladmin/ncop_local

# Create virtual environment with Python 3.11
python3.11 -m venv ncopenv311

# Activate environment
source ncopenv311/bin/activate

# Your prompt should show: (ncopenv311) cladmin@controllayer:~$
```

#### Installing Python Dependencies

```bash
# Upgrade pip
pip install --upgrade pip setuptools wheel

# Set GDAL environment variables
export CPLUS_INCLUDE_PATH=/usr/include/gdal
export C_INCLUDE_PATH=/usr/include/gdal
export GDAL_CONFIG=/usr/bin/gdal-config

# Install GDAL Python bindings (must match system GDAL version)
pip install "GDAL==$(gdal-config --version)"

# Install project dependencies
pip install -r requirements.txt

# Verify GDAL works in Python
python -c "from osgeo import gdal; print('GDAL Version:', gdal.VersionInfo())"
```

#### Installing Node.js and npm

```bash
# Install Node Version Manager (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Load nvm
source ~/.bashrc

# Install Node.js 22
nvm install 22

# Verify installation
node -v    # Should show: v22.20.0
npm -v     # Should show: 10.9.3
```

#### Installing PostgreSQL with PostGIS

```bash
# Install PostgreSQL 14 and PostGIS
sudo apt-get install -y postgresql-14 postgresql-14-postgis-3

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Create production database
sudo -u postgres psql << EOF
CREATE DATABASE ncop_prod;
\c ncop_prod
CREATE EXTENSION postgis;
CREATE EXTENSION pg_trgm;
CREATE EXTENSION hstore;
\q
EOF
```

#### Installing and Configuring Nginx

```bash
# Install Nginx
sudo apt-get install -y nginx

# Start and enable Nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# Verify Nginx is running
sudo systemctl status nginx
```

### 2.4 System Requirements

**Minimum Requirements:**
- **OS**: Ubuntu 22.04 LTS or later
- **CPU**: 2 cores
- **RAM**: 4 GB
- **Disk**: 20 GB free space
- **Network**: Static IP or accessible hostname

**Recommended for Production:**
- **OS**: Ubuntu 24.04 LTS
- **CPU**: 4+ cores
- **RAM**: 8+ GB
- **Disk**: 50+ GB SSD
- **Network**: Static IP with DNS entry

**Current Production Server:**
- **Location**: 172.18.7.36
- **OS**: Ubuntu 24.04 LTS
- **Disk**: 48 GB (root filesystem)
- **User**: cladmin
- **Home**: /home/cladmin/ncop_local/

---

## Part III: Development to Staging (Stage-Arsalan)

### 3.1 Stage Branch Process

The staging environment (`stage-arsalan`) serves as the final testing ground before production deployment.

**Purpose of Staging:**
- Test code in production-like conditions
- Verify database migrations work correctly
- Ensure static assets build properly
- Validate API endpoints and integrations
- Perform user acceptance testing (UAT)

**Staging Workflow:**

```
dev-arsalan (Development)
       ↓
   [Testing & Review]
       ↓
stage-arsalan (Staging)
       ↓
   [Final Validation]
       ↓
prod-arsalan (Production)
```

### 3.2 Setting Up Staging Environment

#### Creating Stage Branch

```bash
# From development branch
git checkout dev-arsalan
git pull origin dev-arsalan

# Create staging branch
git checkout -b stage-arsalan

# Push to remote
git push -u origin stage-arsalan
```

#### Staging Configuration (staging.py)

**Location**: `/home/cladmin/ncop_local/ncop_local_stage/project/ncop_project/settings/staging.py`

```python
"""
Staging Settings for NCOP Project (stage-arsalan)
"""

from .base import *

DEBUG = False
ALLOWED_HOSTS = ["172.18.7.36", "localhost", "127.0.0.1"]

# Vite uses built assets (no dev server)
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": "/",
    }
}

# Static files configuration
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "static" / "dist"

# WhiteNoise handles static files
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    # ... other middleware
]

STORAGES = {
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# Database
DATABASES = {
    "default": {
        "ENGINE": "django.contrib.gis.db.backends.postgis",
        "NAME": env("POSTGRES_DB", default="ncop_stage"),
        "USER": env("POSTGRES_USER", default="postgres"),
        "PASSWORD": env("POSTGRES_PASSWORD"),
        "HOST": env("POSTGRES_HOST", default="localhost"),
        "PORT": env("POSTGRES_PORT", default="5432"),
    }
}

# WSGI application
WSGI_APPLICATION = "ncop_project.wsgi_staging.application"
```

#### Waitress Service for Staging

**Location**: `/etc/systemd/system/ncop-stage-waitress.service`

```ini
[Unit]
Description=NCOP Staging Waitress Service
After=network.target postgresql.service

[Service]
Type=simple
User=cladmin
Group=cladmin
WorkingDirectory=/home/cladmin/ncop_local/ncop_local_stage/project
Environment="PATH=/home/cladmin/ncop_local/ncopenv311/bin"

ExecStart=/home/cladmin/ncop_local/ncopenv311/bin/python -m waitress \
    --port=9000 \
    --host=127.0.0.1 \
    ncop_project.wsgi_staging:application

Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### 3.3 Staging Deployment Workflow

```bash
# 1. Pull latest development code
cd /home/cladmin/ncop_local/ncop_local_stage
git pull origin dev-arsalan

# 2. Activate environment
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# 3. Install/update dependencies
pip install -r project/requirements.txt
cd frontend && npm install && cd ..

# 4. Build frontend assets
cd frontend
npm run build
cd ..

# 5. Run migrations
cd project
python manage.py migrate --settings=ncop_project.settings.staging

# 6. Collect static files
python manage.py collectstatic --noinput --settings=ncop_project.settings.staging
cd ..

# 7. Restart service
sudo systemctl restart ncop-stage-waitress.service

# 8. Verify
curl -I http://172.18.7.36:9000/
```

---

## Part IV: Production Deployment (Prod-Arsalan)

### 4.1 Production Environment Overview

The production environment (`prod-arsalan`) is the live system accessed by end users. It combines multiple technologies for optimal performance, security, and reliability.

**Production Stack:**
```
Internet → Nginx (Port 80) → Waitress (Port 8000) → Django → PostgreSQL
              ↓
         Static Files
         (Direct Serve)
```

**Key Differences from Staging:**
- Nginx reverse proxy (staging accesses Waitress directly)
- Port 80 (standard HTTP) instead of 9000
- Enhanced security headers
- Optimized caching
- Separate static file serving strategy

### 4.2 Initial Production Setup

#### Cloning Production Code

```bash
# Create production directory
cd /home/cladmin/ncop_local
git clone https://github.com/arsalanmukhtar/ncop_local.git ncop_local_prod
cd ncop_local_prod

# Checkout production branch
git checkout -b prod-arsalan origin/stage-arsalan

# Push production branch
git push -u origin prod-arsalan
```

#### Creating .env File

**Location**: `/home/cladmin/ncop_local/ncop_local_prod/.env`

```bash
# Django Configuration
DJANGO_SECRET_KEY=your-secret-key-here-change-this
DJANGO_DEBUG=False
DJANGO_ALLOWED_HOSTS=172.18.7.36,localhost,127.0.0.1

# Database Configuration
POSTGRES_DB=ncop_prod
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-secure-password
POSTGRES_HOST=localhost
POSTGRES_PORT=5432

# Vite Configuration
VITE_DEV_MODE=false

# CORS Configuration
CORS_ALLOWED_ORIGINS=http://172.18.7.36,http://127.0.0.1

# API Keys (if applicable)
MAPBOX_ACCESS_TOKEN=your-mapbox-token
METEOBLUE_TOKEN=your-meteoblue-token
WAQI_API_TOKEN=your-waqi-token
```

**Security Note**: Never commit `.env` to Git! Add it to `.gitignore`.

### 4.3 Django Configuration

#### Production Settings (prod.py)

**Location**: `/home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings/prod.py`

```python
"""
Production Settings for NCOP Project (prod-arsalan)

This settings file is used when running prod-arsalan on Ubuntu VM 
with Waitress + WhiteNoise + Nginx.

Key Features:
- NO development mode
- NO Hot Module Reloading (HMR)
- Pre-built frontend assets only
- Full security hardening
- WhiteNoise for static file serving
"""

from .base import *
import os

# =====================================================
# PRODUCTION MODE - STRICT SETTINGS
# =====================================================

DEBUG = False

# Allowed Hosts - Set from environment or use defaults
ALLOWED_HOSTS = env.list("DJANGO_ALLOWED_HOSTS", 
                         default=["172.18.7.36", "localhost", "127.0.0.1"])

# =====================================================
# VITE - USE BUILT ASSETS ONLY (NO DEV SERVER)
# =====================================================

# Production MUST use built bundles, never dev mode
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": "/",  # Root path - prepends to manifest entries
    }
}

# =====================================================
# STATICFILES - OVERRIDE BASE.PY
# =====================================================
# In production, Vite assets are served by Nginx at /assets/
# We must remove frontend/dist from STATICFILES_DIRS to prevent conflicts

STATICFILES_DIRS = []
legacy_static = BASE_DIR / "static" / "src"
if legacy_static.exists():
    STATICFILES_DIRS.append(legacy_static)

# ⚠️ DO NOT include frontend/dist here - Nginx serves it directly!
# This prevents /static/assets/assets/ double path issue

# =====================================================
# STATIC FILES & WHITENOISE
# =====================================================

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

# WhiteNoise optimizations
WHITENOISE_AUTOREFRESH = False
WHITENOISE_USE_FINDERS = False

# =====================================================
# SECURITY - HARDENED FOR PRODUCTION
# =====================================================

# HTTPS/SSL Configuration (Nginx handles SSL termination)
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = False  # Set to True when using HTTPS
CSRF_COOKIE_SECURE = False     # Set to True when using HTTPS

# HSTS (Enable when using HTTPS)
SECURE_HSTS_SECONDS = 0  # Set to 31536000 when using HTTPS
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False

# SSL Redirect (handled by Nginx)
SECURE_SSL_REDIRECT = False

# =====================================================
# CORS & ALLOWED ORIGINS
# =====================================================

CORS_ALLOWED_ORIGINS = env.list(
    "CORS_ALLOWED_ORIGINS",
    default=[
        "http://172.18.7.36",
        "http://127.0.0.1",
        "http://localhost",
    ],
)

# Allow insecure transport for HTTP testing
os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

# =====================================================
# DATABASE - PRODUCTION
# =====================================================

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

# =====================================================
# CACHE CONFIGURATION
# =====================================================

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ncop-prod-cache",
        "TIMEOUT": 300,
    }
}

# For Redis caching (optional, commented out):
# CACHES = {
#     "default": {
#         "BACKEND": "django_redis.cache.RedisCache",
#         "LOCATION": "redis://127.0.0.1:6379/1",
#         "OPTIONS": {
#             "CLIENT_CLASS": "django_redis.client.DefaultClient",
#         }
#     }
# }

# =====================================================
# LOGGING - PRODUCTION GRADE
# =====================================================

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{levelname} {asctime} {module} {process:d} {thread:d} {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "level": "INFO",
            "class": "logging.StreamHandler",
            "formatter": "verbose",
        },
        "file": {
            "level": "WARNING",
            "class": "logging.handlers.RotatingFileHandler",
            "filename": BASE_DIR / "logs" / "django.log",
            "maxBytes": 10485760,  # 10MB
            "backupCount": 5,
            "formatter": "verbose",
        },
    },
    "root": {
        "handlers": ["console", "file"],
        "level": "INFO",
    },
    "django": {
        "handlers": ["console", "file"],
        "level": "INFO",
        "propagate": False,
    },
}

# Create logs directory if it doesn't exist
import os
os.makedirs(BASE_DIR / "logs", exist_ok=True)

# =====================================================
# SESSION & COOKIES
# =====================================================

SESSION_ENGINE = "django.contrib.sessions.backends.db"
SESSION_COOKIE_AGE = 1209600  # 2 weeks
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = False  # Set to True with HTTPS

# =====================================================
# EMAIL BACKEND
# =====================================================

EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
DEFAULT_FROM_EMAIL = "no-reply@ncop.ndma.gov.pk"

# For production email (configure SMTP):
# EMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"
# EMAIL_HOST = "smtp.gmail.com"
# EMAIL_PORT = 587
# EMAIL_USE_TLS = True
# EMAIL_HOST_USER = env("EMAIL_HOST_USER")
# EMAIL_HOST_PASSWORD = env("EMAIL_HOST_PASSWORD")

# =====================================================
# WSGI APPLICATION
# =====================================================

WSGI_APPLICATION = "ncop_project.wsgi_prod.application"

# =====================================================
# API KEYS (Load from environment)
# =====================================================

MAPBOX_ACCESS_TOKEN = env("MAPBOX_ACCESS_TOKEN", default="")
METEOBLUE_TOKEN = env("METEOBLUE_TOKEN", default="")
WAQI_API_TOKEN = env("WAQI_API_TOKEN", default="")

# =====================================================
# STARTUP MESSAGE
# =====================================================

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

**Key Configuration Points:**

1. **`DEBUG = False`**: Hides sensitive error information from users
2. **`ALLOWED_HOSTS`**: Restricts which domains can access the app
3. **`DJANGO_VITE["static_url_prefix"] = "/"`**: Prevents double path issues
4. **`STATICFILES_DIRS = []`**: Prevents Django from collecting Vite assets
5. **WhiteNoise**: Efficiently serves Django's static files
6. **Logging**: Records errors and warnings to files

### 4.4 Nginx Configuration

Nginx acts as a reverse proxy and directly serves static files for better performance.

**Location**: `/etc/nginx/sites-available/ncop-prod`

```nginx
# =====================================================
# NCOP Production Nginx Configuration
# =====================================================

upstream waitress_app {
    server 127.0.0.1:8000 fail_timeout=0;
}

server {
    listen 80;
    server_name 172.18.7.36;

    access_log /var/log/nginx/ncop_access.log combined;
    error_log  /var/log/nginx/ncop_error.log warn;

    client_max_body_size 100M;

    # ========================================
    # VITE ASSETS - Correct Path
    # ========================================
    # Serves React/JavaScript/CSS built by Vite
    # URL: /assets/* → Filesystem: frontend/dist/assets/
    location /assets/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
        try_files $uri =404;
    }

    # ========================================
    # VITE ASSETS - Legacy Path (backwards compatible)
    # ========================================
    # Some old templates may reference /static/assets/
    # This ensures they continue to work
    location /static/assets/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript application/json image/svg+xml;
        try_files $uri =404;
    }

    # ========================================
    # DJANGO STATIC FILES
    # ========================================
    # Serves Django admin, DRF, and other Django static files
    # URL: /static/* → Filesystem: project/static/dist/
    location /static/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/;
        expires 365d;
        add_header Cache-Control "public, immutable";
        gzip on;
        gzip_types text/css application/javascript image/svg+xml;
        try_files $uri =404;
    }

    # ========================================
    # MEDIA FILES
    # ========================================
    # User-uploaded files (images, documents, etc.)
    location /media/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/project/media/;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    # ========================================
    # DJANGO APPLICATION (via Waitress)
    # ========================================
    # All other requests go to Django
    location / {
        proxy_pass http://waitress_app;

        # Forward headers
        proxy_set_header Host                $http_host;
        proxy_set_header X-Real-IP           $remote_addr;
        proxy_set_header X-Forwarded-For     $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto   $scheme;
        proxy_set_header X-Forwarded-Host    $server_name;
        proxy_set_header X-Forwarded-Port    $server_port;

        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        # Disable buffering for real-time updates
        proxy_buffering off;
    }

    # ========================================
    # SECURITY HEADERS
    # ========================================
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    
    # Uncomment for HTTPS:
    # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
}
```

**Understanding the Configuration:**

```
Browser Request Flow:

1. http://172.18.7.36/assets/main.js
   → Nginx location /assets/
   → Serves from: frontend/dist/assets/main.js
   → Returns file directly (fast!)

2. http://172.18.7.36/static/admin/css/base.css
   → Nginx location /static/
   → Serves from: project/static/dist/admin/css/base.css
   → Returns file directly (fast!)

3. http://172.18.7.36/login/
   → Nginx location /
   → Proxies to: Waitress on port 8000
   → Django generates HTML response
   → Returns rendered page
```

**Enabling the Configuration:**

```bash
# Create symlink in sites-enabled
sudo ln -s /etc/nginx/sites-available/ncop-prod /etc/nginx/sites-enabled/

# Remove default site if present
sudo rm -f /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# If test passes, reload Nginx
sudo systemctl reload nginx
```

### 4.5 Waitress Service Configuration

Waitress is a production-quality WSGI server that runs the Django application.

**Location**: `/etc/systemd/system/ncop-waitress.service`

```ini
[Unit]
Description=NCOP Production Waitress Service
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=cladmin
Group=cladmin
WorkingDirectory=/home/cladmin/ncop_local/ncop_local_prod/project

# Environment
Environment="PATH=/home/cladmin/ncop_local/ncopenv311/bin"
Environment="PYTHONUNBUFFERED=1"

# Start command
ExecStart=/home/cladmin/ncop_local/ncopenv311/bin/python -m waitress \
    --port=8000 \
    --host=127.0.0.1 \
    --threads=4 \
    --channel-timeout=60 \
    ncop_project.wsgi_prod:application

# Restart policy
Restart=always
RestartSec=5
StartLimitInterval=0

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ncop-waitress

[Install]
WantedBy=multi-user.target
```

**Configuration Explanation:**

- **`--port=8000`**: Listens on port 8000 (Nginx proxies to this)
- **`--host=127.0.0.1`**: Only accessible from localhost (security)
- **`--threads=4`**: Handles 4 concurrent requests
- **`--channel-timeout=60`**: Request timeout in seconds
- **`Restart=always`**: Auto-restarts if it crashes
- **`After=postgresql.service`**: Starts after database is ready

**Managing the Service:**

```bash
# Enable service to start on boot
sudo systemctl enable ncop-waitress.service

# Start the service
sudo systemctl start ncop-waitress.service

# Check status
sudo systemctl status ncop-waitress.service

# View logs
sudo journalctl -u ncop-waitress.service -f

# Restart service
sudo systemctl restart ncop-waitress.service

# Stop service
sudo systemctl stop ncop-waitress.service
```

---

## Part V: Asset Management & Build Process

### 5.1 Understanding Vite Assets

Vite is a modern frontend build tool that:
- Bundles JavaScript modules into optimized files
- Processes CSS and applies optimizations
- Handles image assets
- Generates unique filenames (content hashing)
- Creates a manifest file for Django to reference

**Why Content Hashing?**

When you update your JavaScript, Vite creates a new filename:
```
Old: dashboard_main-abc123.js
New: dashboard_main-xyz789.js
```

This forces browsers to download the new version (cache busting).

**The Build Process:**

```
Source Files                    Build Process                Built Assets
------------                    -------------                ------------

src/entries/                    
  auth_login.js      ─┐                                   dist/assets/
                      │                                     auth_login-y_ywPWRi.js
src/modules/         │         npm run build              dashboard_main-DQjo4yzw.css
  map-layers.js      ├──────→  (Vite processes)  ──────→   map-layers-a1b2c3d4.js
  dashboard.js       │         (Optimizes)                  set-assets-U9Y94Vij.js
                      │         (Hashes filenames)           ...
src/styles/          │
  dashboard.css      ─┘                                   dist/.vite/
                                                            manifest.json
src/assets/                                                  (Maps source → built)
  images/
```

**The Manifest File:**

**Location**: `frontend/dist/.vite/manifest.json`

```json
{
  "src/entries/auth_login.js": {
    "file": "assets/auth_login-y_ywPWRi.js",
    "css": ["assets/auth_login-BqoyYKPR.css"],
    "isEntry": true
  },
  "src/entries/dashboard_main.js": {
    "file": "assets/dashboard_main-Dd6lDCsS.js",
    "css": ["assets/dashboard_main-DQjo4yzw.css"],
    "imports": ["_chunk-cm8GkQdX.js"],
    "isEntry": true
  },
  "_chunk-cm8GkQdX.js": {
    "file": "assets/chunk-cm8GkQdX.js"
  }
}
```

Django uses this manifest to know which files to include in HTML templates.

### 5.2 Django Static Files

Django has its own static files separate from Vite assets:

**Django Admin Files:**
```
static/dist/admin/
├── css/
│   ├── base.css
│   ├── forms.css
│   └── ...
├── js/
│   ├── admin.js
│   └── ...
└── img/
    └── ...
```

**Django REST Framework Files:**
```
static/dist/rest_framework/
├── css/
│   └── default.css
└── js/
    └── ...
```

**How Django Collects Static Files:**

```bash
python manage.py collectstatic --settings=ncop_project.settings.prod
```

This command:
1. Finds all static files in Django apps (admin, DRF, etc.)
2. Copies them to `STATIC_ROOT` (project/static/dist/)
3. Processes them through WhiteNoise (compression, hashing)
4. Creates a manifest for lookups

**Important**: Django's `collectstatic` should **NOT** include Vite assets. We prevent this by keeping `frontend/dist` out of `STATICFILES_DIRS`.

### 5.3 The Asset Pipeline

**The Two-Track System:**

```
TRACK 1: Vite Assets (Your React App)
======================================
Source: frontend/src/
         ↓
Build: npm run build
         ↓
Output: frontend/dist/assets/
         ↓
Served by: Nginx at /assets/*
         ↓
Browser: Loads JavaScript, CSS, images


TRACK 2: Django Static Files (Admin, Forms)
===========================================
Source: Django apps (admin/, rest_framework/)
         ↓
Collect: python manage.py collectstatic
         ↓
Output: project/static/dist/
         ↓
Served by: Nginx at /static/*
         ↓
Browser: Loads admin styles, DRF interface
```

**Critical Rule**: These two tracks must **never mix**. Keeping them separate prevents path conflicts and confusion.

### 5.4 Frontend Build Process

#### Building Vite Assets

```bash
# Navigate to frontend directory
cd /home/cladmin/ncop_local/ncop_local_prod/frontend

# Clean previous build (recommended)
rm -rf dist/

# Build production assets
npm run build
```

**What happens during build:**

1. **Reads configuration**: `vite.config.js`
2. **Processes entry points**: `src/entries/*.js`
3. **Bundles dependencies**: Combines imported modules
4. **Optimizes code**: Minifies JavaScript and CSS
5. **Hashes filenames**: Creates unique names for cache busting
6. **Copies assets**: Images, fonts to `dist/assets/`
7. **Generates manifest**: `dist/.vite/manifest.json`

**Build Output:**

```
frontend/dist/
├── assets/
│   ├── auth_login-y_ywPWRi.js          (Entry point)
│   ├── auth_login-BqoyYKPR.css         (Styles)
│   ├── dashboard_main-Dd6lDCsS.js      (Entry point)
│   ├── dashboard_main-DQjo4yzw.css     (Styles)
│   ├── chunk-cm8GkQdX.js               (Shared code)
│   ├── set-assets-U9Y94Vij.js          (Asset loader)
│   ├── background-CT5iv2qp.gif         (Image)
│   ├── ndma-logo-BZdnuktw.png          (Image)
│   └── ... (many more files)
│
├── .vite/
│   └── manifest.json                    (Asset map)
│
├── index.html
├── favicon.ico
└── vite.svg
```

**Verifying the Build:**

```bash
# Check if build succeeded
ls -lh frontend/dist/assets/*.js | head -10

# Check manifest exists
cat frontend/dist/.vite/manifest.json | python3 -m json.tool | head -20

# Count total assets
echo "Total JS files: $(ls -1 frontend/dist/assets/*.js | wc -l)"
echo "Total CSS files: $(ls -1 frontend/dist/assets/*.css | wc -l)"
echo "Total assets: $(ls -1 frontend/dist/assets/ | wc -l)"
```

#### Vite Configuration

**Location**: `frontend/vite.config.js`

```javascript
import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Base public path
  base: "/assets/",
  
  // Build configuration
  build: {
    outDir: "dist",
    emptyOutDir: true,
    
    // Generate manifest for Django
    manifest: ".vite/manifest.json",
    
    // Entry points
    rollupOptions: {
      input: {
        auth_login: resolve(__dirname, "src/entries/auth_login.js"),
        auth_signup: resolve(__dirname, "src/entries/auth_signup.js"),
        auth_reset: resolve(__dirname, "src/entries/auth_reset.js"),
        auth_reset_confirm: resolve(__dirname, "src/entries/auth_reset_confirm.js"),
        dashboard_main: resolve(__dirname, "src/entries/dashboard_main.js"),
      },
      
      // Output configuration
      output: {
        // Asset file naming
        assetFileNames: (assetInfo) => {
          // Keep images in assets/
          if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name)) {
            return "assets/[name]-[hash][extname]";
          }
          // CSS files
          return "assets/[name]-[hash][extname]";
        },
        
        // JavaScript chunk naming
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
    
    // Optimize for production
    minify: "terser",
    sourcemap: false,
  },
  
  // Development server (not used in production)
  server: {
    port: 5173,
    host: "localhost",
  },
});
```

---

## Part VI: Deployment Workflow

### 6.1 Complete Deployment Steps

This section provides the complete, step-by-step process for deploying updates to production.

**Deployment Overview:**

```
1. Pull latest code from stage-arsalan
2. Activate Python virtual environment
3. Install/update Python dependencies
4. Install/update Node dependencies
5. Build frontend assets with Vite
6. Run database migrations
7. Collect Django static files
8. Fix file permissions for Nginx
9. Restart Waitress service
10. Reload Nginx configuration
11. Verify deployment
```

### 6.2 Automated Deployment Script

**Location**: Save as `/home/cladmin/deploy_prod.sh`

```bash
#!/bin/bash
# =====================================================
# NCOP Production Deployment Script
# Version: 2.0
# Description: Automated deployment for prod-arsalan
# =====================================================

set -e  # Exit immediately if any command fails

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log function
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

warn() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# =====================================================
# CONFIGURATION
# =====================================================
PROJECT_DIR="/home/cladmin/ncop_local/ncop_local_prod"
VENV_DIR="/home/cladmin/ncop_local/ncopenv311"
FRONTEND_DIR="$PROJECT_DIR/frontend"
BACKEND_DIR="$PROJECT_DIR/project"
BRANCH="stage-arsalan"

# =====================================================
# PRE-DEPLOYMENT CHECKS
# =====================================================
log "Starting NCOP Production Deployment..."
echo ""

# Check if running as cladmin
if [ "$USER" != "cladmin" ]; then
    error "This script must be run as cladmin user"
fi

# Check if project directory exists
if [ ! -d "$PROJECT_DIR" ]; then
    error "Project directory not found: $PROJECT_DIR"
fi

# Check if virtual environment exists
if [ ! -d "$VENV_DIR" ]; then
    error "Virtual environment not found: $VENV_DIR"
fi

log "✓ Pre-deployment checks passed"

# =====================================================
# STEP 1: PULL LATEST CODE
# =====================================================
log "Step 1/10: Pulling latest code from $BRANCH..."

cd "$PROJECT_DIR"
git fetch origin
git pull origin "$BRANCH" || error "Failed to pull from $BRANCH"

log "✓ Code updated successfully"

# =====================================================
# STEP 2: ACTIVATE VIRTUAL ENVIRONMENT
# =====================================================
log "Step 2/10: Activating virtual environment..."

source "$VENV_DIR/bin/activate" || error "Failed to activate virtual environment"

log "✓ Virtual environment activated"

# =====================================================
# STEP 3: UPDATE PYTHON DEPENDENCIES
# =====================================================
log "Step 3/10: Updating Python dependencies..."

cd "$BACKEND_DIR"
pip install --upgrade pip setuptools wheel > /dev/null
pip install -r requirements.txt || error "Failed to install Python dependencies"

log "✓ Python dependencies updated"

# =====================================================
# STEP 4: UPDATE NODE DEPENDENCIES
# =====================================================
log "Step 4/10: Updating Node dependencies..."

cd "$FRONTEND_DIR"
npm install || error "Failed to install Node dependencies"

log "✓ Node dependencies updated"

# =====================================================
# STEP 5: BUILD VITE ASSETS
# =====================================================
log "Step 5/10: Building frontend assets..."

cd "$FRONTEND_DIR"

# Clean previous build
log "  → Cleaning old build..."
rm -rf dist/

# Build with Vite
log "  → Running npm run build..."
npm run build || error "Vite build failed"

# Verify build
if [ ! -d "dist/assets" ]; then
    error "Vite build failed - dist/assets/ directory not created"
fi

JS_COUNT=$(ls -1 dist/assets/*.js 2>/dev/null | wc -l)
CSS_COUNT=$(ls -1 dist/assets/*.css 2>/dev/null | wc -l)

log "✓ Vite build complete ($JS_COUNT JS files, $CSS_COUNT CSS files)"

# =====================================================
# STEP 6: RUN DATABASE MIGRATIONS
# =====================================================
log "Step 6/10: Running database migrations..."

cd "$BACKEND_DIR"
python manage.py migrate --settings=ncop_project.settings.prod || warn "Migrations had warnings"

log "✓ Database migrations complete"

# =====================================================
# STEP 7: COLLECT STATIC FILES
# =====================================================
log "Step 7/10: Collecting Django static files..."

cd "$BACKEND_DIR"

# Clean old collected files
log "  → Cleaning old static files..."
rm -rf static/dist/

# Collect static files
log "  → Running collectstatic..."
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod || error "collectstatic failed"

# Verify collection
if [ ! -d "static/dist/admin" ]; then
    error "collectstatic failed - admin files not found"
fi

log "✓ Static files collected"

# =====================================================
# STEP 7.5: BUILD NCOP ASSISTANT KNOWLEDGE BASE
# =====================================================
# Idempotent (deterministic chunk ids upsert cleanly) — safe to run on
# every deploy. Two things happen here, both required before the NCOP
# Assistant chat panel can work correctly in production:
#   1. Chunks + embeds CONTEXT.md/the other root docs/GRAPH_REPORT.md/the
#      live sidebar layer catalog into the persistent Chroma index at
#      project/cache/chroma_db/.
#   2. Downloads + caches Chroma's bundled ONNX embedding model (~90MB,
#      one-time per machine, cached under this user's home directory) —
#      running it here means that download happens during the deploy
#      window, not silently on whichever live user sends the first real
#      chat message (which would otherwise be slow, and would fail
#      outright if this machine's outbound internet access doesn't reach
#      chroma-onnx-models.s3.amazonaws.com — verify that reachability once
#      per new deployment target if this step errors).
log "Step 7.5/10: Building NCOP Assistant knowledge base..."

cd "$BACKEND_DIR"
python manage.py ingest_chat_knowledge --settings=ncop_project.settings.prod || warn "NCOP Assistant ingestion failed — chat panel will run in degraded mode (no retrieved context) until this is re-run successfully"

log "✓ NCOP Assistant knowledge base ready"

# =====================================================
# STEP 8: FIX FILE PERMISSIONS
# =====================================================
log "Step 8/10: Setting correct file permissions..."

# Allow Nginx (www-data) to traverse directories
sudo chmod o+x /home/cladmin
sudo chmod o+x /home/cladmin/ncop_local
sudo chmod o+x "$PROJECT_DIR"

# Allow Nginx to read Vite assets
sudo chmod -R o+rX "$FRONTEND_DIR/dist"

# Allow Nginx to read Django static files
sudo chmod -R o+rX "$BACKEND_DIR/static/dist"

# Allow Nginx to read media files (if they exist)
if [ -d "$BACKEND_DIR/media" ]; then
    sudo chmod -R o+rX "$BACKEND_DIR/media"
fi

log "✓ File permissions set"

# =====================================================
# STEP 9: RESTART SERVICES
# =====================================================
log "Step 9/10: Restarting services..."

# Stop Waitress
log "  → Stopping Waitress..."
sudo systemctl stop ncop-waitress.service

# Reload Nginx
log "  → Reloading Nginx..."
sudo nginx -t || error "Nginx configuration test failed"
sudo systemctl reload nginx

# Start Waitress
log "  → Starting Waitress..."
sudo systemctl start ncop-waitress.service

# Wait for services to stabilize
sleep 3

log "✓ Services restarted"

# =====================================================
# STEP 10: VERIFY DEPLOYMENT
# =====================================================
log "Step 10/10: Verifying deployment..."

# Check Waitress status
if systemctl is-active --quiet ncop-waitress.service; then
    log "  ✓ Waitress is running"
else
    error "Waitress failed to start"
fi

# Check Nginx status
if systemctl is-active --quiet nginx; then
    log "  ✓ Nginx is running"
else
    error "Nginx is not running"
fi

# Test HTTP response
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/login/ 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
    log "  ✓ Application responding (HTTP $HTTP_STATUS)"
elif [ "$HTTP_STATUS" = "302" ]; then
    log "  ✓ Application responding (HTTP $HTTP_STATUS - redirect)"
else
    warn "Application returned HTTP $HTTP_STATUS"
fi

# Check for recent errors
ERROR_COUNT=$(sudo journalctl -u ncop-waitress.service --since "2 minutes ago" --no-pager 2>/dev/null | grep -i "error" | wc -l)

if [ "$ERROR_COUNT" -gt 0 ]; then
    warn "Found $ERROR_COUNT errors in logs (last 2 minutes)"
    log "  → Check logs: sudo journalctl -u ncop-waitress.service -n 50"
else
    log "  ✓ No errors in recent logs"
fi

# =====================================================
# DEPLOYMENT COMPLETE
# =====================================================
echo ""
echo "=========================================="
log "🎉 DEPLOYMENT COMPLETE!"
echo "=========================================="
echo ""
echo "📊 Deployment Summary:"
echo "  • Branch: $BRANCH"
echo "  • Vite Assets: $JS_COUNT JS, $CSS_COUNT CSS"
echo "  • Services: Waitress ✓ Nginx ✓"
echo "  • HTTP Status: $HTTP_STATUS"
echo ""
echo "🌐 Application URL: http://172.18.7.36"
echo ""
echo "📋 Useful Commands:"
echo "  • View logs:     sudo journalctl -u ncop-waitress.service -f"
echo "  • Check status:  sudo systemctl status ncop-waitress.service"
echo "  • Restart:       sudo systemctl restart ncop-waitress.service"
echo "  • Nginx logs:    sudo tail -f /var/log/nginx/ncop_error.log"
echo ""
echo "=========================================="
```

**Make the script executable:**

```bash
chmod +x /home/cladmin/deploy_prod.sh
```

**Run deployment:**

```bash
/home/cladmin/deploy_prod.sh
```

### 6.3 Manual Deployment Process

If you prefer to run commands manually or need to troubleshoot:

```bash
# =====================================================
# 1. NAVIGATE TO PROJECT
# =====================================================
cd /home/cladmin/ncop_local/ncop_local_prod

# =====================================================
# 2. ACTIVATE VIRTUAL ENVIRONMENT
# =====================================================
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Verify activation (should show ncopenv311)
which python

# =====================================================
# 3. PULL LATEST CODE
# =====================================================
git fetch origin
git pull origin stage-arsalan

# Check what changed
git log --oneline -10

# =====================================================
# 4. UPDATE DEPENDENCIES (if needed)
# =====================================================
# Python dependencies
cd project
pip install -r requirements.txt

# Node dependencies
cd ../frontend
npm install

cd ..

# =====================================================
# 5. BUILD VITE ASSETS
# =====================================================
cd frontend

# Clean previous build
rm -rf dist/

# Build production assets
npm run build

# Verify build
ls -lh dist/assets/*.js | head -10
cat dist/.vite/manifest.json | python3 -m json.tool | head -20

cd ..

# =====================================================
# 6. RUN MIGRATIONS (if needed)
# =====================================================
cd project

python manage.py migrate --settings=ncop_project.settings.prod

# Check migration status
python manage.py showmigrations --settings=ncop_project.settings.prod

cd ..

# =====================================================
# 7. COLLECT STATIC FILES
# =====================================================
cd project

# Remove old collected files
rm -rf static/dist/

# Collect Django static files (NOT Vite assets)
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod

# Verify collection
ls -la static/dist/
# Should see: admin/, rest_framework/, gis/, django_extensions/
# Should NOT see: Vite assets or frontend files

cd ..

# =====================================================
# 8. FIX FILE PERMISSIONS
# =====================================================
# Allow Nginx to traverse directories
sudo chmod o+x /home/cladmin
sudo chmod o+x /home/cladmin/ncop_local
sudo chmod o+x /home/cladmin/ncop_local/ncop_local_prod

# Allow Nginx to read Vite assets
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist

# Allow Nginx to read Django static files
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist

# Allow Nginx to read media files
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/media 2>/dev/null || true

# =====================================================
# 9. RESTART SERVICES
# =====================================================
# Stop Waitress
sudo systemctl stop ncop-waitress.service

# Test Nginx configuration
sudo nginx -t

# Reload Nginx (if test passes)
sudo systemctl reload nginx

# Start Waitress
sudo systemctl start ncop-waitress.service

# Wait for stabilization
sleep 3

# =====================================================
# 10. VERIFY DEPLOYMENT
# =====================================================
# Check service status
sudo systemctl status ncop-waitress.service
sudo systemctl status nginx

# Test HTTP response
curl -I http://127.0.0.1:8000/
curl -I http://172.18.7.36/login/

# Test asset loading
curl -I http://172.18.7.36/assets/auth_login-y_ywPWRi.js
curl -I http://172.18.7.36/static/admin/css/base.css

# Check logs
sudo journalctl -u ncop-waitress.service -n 50 --no-pager

# Check for errors
sudo journalctl -u ncop-waitress.service --since "5 minutes ago" | grep -i error || echo "No errors found"
```

### 6.4 Post-Deployment Verification

**Comprehensive Verification Checklist:**

#### 1. Service Health Checks

```bash
# Check if services are running
echo "=== Service Status ==="
systemctl is-active --quiet ncop-waitress.service && echo "✅ Waitress: Running" || echo "❌ Waitress: Stopped"
systemctl is-active --quiet nginx && echo "✅ Nginx: Running" || echo "❌ Nginx: Stopped"
```

#### 2. HTTP Response Tests

```bash
echo -e "\n=== HTTP Response Tests ==="

# Test main application
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/)
echo "Main app (127.0.0.1:8000): HTTP $STATUS"

# Test through Nginx
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://172.18.7.36/)
echo "Through Nginx (172.18.7.36): HTTP $STATUS"

# Test login page
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://172.18.7.36/login/)
echo "Login page: HTTP $STATUS"
```

#### 3. Asset Loading Tests

```bash
echo -e "\n=== Asset Loading Tests ==="

# Find a sample Vite asset
SAMPLE_JS=$(ls /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/*.js 2>/dev/null | head -1)
if [ -n "$SAMPLE_JS" ]; then
    ASSET_NAME=$(basename "$SAMPLE_JS")
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://172.18.7.36/assets/$ASSET_NAME")
    echo "Vite JS asset: HTTP $STATUS ($ASSET_NAME)"
fi

# Test Django admin CSS
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://172.18.7.36/static/admin/css/base.css)
echo "Django admin CSS: HTTP $STATUS"

# Test legacy path (backwards compatibility)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://172.18.7.36/static/assets/$ASSET_NAME")
echo "Legacy asset path: HTTP $STATUS"
```

#### 4. Log Analysis

```bash
echo -e "\n=== Recent Logs ==="

# Check for errors in last 5 minutes
ERROR_COUNT=$(sudo journalctl -u ncop-waitress.service --since "5 minutes ago" --no-pager 2>/dev/null | grep -i "error" | wc -l)

if [ "$ERROR_COUNT" -eq 0 ]; then
    echo "✅ No errors in last 5 minutes"
else
    echo "⚠️  Found $ERROR_COUNT errors in last 5 minutes"
    echo "View with: sudo journalctl -u ncop-waitress.service -n 100"
fi

# Check Nginx error log
NGINX_ERRORS=$(sudo tail -20 /var/log/nginx/ncop_error.log 2>/dev/null | wc -l)
echo "Recent Nginx log entries: $NGINX_ERRORS"
```

#### 5. Database Connectivity

```bash
echo -e "\n=== Database Connectivity ==="

cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.db import connection
try:
    with connection.cursor() as cursor:
        cursor.execute("SELECT version();")
        version = cursor.fetchone()[0]
    print(f"✅ Database connected: {version[:50]}...")
except Exception as e:
    print(f"❌ Database error: {e}")
EOF
```

#### 6. Configuration Verification

```bash
echo -e "\n=== Configuration Check ==="

cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.conf import settings
import os

print("DEBUG:", settings.DEBUG)
print("ALLOWED_HOSTS:", settings.ALLOWED_HOSTS)
print("STATIC_URL:", settings.STATIC_URL)
print("STATIC_ROOT:", settings.STATIC_ROOT)

vite_config = settings.DJANGO_VITE['default']
print("\nDjango Vite:")
print(f"  dev_mode: {vite_config['dev_mode']}")
print(f"  static_url_prefix: '{vite_config['static_url_prefix']}'")
print(f"  manifest exists: {os.path.exists(vite_config['manifest_path'])}")

print("\nSTATICFILES_DIRS:", settings.STATICFILES_DIRS)
has_frontend = any('frontend' in str(d) and 'dist' in str(d) for d in settings.STATICFILES_DIRS)
if has_frontend:
    print("  ⚠️  WARNING: frontend/dist should NOT be in STATICFILES_DIRS")
else:
    print("  ✅ frontend/dist correctly excluded")
EOF
```

#### 7. Browser Testing

```bash
echo -e "\n=== Browser Testing Instructions ==="
echo ""
echo "1. Open browser in INCOGNITO/PRIVATE mode (to bypass cache)"
echo "2. Navigate to: http://172.18.7.36"
echo "3. Open DevTools (F12) → Network tab"
echo "4. Refresh the page (Ctrl+F5)"
echo ""
echo "Expected Results:"
echo "  ✅ All /assets/* files return 200 OK"
echo "  ✅ All /static/* files return 200 OK"
echo "  ✅ No 404 or 500 errors"
echo "  ✅ No console errors"
echo "  ✅ No double /assets/assets/ paths"
echo ""
echo "If you see any issues, check logs:"
echo "  sudo journalctl -u ncop-waitress.service -f"
echo ""
```

#### 8. Performance Check

```bash
echo -e "\n=== Performance Check ==="

# Check response time
echo "Testing response time..."
time curl -s -o /dev/null http://172.18.7.36/login/

# Check asset size
echo -e "\nAsset sizes:"
du -sh /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/
du -sh /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/
```

---

## Part VII: Troubleshooting Guide

### 7.1 Common Issues & Solutions

This section provides detailed troubleshooting for the most common deployment issues.

---

### 7.2 The Double Path Problem

**Symptoms:**
```
Browser console shows:
GET http://172.18.7.36/static/assets/assets/dashboard_main.js → 404 Not Found
```

Notice the **double `/assets/assets/`** in the URL.

**Root Cause:**

This happens when:
1. Django's `STATICFILES_DIRS` includes `frontend/dist`
2. Django's `collectstatic` copies Vite assets to `static/dist/assets/`
3. Django Vite tries to serve them with a prefix
4. Result: `/static/` + `assets/` + `assets/main.js` = `/static/assets/assets/main.js`

**Visual Explanation:**

```
What We Want:
  Browser → /assets/main.js → Nginx → frontend/dist/assets/main.js ✅

What's Happening (WRONG):
  Browser → /static/assets/assets/main.js → 404 Error ❌
```

**Solution 1: Fix prod.py (Recommended)**

```bash
# Edit production settings
cd /home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings
nano prod.py
```

Ensure these settings:

```python
# Override STATICFILES_DIRS from base.py
STATICFILES_DIRS = []
legacy_static = BASE_DIR / "static" / "src"
if legacy_static.exists():
    STATICFILES_DIRS.append(legacy_static)

# ⚠️ DO NOT include frontend/dist here!

# Django Vite configuration
DJANGO_VITE = {
    "default": {
        "dev_mode": False,
        "manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",
        "static_url_prefix": "/",  # Just "/" - no extra prefix
    }
}
```

Then restart:
```bash
sudo systemctl restart ncop-waitress.service
```

**Solution 2: Add Nginx Fallback (Backwards Compatible)**

Even with correct configuration, old templates might still reference `/static/assets/`. Add this to Nginx:

```nginx
# In /etc/nginx/sites-available/ncop-prod
location /static/assets/ {
    alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
    expires 365d;
    add_header Cache-Control "public, immutable";
    try_files $uri =404;
}
```

Reload Nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

**Verification:**

```bash
# Test both paths work
curl -I http://172.18.7.36/assets/auth_login-y_ywPWRi.js
curl -I http://172.18.7.36/static/assets/auth_login-y_ywPWRi.js

# Both should return: HTTP/1.1 200 OK
```

---

### 7.3 File Permission Issues

**Symptoms:**
```
curl -I http://172.18.7.36/assets/main.js
HTTP/1.1 403 Forbidden
```

Or in Nginx error log:
```
open() "/home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/main.js" 
failed (13: Permission denied)
```

**Root Cause:**

Nginx runs as user `www-data`, but your files are owned by `cladmin`. By default, `www-data` can't access files in user home directories.

**Visual Explanation:**

```
Your Home Directory: /home/cladmin  (permissions: drwx------) 
                                                     ↑
                                           Only owner can enter

Nginx (www-data): "I need to read files in there!"
System: "Access Denied ❌"
```

**Solution:**

Give `www-data` just enough permission to read files:

```bash
# Allow "others" to traverse directories (execute permission)
sudo chmod o+x /home/cladmin
sudo chmod o+x /home/cladmin/ncop_local
sudo chmod o+x /home/cladmin/ncop_local/ncop_local_prod

# Allow "others" to read files and traverse subdirectories
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
```

**What These Commands Do:**

- `o+x`: Lets "others" (including www-data) traverse the directory (walk through it)
- `o+rX`: Lets "others" read files + traverse directories (capital X only adds execute to dirs)

**Security Note:**

This is safe because:
- Only adds read permission to public web assets
- Doesn't allow writing or modifying
- Doesn't expose private files

**Verification:**

```bash
# Test if www-data can read a file
sudo -u www-data test -r /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/auth_login-y_ywPWRi.js && echo "✅ Can read" || echo "❌ Cannot read"

# Test asset loading
curl -I http://172.18.7.36/assets/auth_login-y_ywPWRi.js

# Should return: HTTP/1.1 200 OK
```

**Checking Permissions:**

```bash
# View directory permissions
ls -ld /home/cladmin
# Should show: drwxr-x--x  (others can execute)

ls -ld /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
# Should show: drwxr-xr-x  (others can read and execute)

ls -l /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/ | head -5
# Files should show: -rw-rw-r--  (others can read)
```

---

### 7.4 Manifest Path Errors

**Symptoms:**
```
DjangoViteAssetNotFoundError: Cannot find src/entries/auth_login.js 
for app=default in Vite manifest at /home/cladmin/ncop_local/frontend/dist/.vite/manifest.json
```

**Root Cause:**

Django can't find the Vite manifest file. This happens when:
1. Manifest path in settings is wrong
2. Vite build didn't run
3. Manifest file doesn't exist

**Diagnosis:**

```bash
cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.conf import settings
import os

path = settings.DJANGO_VITE['default']['manifest_path']
print(f"Manifest path: {path}")
print(f"Exists: {os.path.exists(path)}")
print(f"Expected: /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/.vite/manifest.json")
EOF
```

**Solution 1: Correct Manifest Path**

Edit prod.py:

```python
# Correct path (one .parent)
"manifest_path": BASE_DIR.parent / "frontend" / "dist" / ".vite" / "manifest.json",

# ❌ WRONG (two .parent):
# "manifest_path": BASE_DIR.parent.parent / "frontend" / "dist" / ".vite" / "manifest.json",
```

**Understanding BASE_DIR:**

```
BASE_DIR = /home/cladmin/ncop_local/ncop_local_prod/project
           (where manage.py lives)

BASE_DIR.parent = /home/cladmin/ncop_local/ncop_local_prod
                  ↓
                  + "frontend" / "dist" / ".vite" / "manifest.json"
                  ↓
Result: /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/.vite/manifest.json ✅
```

**Solution 2: Rebuild Vite Assets**

If manifest doesn't exist:

```bash
cd /home/cladmin/ncop_local/ncop_local_prod/frontend
rm -rf dist/
npm run build

# Verify
ls -la dist/.vite/manifest.json
cat dist/.vite/manifest.json | python3 -m json.tool | head -20
```

**Solution 3: Check Entry Points**

Verify your entry points exist:

```bash
# Check source files
ls -la /home/cladmin/ncop_local/ncop_local_prod/frontend/src/entries/

# Should show:
# auth_login.js
# auth_signup.js
# dashboard_main.js
# etc.
```

**Verification:**

```bash
cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.conf import settings
import os, json

manifest_path = settings.DJANGO_VITE['default']['manifest_path']

if os.path.exists(manifest_path):
    with open(manifest_path) as f:
        manifest = json.load(f)
    
    # Check for auth_login
    auth_entries = [k for k in manifest.keys() if 'auth_login' in k.lower()]
    print(f"✅ Manifest loaded")
    print(f"   Total entries: {len(manifest)}")
    print(f"   Auth entries: {auth_entries}")
else:
    print("❌ Manifest not found!")
EOF
```

---

### 7.5 Service Startup Problems

**Symptoms:**
```bash
sudo systemctl status ncop-waitress.service
# Shows: Failed / Inactive (dead)
```

**Diagnosis:**

```bash
# View detailed logs
sudo journalctl -u ncop-waitress.service -n 100 --no-pager

# Common error patterns to look for:
# - ModuleNotFoundError: Missing Python package
# - Address already in use: Port conflict
# - Permission denied: File access issues
# - Database connection errors: PostgreSQL not running
```

#### Problem 1: Port Already in Use

**Error in logs:**
```
OSError: [Errno 98] Address already in use
```

**Solution:**

```bash
# Find what's using port 8000
sudo lsof -i :8000

# Kill the process
sudo kill -9 <PID>

# Or change the port in service file
sudo nano /etc/systemd/system/ncop-waitress.service
# Change: --port=8000 to --port=8001

sudo systemctl daemon-reload
sudo systemctl restart ncop-waitress.service
```

#### Problem 2: Missing Python Packages

**Error in logs:**
```
ModuleNotFoundError: No module named 'django'
```

**Solution:**

```bash
# Activate environment
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Reinstall dependencies
cd /home/cladmin/ncop_local/ncop_local_prod/project
pip install -r requirements.txt

# Restart service
sudo systemctl restart ncop-waitress.service
```

#### Problem 3: Database Connection Failed

**Error in logs:**
```
django.db.utils.OperationalError: could not connect to server
```

**Solution:**

```bash
# Check PostgreSQL status
sudo systemctl status postgresql

# Start if stopped
sudo systemctl start postgresql

# Test connection
psql -U postgres -d ncop_prod -c "SELECT version();"

# Restart Waitress
sudo systemctl restart ncop-waitress.service
```

#### Problem 4: Wrong WSGI Module

**Error in logs:**
```
ModuleNotFoundError: No module named 'ncop_project.wsgi_prod'
```

**Solution:**

Check service file:

```bash
sudo nano /etc/systemd/system/ncop-waitress.service
```

Ensure correct WSGI path:
```ini
ExecStart=/home/cladmin/ncop_local/ncopenv311/bin/python -m waitress \
    --port=8000 \
    --host=127.0.0.1 \
    ncop_project.wsgi_prod:application
```

Reload and restart:
```bash
sudo systemctl daemon-reload
sudo systemctl restart ncop-waitress.service
```

---

### 7.6 Static File Loading Errors

**Symptoms:**
```
Browser console:
GET http://172.18.7.36/static/admin/css/base.css → 404 Not Found
```

**Root Cause:**

Django's static files weren't collected or Nginx can't find them.

**Diagnosis:**

```bash
# Check if collectstatic was run
ls -la /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/

# Should see:
# admin/
# rest_framework/
# gis/
# django_extensions/
```

**Solution 1: Run collectstatic**

```bash
cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Clean old files
rm -rf static/dist/

# Collect static files
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod

# Fix permissions
sudo chmod -R o+rX static/dist/

# Reload Nginx
sudo systemctl reload nginx
```

**Solution 2: Fix Nginx Path**

Check Nginx configuration:

```bash
sudo nano /etc/nginx/sites-available/ncop-prod
```

Verify the alias path:
```nginx
location /static/ {
    alias /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/;
    # NOT: /home/cladmin/ncop_local/ncop_local_prod/project/project/static/
}
```

Test and reload:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

**Solution 3: Check STATIC_ROOT**

Verify Django configuration:

```bash
cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate

python manage.py shell --settings=ncop_project.settings.prod << 'EOF'
from django.conf import settings
print(f"STATIC_ROOT: {settings.STATIC_ROOT}")
# Should be: /home/cladmin/ncop_local/ncop_local_prod/project/static/dist
EOF
```

**Verification:**

```bash
# Test Django admin CSS
curl -I http://172.18.7.36/static/admin/css/base.css

# Should return: HTTP/1.1 200 OK

# Test in browser
echo "Open in browser: http://172.18.7.36/admin/"
echo "The admin interface should be styled correctly"
```

---

### 7.7 Debugging Commands

**Quick Diagnostic Script:**

```bash
#!/bin/bash
# Save as: /home/cladmin/debug_prod.sh

echo "===== NCOP Production Diagnostics ====="
echo ""

# Service status
echo "=== Services ==="
systemctl is-active --quiet ncop-waitress.service && echo "✅ Waitress: Running" || echo "❌ Waitress: Stopped"
systemctl is-active --quiet nginx && echo "✅ Nginx: Running" || echo "❌ Nginx: Stopped"
systemctl is-active --quiet postgresql && echo "✅ PostgreSQL: Running" || echo "❌ PostgreSQL: Stopped"

# HTTP tests
echo -e "\n=== HTTP Tests ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://172.18.7.36/)
echo "Main app: HTTP $STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://172.18.7.36/login/)
echo "Login page: HTTP $STATUS"

# File checks
echo -e "\n=== File Structure ==="
test -d /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets && echo "✅ Vite assets exist" || echo "❌ Vite assets missing"
test -f /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/.vite/manifest.json && echo "✅ Manifest exists" || echo "❌ Manifest missing"
test -d /home/cladmin/ncop_local/ncop_local_prod/project/static/dist/admin && echo "✅ Django static collected" || echo "❌ Django static missing"

# Permission checks
echo -e "\n=== Permissions ==="
sudo -u www-data test -r /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/auth_login-y_ywPWRi.js 2>/dev/null && echo "✅ Nginx can read Vite assets" || echo "⚠️  Permission issue with Vite assets"

# Recent errors
echo -e "\n=== Recent Errors (last 5 min) ==="
ERROR_COUNT=$(sudo journalctl -u ncop-waitress.service --since "5 minutes ago" --no-pager 2>/dev/null | grep -i "error" | wc -l)
echo "Waitress errors: $ERROR_COUNT"

# Nginx error log
NGINX_ERRORS=$(sudo tail -20 /var/log/nginx/ncop_error.log 2>/dev/null | grep -c "error")
echo "Nginx errors (last 20 lines): $NGINX_ERRORS"

echo ""
echo "===== End Diagnostics ====="
```

Make it executable:
```bash
chmod +x /home/cladmin/debug_prod.sh
```

Run diagnostics:
```bash
/home/cladmin/debug_prod.sh
```

**View Logs in Real-Time:**

```bash
# Waitress logs (follow)
sudo journalctl -u ncop-waitress.service -f

# Nginx error log (follow)
sudo tail -f /var/log/nginx/ncop_error.log

# Nginx access log (follow)
sudo tail -f /var/log/nginx/ncop_access.log

# PostgreSQL logs
sudo tail -f /var/log/postgresql/postgresql-14-main.log
```

**Test Specific Components:**

```bash
# Test Django directly (bypass Nginx)
curl -I http://127.0.0.1:8000/

# Test specific asset
curl -I http://172.18.7.36/assets/dashboard_main-DQjo4yzw.css

# Test with verbose output
curl -v http://172.18.7.36/login/ 2>&1 | head -30

# Check DNS resolution
nslookup 172.18.7.36

# Check network connectivity
ping -c 3 172.18.7.36

# Check open ports
sudo netstat -tulpn | grep -E ':(80|8000)\s'
```

---

## Part VIII: Reference & Appendices

### 8.1 Service Management Commands

**Waitress (Django Application Server):**

```bash
# Status
sudo systemctl status ncop-waitress.service

# Start
sudo systemctl start ncop-waitress.service

# Stop
sudo systemctl stop ncop-waitress.service

# Restart (stop + start)
sudo systemctl restart ncop-waitress.service

# Enable (start on boot)
sudo systemctl enable ncop-waitress.service

# Disable (don't start on boot)
sudo systemctl disable ncop-waitress.service

# View logs (all)
sudo journalctl -u ncop-waitress.service

# View logs (last 50 lines)
sudo journalctl -u ncop-waitress.service -n 50

# View logs (follow/live)
sudo journalctl -u ncop-waitress.service -f

# View logs (since specific time)
sudo journalctl -u ncop-waitress.service --since "2025-11-12 10:00:00"

# View logs (last 1 hour)
sudo journalctl -u ncop-waitress.service --since "1 hour ago"
```

**Nginx (Web Server):**

```bash
# Status
sudo systemctl status nginx

# Start
sudo systemctl start nginx

# Stop
sudo systemctl stop nginx

# Restart (stop + start)
sudo systemctl restart nginx

# Reload (reload config without stopping)
sudo systemctl reload nginx

# Test configuration
sudo nginx -t

# Test and reload if valid
sudo nginx -t && sudo systemctl reload nginx

# View error log
sudo tail -f /var/log/nginx/ncop_error.log

# View access log
sudo tail -f /var/log/nginx/ncop_access.log

# View error log (last 50 lines)
sudo tail -50 /var/log/nginx/ncop_error.log

# Search error log for specific error
sudo grep "404" /var/log/nginx/ncop_error.log | tail -20
```

**PostgreSQL (Database):**

```bash
# Status
sudo systemctl status postgresql

# Start
sudo systemctl start postgresql

# Stop
sudo systemctl stop postgresql

# Restart
sudo systemctl restart postgresql

# Reload configuration
sudo systemctl reload postgresql

# Connect to database
psql -U postgres -d ncop_prod

# Check connections
sudo -u postgres psql -c "SELECT count(*) FROM pg_stat_activity;"

# View logs
sudo tail -f /var/log/postgresql/postgresql-14-main.log
```

**Combined Operations:**

```bash
# Restart all services
sudo systemctl restart postgresql
sudo systemctl restart ncop-waitress.service
sudo systemctl reload nginx

# Check all service status
echo "=== Service Status ==="
sudo systemctl status postgresql --no-pager | grep Active
sudo systemctl status ncop-waitress.service --no-pager | grep Active
sudo systemctl status nginx --no-pager | grep Active

# Stop all services
sudo systemctl stop nginx
sudo systemctl stop ncop-waitress.service
sudo systemctl stop postgresql

# Start all services
sudo systemctl start postgresql
sleep 2
sudo systemctl start ncop-waitress.service
sleep 2
sudo systemctl start nginx
```

---

### 8.2 Quick Deployment Commands

**For Experienced Users - Quick Reference:**

#### **Option A: Automated Deployment**

```bash
# Run automated script
/home/cladmin/deploy_prod.sh
```

#### **Option B: Manual Deployment (Copy-Paste)**

```bash
# Navigate and activate
cd /home/cladmin/ncop_local/ncop_local_prod && source /home/cladmin/ncop_local/ncopenv311/bin/activate

# Pull latest code
git pull origin stage-arsalan

# Build frontend
cd frontend && rm -rf dist/ && npm run build && cd ..

# Collect static
cd project && rm -rf static/dist/ && python manage.py collectstatic --noinput --settings=ncop_project.settings.prod && cd ..

# Fix permissions
sudo chmod -R o+rX frontend/dist project/static/dist

# Restart services
sudo systemctl restart ncop-waitress.service && sudo systemctl reload nginx

# Verify
sleep 3 && curl -I http://172.18.7.36/login/
```

#### **Option C: Step-by-Step (Detailed)**

```bash
# 1. Navigate to project
cd /home/cladmin/ncop_local/ncop_local_prod

# 2. Activate virtual environment
source /home/cladmin/ncop_local/ncopenv311/bin/activate

# 3. Pull latest code
git pull origin stage-arsalan

# 4. Build frontend assets
cd frontend
rm -rf dist/
npm run build
cd ..

# 5. Collect Django static files
cd project
rm -rf static/dist/
python manage.py collectstatic --noinput --settings=ncop_project.settings.prod
cd ..

# 6. Fix file permissions
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist
sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist

# 7. Restart Waitress
sudo systemctl restart ncop-waitress.service

# 8. Reload Nginx
sudo systemctl reload nginx

# 9. Verify deployment
sleep 3
curl -I http://172.18.7.36/login/
sudo journalctl -u ncop-waitress.service -n 20 --no-pager
```

#### **Verification Commands:**

```bash
# Check services
sudo systemctl is-active ncop-waitress.service nginx postgresql

# Test HTTP
curl -I http://172.18.7.36/

# Check for errors
sudo journalctl -u ncop-waitress.service --since "5 minutes ago" | grep -i error || echo "No errors"

# Test assets
curl -I http://172.18.7.36/assets/auth_login-y_ywPWRi.js
curl -I http://172.18.7.36/static/admin/css/base.css
```

---

### 8.3 Configuration Files Reference

**Key Configuration Files:**

| File | Location | Purpose |
|------|----------|---------|
| **Django Settings (Production)** | `/home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings/prod.py` | Main production settings |
| **Nginx Configuration** | `/etc/nginx/sites-available/ncop-prod` | Web server config |
| **Nginx Symlink** | `/etc/nginx/sites-enabled/ncop-prod` | Active config symlink |
| **Waitress Service** | `/etc/systemd/system/ncop-waitress.service` | Systemd service file |
| **Environment Variables** | `/home/cladmin/ncop_local/ncop_local_prod/.env` | Secret keys, passwords |
| **Vite Configuration** | `/home/cladmin/ncop_local/ncop_local_prod/frontend/vite.config.js` | Frontend build config |
| **Python Dependencies** | `/home/cladmin/ncop_local/ncop_local_prod/project/requirements.txt` | Python packages |
| **Node Dependencies** | `/home/cladmin/ncop_local/ncop_local_prod/frontend/package.json` | Node packages |

**Viewing Configurations:**

```bash
# View Django settings
cat /home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings/prod.py | less

# View Nginx config
sudo cat /etc/nginx/sites-available/ncop-prod | less

# View Waitress service
sudo cat /etc/systemd/system/ncop-waitress.service

# View environment variables (be careful with passwords!)
cat /home/cladmin/ncop_local/ncop_local_prod/.env

# View Vite config
cat /home/cladmin/ncop_local/ncop_local_prod/frontend/vite.config.js
```

**Editing Configurations:**

```bash
# Edit Django settings
nano /home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings/prod.py

# Edit Nginx config
sudo nano /etc/nginx/sites-available/ncop-prod

# Edit Waitress service
sudo nano /etc/systemd/system/ncop-waitress.service

# After editing service file:
sudo systemctl daemon-reload
sudo systemctl restart ncop-waitress.service

# After editing Nginx config:
sudo nginx -t
sudo systemctl reload nginx
```

---

### 8.4 File Locations & Paths

**Production Server:**
- **IP Address**: 172.18.7.36
- **User**: cladmin
- **Home Directory**: /home/cladmin

**Project Directories:**

```bash
# Main project directory
/home/cladmin/ncop_local/ncop_local_prod/

# Python virtual environment
/home/cladmin/ncop_local/ncopenv311/

# Frontend source code
/home/cladmin/ncop_local/ncop_local_prod/frontend/src/

# Frontend built assets (created by npm run build)
/home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/

# Vite manifest file
/home/cladmin/ncop_local/ncop_local_prod/frontend/dist/.vite/manifest.json

# Django backend code
/home/cladmin/ncop_local/ncop_local_prod/project/

# Django settings
/home/cladmin/ncop_local/ncop_local_prod/project/ncop_project/settings/

# Django collected static files (created by collectstatic)
/home/cladmin/ncop_local/ncop_local_prod/project/static/dist/

# Django templates
/home/cladmin/ncop_local/ncop_local_prod/project/templates/

# User-uploaded media files
/home/cladmin/ncop_local/ncop_local_prod/project/media/
```

**System Directories:**

```bash
# Nginx configuration
/etc/nginx/sites-available/ncop-prod
/etc/nginx/sites-enabled/ncop-prod

# Nginx logs
/var/log/nginx/ncop_access.log
/var/log/nginx/ncop_error.log

# Systemd service files
/etc/systemd/system/ncop-waitress.service

# PostgreSQL data
/var/lib/postgresql/14/main/

# PostgreSQL logs
/var/log/postgresql/postgresql-14-main.log
```

**URL to Filesystem Mapping:**

| URL Path | Nginx Serves From | Contains |
|----------|-------------------|----------|
| `/assets/*` | `frontend/dist/assets/` | React JS, CSS, images (Vite) |
| `/static/assets/*` | `frontend/dist/assets/` | Same as above (backwards compatible) |
| `/static/*` | `project/static/dist/` | Django admin, DRF assets |
| `/media/*` | `project/media/` | User uploads |
| `/*` | → Waitress → Django | Dynamic pages |

---

### 8.5 Python Dependencies

**Main Dependencies (from requirements.txt):**

#### Core Django Framework
```
Django==5.1                     # Web framework
djangorestframework==3.15.2     # RESTful API toolkit
django-environ==0.11.2          # Environment variable management
django-vite==3.0.4              # Vite integration
django-cors-headers==4.4.0      # CORS handling
```

#### Database & ORM
```
psycopg2-binary==2.9.9          # PostgreSQL adapter
sqlalchemy==2.0.23              # SQL toolkit (optional)
```

#### Geospatial Libraries
```
GDAL==3.8.x                     # Geospatial Data Abstraction Library
geopandas==1.1.1                # Pandas for geospatial data
pyproj==3.6.1                   # Cartographic projections
shapely==2.0.6                  # Geometric operations
mercantile==1.2.1               # Web mercator projection
```

#### Data Processing
```
numpy==2.1.0                    # Numerical computing
```

#### HTTP & Networking
```
requests==2.32.3                # HTTP library
httpx==0.28.1                   # Async HTTP client
```

#### Static Files & Asset Serving
```
whitenoise==6.7.0               # Static file serving
```

#### WSGI Servers
```
waitress==2.1.2                 # Production WSGI server
gunicorn==23.0.0                # Alternative WSGI server
```

#### Caching (Optional)
```
django-redis==5.4.0             # Redis cache backend
redis==5.0.1                    # Redis Python client
```

**Installing Dependencies:**

```bash
# Full installation
cd /home/cladmin/ncop_local/ncop_local_prod/project
source /home/cladmin/ncop_local/ncopenv311/bin/activate
pip install -r requirements.txt

# Install specific package
pip install django-redis==5.4.0

# Upgrade specific package
pip install --upgrade whitenoise

# List installed packages
pip list

# Show package details
pip show django

# Check for outdated packages
pip list --outdated
```

---

### 8.6 JavaScript Module Documentation

**Frontend Structure:**

The NCOP frontend is built with vanilla JavaScript (no React framework) and Vite for bundling.

#### Entry Points

**Location**: `frontend/src/entries/`

| File | Purpose | Loads On |
|------|---------|----------|
| `auth_login.js` | Login page functionality | /login/ |
| `auth_signup.js` | Signup page functionality | /signup/ |
| `auth_reset.js` | Password reset request | /reset/ |
| `auth_reset_confirm.js` | Password reset confirmation | /reset-confirm/ |
| `dashboard_main.js` | Main dashboard application | /dashboard/ |

#### Core Modules

**Location**: `frontend/src/modules/`

**Map & Visualization:**

| Module | Purpose |
|--------|---------|
| `map-layers.js` | Manages map layers (add, remove, toggle visibility) |
| `time-slider-functionality.js` | Controls time slider for temporal data |
| `temporal-layer-legends.js` | Displays color legends for map layers |
| `layer-attribute-popup.js` | Shows popup with feature attributes on click |
| `layer-info-panel.js` | Displays layer metadata and descriptions |
| `layer-order-control.js` | Changes layer stacking order |
| `basemap-panel.js` | Switches between basemap options |

**User Interface:**

| Module | Purpose |
|--------|---------|
| `sidebar-menu.js` | Controls sidebar navigation and panels |
| `navigation-panel.js` | Map navigation controls (zoom, pan, home) |
| `dashboard.js` | Main dashboard layout and initialization |
| `utility-manager.js` | Helper functions used across modules |

**Module Communication:**

Modules communicate through:
1. **Direct imports**: `import { function } from './module.js'`
2. **Event listeners**: Custom events for loose coupling
3. **Shared state**: Global objects for map state, active layers, etc.

**Example Module Flow:**

```
User clicks time slider
       ↓
time-slider-functionality.js
       ↓
Updates current time value
       ↓
Emits 'timeChanged' event
       ↓
map-layers.js listens and updates map
       ↓
temporal-layer-legends.js listens and updates legend
       ↓
Display refreshes with new time data
```

**Adding New Modules:**

1. Create new file in `frontend/src/modules/`
2. Export functions: `export function myFunction() { ... }`
3. Import in entry point: `import { myFunction } from '../modules/myModule.js'`
4. Rebuild: `npm run build`

---

## Appendix A: Complete File Listings

### A.1 Production Settings (prod.py)

**Complete, production-ready Django settings file:**

See [Part IV, Section 4.3](#43-django-configuration) for the full file.

### A.2 Nginx Configuration

**Complete, production-ready Nginx configuration:**

See [Part IV, Section 4.4](#44-nginx-configuration) for the full file.

### A.3 Waitress Service File

**Complete systemd service file:**

See [Part IV, Section 4.5](#45-waitress-service-configuration) for the full file.

---

## Appendix B: Environment Variables

**Complete .env file template:**

```bash
# =====================================================
# NCOP Production Environment Variables
# =====================================================

# Django Core
DJANGO_SECRET_KEY=your-secret-key-min-50-chars-random-string-here
DJANGO_DEBUG=False
DJANGO_ALLOWED_HOSTS=172.18.7.36,localhost,127.0.0.1

# Database Configuration
POSTGRES_DB=ncop_prod
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-secure-database-password
POSTGRES_HOST=localhost
POSTGRES_PORT=5432

# Vite Configuration
VITE_DEV_MODE=false
VITE_DEV_SERVER_HOST=localhost
VITE_DEV_SERVER_PORT=5173

# CORS Configuration
CORS_ALLOW_ALL_ORIGINS=False
CORS_ALLOWED_ORIGINS=http://172.18.7.36,http://localhost

# Email Configuration (Optional)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=True
EMAIL_HOST_USER=your-email@gmail.com
EMAIL_HOST_PASSWORD=your-app-specific-password

# API Keys (Optional)
MAPBOX_ACCESS_TOKEN=pk.your_mapbox_token_here
METEOBLUE_TOKEN=your_meteoblue_api_key
WAQI_API_TOKEN=your_waqi_api_token

# Redis Cache (Optional)
REDIS_URL=redis://127.0.0.1:6379/1

# Security
OAUTHLIB_INSECURE_TRANSPORT=1
```

**Generating a Secret Key:**

```bash
python -c 'from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())'
```

---

## Appendix C: Deployment Checklist

**Pre-Deployment:**
- [ ] Pull latest code from stage-arsalan
- [ ] Review changes: `git log --oneline -10`
- [ ] Check requirements.txt for new dependencies
- [ ] Backup database: `pg_dump ncop_prod > backup.sql`
- [ ] Backup .env file
- [ ] Notify team of deployment window

**Deployment Steps:**
- [ ] Activate virtual environment
- [ ] Install/update Python dependencies
- [ ] Install/update Node dependencies
- [ ] Build Vite assets (`npm run build`)
- [ ] Run database migrations
- [ ] Collect static files (`collectstatic`)
- [ ] Build NCOP Assistant knowledge base (`ingest_chat_knowledge`) — REQUIRED
      on first deploy of this feature and after any edit to CONTEXT.md/the
      other root docs/map-layers.js; also warms the ~90MB ONNX embedding
      model cache on THIS machine so the first real user chat message isn't
      the one paying that download — see project/ncop_internal/chat_engine.py
- [ ] Fix file permissions
- [ ] Restart Waitress service
- [ ] Reload Nginx
- [ ] Wait 5 seconds for stabilization

**Post-Deployment Verification:**
- [ ] Services running (Waitress, Nginx, PostgreSQL)
- [ ] HTTP 200 on main page
- [ ] HTTP 200 on login page
- [ ] Assets loading (check /assets/* paths)
- [ ] Django admin accessible and styled
- [ ] No errors in logs (last 5 minutes)
- [ ] Database connections working
- [ ] Dashboard loads correctly
- [ ] Test critical user flows

**Rollback Plan (if needed):**
- [ ] Note current git commit: `git rev-parse HEAD`
- [ ] Keep previous build in `frontend/dist.backup/`
- [ ] Keep previous static in `static/dist.backup/`
- [ ] To rollback: `git checkout <previous-commit>`
- [ ] Restore backups and restart services

---

## Appendix D: Monitoring & Maintenance

### Daily Health Checks

```bash
# Quick health check script
cat > /home/cladmin/health_check.sh << 'EOF'
#!/bin/bash
echo "NCOP Health Check - $(date)"
echo ""

# Services
systemctl is-active --quiet ncop-waitress.service && echo "✅ Waitress" || echo "❌ Waitress"
systemctl is-active --quiet nginx && echo "✅ Nginx" || echo "❌ Nginx"
systemctl is-active --quiet postgresql && echo "✅ PostgreSQL" || echo "❌ PostgreSQL"

# HTTP
curl -s -o /dev/null -w "HTTP Response: %{http_code}\n" http://172.18.7.36/

# Disk space
df -h / | tail -1 | awk '{print "Disk Usage: " $5}'

# Errors
ERROR_COUNT=$(sudo journalctl -u ncop-waitress.service --since "1 hour ago" 2>/dev/null | grep -i "error" | wc -l)
echo "Errors (last hour): $ERROR_COUNT"
EOF

chmod +x /home/cladmin/health_check.sh
```

### Weekly Maintenance

```bash
# Backup database
sudo -u postgres pg_dump ncop_prod > /home/cladmin/backups/ncop_prod_$(date +%Y%m%d).sql

# Rotate logs
sudo logrotate /etc/logrotate.d/nginx

# Check for package updates
pip list --outdated
npm outdated
```

### Monthly Maintenance

```bash
# Update system packages
sudo apt update
sudo apt upgrade

# Clean old logs (older than 30 days)
sudo find /var/log/ -name "*.log.*" -mtime +30 -delete

# Vacuum database
sudo -u postgres psql -d ncop_prod -c "VACUUM ANALYZE;"

# Check disk usage
du -sh /home/cladmin/ncop_local/ncop_local_prod/*
```

---

## Appendix E: Security Hardening

### SSL/HTTPS Setup (Future)

When ready to enable HTTPS:

1. **Obtain SSL Certificate:**
```bash
# Using Let's Encrypt (free)
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

2. **Update Django Settings:**
```python
# In prod.py
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
```

3. **Update Nginx:**
```nginx
# Certbot will automatically update, or manually add:
listen 443 ssl http2;
ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
```

### Firewall Configuration

```bash
# Enable UFW firewall
sudo ufw enable

# Allow SSH
sudo ufw allow 22/tcp

# Allow HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Check status
sudo ufw status
```

### Database Security

```bash
# Create restricted database user
sudo -u postgres psql << EOF
CREATE USER ncop_prod_user WITH PASSWORD 'secure-password';
GRANT CONNECT ON DATABASE ncop_prod TO ncop_prod_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ncop_prod_user;
EOF

# Update .env
POSTGRES_USER=ncop_prod_user
POSTGRES_PASSWORD=secure-password
```

---

## Appendix F: Performance Optimization

### Nginx Caching

Add to Nginx config:

```nginx
# Define cache zones
proxy_cache_path /var/cache/nginx levels=1:2 keys_zone=ncop_cache:10m max_size=1g inactive=60m use_temp_path=off;

server {
    # Enable caching for static assets
    location /assets/ {
        alias /home/cladmin/ncop_local/ncop_local_prod/frontend/dist/assets/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # Cache API responses
    location /api/ {
        proxy_cache ncop_cache;
        proxy_cache_valid 200 10m;
        proxy_cache_key $uri$is_args$args;
        add_header X-Cache-Status $upstream_cache_status;
        
        proxy_pass http://waitress_app;
    }
}
```

### Database Query Optimization

```python
# In views.py, use select_related for foreign keys
queryset = Model.objects.select_related('related_model').all()

# Use prefetch_related for many-to-many
queryset = Model.objects.prefetch_related('many_to_many_field').all()

# Add database indexes
class Meta:
    indexes = [
        models.Index(fields=['frequently_queried_field']),
    ]
```

### Redis Caching

Enable Redis in prod.py:

```python
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": "redis://127.0.0.1:6379/1",
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        }
    }
}

# Cache database queries
from django.core.cache import cache
result = cache.get('key')
if not result:
    result = expensive_query()
    cache.set('key', result, timeout=3600)
```

---

## Appendix G: Backup & Recovery

### Automated Backup Script

```bash
#!/bin/bash
# Save as: /home/cladmin/backup_prod.sh

BACKUP_DIR="/home/cladmin/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Database backup
sudo -u postgres pg_dump ncop_prod | gzip > "$BACKUP_DIR/db_$DATE.sql.gz"

# Code backup
tar -czf "$BACKUP_DIR/code_$DATE.tar.gz" /home/cladmin/ncop_local/ncop_local_prod/

# Media files backup
tar -czf "$BACKUP_DIR/media_$DATE.tar.gz" /home/cladmin/ncop_local/ncop_local_prod/project/media/

# Keep only last 7 days of backups
find "$BACKUP_DIR" -name "*.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

### Restore from Backup

```bash
# Restore database
gunzip < backup.sql.gz | sudo -u postgres psql ncop_prod

# Restore code
tar -xzf code_backup.tar.gz -C /

# Restore media
tar -xzf media_backup.tar.gz -C /

# Restart services
sudo systemctl restart ncop-waitress.service nginx
```

---

## Appendix H: Contact & Support

### NDMA GCOP Tech Team

**Organization**: National Disaster Management Authority (NDMA)  
**Division**: GCOP (Global Climate & Operations Platform)  
**Location**: Islamabad, Pakistan

**Technical Support:**
- For deployment issues, contact: DevOps Team
- For application bugs, contact: Development Team
- For infrastructure, contact: System Administration

**Documentation:**
- This handbook: NCOP Production Deployment Handbook v2.0
- Internal wiki: [URL if applicable]
- Code repository: GitHub (internal)

### Useful Resources

- Django Documentation: https://docs.djangoproject.com/
- Vite Documentation: https://vitejs.dev/
- Nginx Documentation: https://nginx.org/en/docs/
- PostgreSQL Documentation: https://www.postgresql.org/docs/
- Ubuntu Server Guide: https://ubuntu.com/server/docs

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2025-11-10 | Initial production deployment | GCOP Tech Team |
| 2.0 | 2025-11-12 | Complete handbook with troubleshooting | GCOP Tech Team |

---

<div style="text-align: center; margin-top: 50px; padding: 20px; border-top: 2px solid #ccc;">

**National Disaster Management Authority (NDMA)**  
**GCOP Tech Team**

*This document is confidential and intended for internal use only.*

Document ID: NCOP-PROD-HANDBOOK-v2.0  
Classification: Internal  
Distribution: GCOP Tech Team, System Administrators

</div>

---

**END OF HANDBOOK**
