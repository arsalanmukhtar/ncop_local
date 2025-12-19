# Ubuntu Production Environment Setup (Python 3.11 + GDAL + Virtual Environment)

This document explains, in simple and clear language, how we prepared a clean Ubuntu system to run our NCOP project environment using Python 3.11, GDAL (geospatial library), and a dedicated virtual environment (`ncopenv311`). Everything here is written in a straightforward, human‑friendly style — no unnecessary technical jargon.

---

## 1. Understanding the Goal

Ubuntu comes with Python 3.10 by default. Our project, however, requires Python 3.11 along with GDAL and many related geospatial libraries.

Instead of replacing the system Python (which is dangerous and can break Ubuntu), we **keep Python 3.10 untouched** and simply **add Python 3.11 separately**. Then we create a project‑specific environment where all tools and libraries are installed cleanly.

So, after setup:

* System Python (3.10) remains untouched — safe.
* Project Python (3.11) lives inside our custom environment — clean and isolated.
* GDAL is installed in a way that works smoothly with Python 3.11.
* All required project libraries are installed inside the virtual environment.

---

## 2. System Requirements

We are working on an Ubuntu system located at:

```
/ (root filesystem) — about 48 GB total, with plenty of free space
```

So installation space is not an issue.

---

## 3. Installing Python 3.11 on Ubuntu

Ubuntu does not include Python 3.11 by default. So we add one official trusted source (called a “PPA”) that provides this.

```
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install -y python3.11 python3.11-venv python3.11-dev
```

Now we check:

```
python3.11 -V
```

Expected Output:

```
Python 3.11.x
```

We do **not** replace `python3`, we just add `python3.11` alongside it.

---

## 4. Installing GDAL System Libraries

GDAL is a geospatial library required for reading maps, satellite data, shapefiles, raster layers, and so on. It needs to be installed at the system level first.

We use UbuntuGIS PPA because it provides a newer GDAL version compatible with our project.

```
sudo add-apt-repository -y ppa:ubuntugis/ppa
sudo apt-get update
sudo apt-get install -y gdal-bin libgdal-dev build-essential pkg-config
```

Check version:

```
gdalinfo --version
```

Expected example output:

```
GDAL 3.8.x, released 2024/xx/xx
```

This confirms GDAL is successfully installed.

---

## 5. Creating the Project Virtual Environment

We create a new environment **inside the project directory**:

```
cd ~/ncop_local
python3.11 -m venv ncopenv311
source ncopenv311/bin/activate
```

When the environment is active, your terminal will show:

```
(ncopenv311) cladmin@controllayer:~$
```

This means anything you install now stays inside this environment and does not affect the system.

---

## 6. Preparing to Install GDAL for Python

We now tell Python where to find the GDAL libraries already installed on the system.

Run inside the activated environment:

```
export CPLUS_INCLUDE_PATH=/usr/include/gdal
export C_INCLUDE_PATH=/usr/include/gdal
export GDAL_CONFIG=/usr/bin/gdal-config
```

These ensure the Python GDAL package builds correctly.

---

## 7. Installing GDAL for Python (Important Step)

Inside the environment:

```
pip install --upgrade pip setuptools wheel
pip install "GDAL==$(gdal-config --version)"
```

This ensures Python GDAL matches **exactly** the system GDAL version.

Verify:

```
python - << 'EOF'
from osgeo import gdal
print("GDAL Loaded Successfully ✅ Version:", gdal.VersionInfo())
EOF
```

If it prints a version number without error → success.

---

## 8. Preparing and Installing Project Requirements

The project has a `requirements.txt` file.
However, it contained a **Windows-only GDAL wheel line**, which we remove.

So we generate a Linux-friendly version:

```
grep -v -i '^# GDAL' requirements.txt | grep -v -i 'GDAL @ file:///' > requirements.linux.txt
```

Then we add the correct GDAL version we already installed:

```
echo "GDAL==$(gdal-config --version)" >> requirements.linux.txt
```

Now install all dependencies:

```
pip install -r requirements.linux.txt
```

This installs:

* Django
* GeoPandas
* Shapely
* PyProj
* PostgreSQL adapters
* Redis client
* Web / HTTP client modules
* Everything else the project uses

---

## 9. Verifying Everything Works

```
python - << 'EOF'
from osgeo import gdal
gdal.UseExceptions()
print("GDAL Working ✅")
EOF
```

Also check GDAL command-line tool:

```
gdalinfo --version
```

If both work → your environment is ready.

---

## 10. How to Use This Environment Daily

### Activate the environment:

```
cd ~/ncop_local
source ncopenv311/bin/activate
```

### Run your Django app normally:

```
python manage.py runserver
```

### Deactivate when finished:

```
deactivate
```

---

## 11. Summary (What We Achieved)

| Component            | Version / Status              | Purpose                                          |
| -------------------- | ----------------------------- | ------------------------------------------------ |
| Ubuntu System Python | 3.10 (untouched)              | Required by OS — we leave it alone               |
| Project Python       | 3.11 (in virtual environment) | Used for NCOP project and dependencies           |
| GDAL (system)        | Installed from UbuntuGIS      | Provides core geospatial tools                   |
| GDAL (Python)        | Installed in ncopenv311       | Allows Python code to interact with spatial data |
| Virtual Environment  | `~/ncop_local/ncopenv311`     | Keeps everything isolated and stable             |

The environment is now clean, stable, and ready for production deployment.

---

If needed later, we can also add:

* Gunicorn service files
* Reverse proxy setup (Nginx)
* Systemd auto-restart service
* Logging and monitoring

Just ask 🙂
