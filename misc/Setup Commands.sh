# To take the latest pull from main dev dm arsalan to keep your branch updated
git pull origin dev-arsalan
# Setup the environment (python version=3.11)
winget install Python.Python.3.11
# Confirm installation
py -3.11 --version
# Create virtual environment
py -3.11 -m venv ncopenv311
ncopenv311/Scripts/activate
# Deactivate the environment
deactivate

# Install required python modules
pip install -r requirements.txt
# Compatible GDAL wheel download link
DOWNLOAD_URL="https://github.com/arsalanmukhtar/ncop_local/blob/dev-arsalan/misc/GDAL-3.4.3-cp311-cp311-win_amd64.whl"

# Install postgresql and postgis if not installed  and setup database on postgresql (SQL Shell or pgAdmin) for dev-ahadkhan
PS C:\Users\7987sarim> psql -U postgres
Password for user postgres:

# ================================ Welcome to psql 14.11 ================================ #
psql (14.11)
WARNING: Console code page (437) differs from Windows code page (1252)
         8-bit characters might not work correctly. See psql reference
         page "Notes for Windows users" for details.
Type "help" for help.

postgres=# CREATE DATABASE dev-ahadkhan;
postgres=# CREATE EXTENSION postgis;
postgres=# CREATE EXTENSION pg_trgm;
postgres=# CREATE EXTENSION hstore;
# ================================ Goodbye from psql 14.11 =============================== #

# Add paths in the terminal environment variables. NOTE: You may need to find right path of OSGeo4W installation on your system.
# Paths for dev-arsalan
setx GDAL_LIBRARY_PATH "C:\OSGeo4W\bin\gdal311.dll"
setx GEOS_LIBRARY_PATH "C:\OSGeo4W\bin\geos_c.dll"
setx PROJ_LIB "C:\OSGeo4W\share\proj"
setx PATH "$($env:PATH);C:\OSGeo4W\bin"
# Add this is project settings.py
GDAL_LIBRARY_PATH = r'C:\OSGeo4W\bin\gdal311.dll'
GEOS_LIBRARY_PATH = r'C:\OSGeo4W\bin\geos_c.dll'
# Test your GDAL binaries setup
(ncopenv311) PS D:\muhammad_arsalan\ncop_v1\ncop_local\ncopenv311\Lib\site-packages\GDAL-3.4.3.dist-info\bin> python -c "from osgeo import gdal; print(gdal.__version__)"

# -------------------------- #
# Paths for dev-ahadkhan
setx GDAL_LIBRARY_PATH "C:\Program Files\QGIS 3.32.3\bin\gdal307.dll"
setx GEOS_LIBRARY_PATH "C:\Program Files\QGIS 3.32.3\bin\geos_c.dll"
setx PROJ_LIB "C:\Program Files\QGIS 3.32.3\share\proj"
setx PATH "$($env:PATH);C:\Program Files\QGIS 3.32.3\bin"

# Add this is project settings.py
GDAL_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\gdal307.dll'
GEOS_LIBRARY_PATH = r'C:\Program Files\QGIS 3.32.3\bin\geos_c.dll'

# Test your GDAL binaries setup in env terminal
(ncopenv311) python -c "from osgeo import gdal; print(gdal.VersionInfo('--version'))"
# Console output: (3, 4, 3) --> Works perfect

# Install node service
# Download and install nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# in lieu of restarting the shell
\. "$HOME/.nvm/nvm.sh"
# Download and install Node.js:
nvm install 22
# Verify the Node.js version:
node -v # Should print "v22.20.0".
# Verify npm version:
npm -v # Should print "10.9.3".

# ======================================== SETTING UP THE PROJECT AND SERVER ======================================== #
# Terminal prompts
.\ncopenv311\Scripts\activate
cd .\project\
# Initial setup and only when database changes are made
python manage.py makemigrations
python manage.py migrate

# Create superuser for admin panel (only if required)
python manage.py createsuperuser

# Starting the server
python manage.py runserver

# Starting vite for frontend assets
cd \ncop_local\frontend>
npm install
npm run dev

# =========================================== NDMA Github Portal Push Commands =========================================== #

# Clone the repo
git clone https://github.com/developerndma/summer.git
cd summer
# Make developer folder
mkdir ibrahim-abdullah
# Add a README.md file so that new folder is not empty
echo "# Ibrahim Abdullah workspace" > ibrahim-abdullah/README.md
# Commit the new developer folder
git add ibrahim-abdullah
git commit -m "Added ibrahim-abdullah folder"
# Push to the main branch
git push origin main

# Before inserting collaborators code make sure to update main
git pull origin main
# Change to developer folder
cd ibrahim-abdullah
# Clone collaborators repo into this folder and specify the folder name at the end for github
git clone https://github.com/Ibrahom1/hydroanalytics-portal-.git hydroanalytics-portal
# Navigate to repo folder and check for origins
git remote -v
# origin  https://github.com/developerndma/summer.git (fetch)
# origin  https://github.com/developerndma/summer.git (push)
# If above does not show then do this
git remote set-url origin https://github.com/developerndma/summer.git
# Stage the changes of newly added portal but before that delete the inner git folder of this portal
git rm --cached ibrahim-abdullah/hydroanalytics-portal
git add ibrahim-abdullah/hydroanalytics-portal/*
# Commit the changes now
git commit -m "Added Ibrahim Abdullah hydroanalytics-portal"
# Push the changes in main branch
git push origin main

# END OF SETUP COMMANDS.SH