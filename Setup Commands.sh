# Setup the environment
sudo apt update
sudo apt install python3-venv -y

# Install GDAL and its dependencies for ubuntu
sudo add-apt-repository ppa:ubuntugis/ppa && sudo apt-get update
sudo apt-get update
sudo apt-get install gdal-bin
sudo apt-get install libgdal-dev
export CPLUS_INCLUDE_PATH=/usr/include/gdal
export C_INCLUDE_PATH=/usr/include/gdal
# Install gdal but if there is some error just ignore it
pip install GDAL

# Install gdal and its dependencies for windows using OsGeo4W and wheel file
DOWNLOAD_URL="https://github.com/arsalanmukhtar/ncop_local/blob/dev-arsalan/GDAL-3.4.3-cp311-cp311-win_amd64.whl"

# Add paths in the terminal environment variables
setx GDAL_LIBRARY_PATH "C:\OSGeo4W\bin\gdal311.dll"
setx GEOS_LIBRARY_PATH "C:\OSGeo4W\bin\geos_c.dll"
setx PROJ_LIB "C:\OSGeo4W\share\proj"
setx PATH "$($env:PATH);C:\OSGeo4W\bin"

# Add this is project settings.py
GDAL_LIBRARY_PATH = r'C:\OSGeo4W\bin\gdal311.dll'
GEOS_LIBRARY_PATH = r'C:\OSGeo4W\bin\geos_c.dll'

# Adjust the GDAL_LIBRARY_PATH in project settings.py accordingly at the top
import os
os.environ['GDAL_LIBRARY_PATH'] = r"D:\muhammad_arsalan\ncop_v1\ncop_local\ncopenv311\Lib\site-packages\GDAL-3.4.3.dist-info\bin\gdal304.dll"
os.environ['PROJ_LIB'] = r"D:\muhammad_arsalan\ncop_v1\ncop_local\ncopenv311\Lib\site-packages\GDAL-3.4.3.dist-info\bin\proj7"
os.environ['PATH'] += os.pathsep + r"D:\muhammad_arsalan\ncop_v1\ncop_local\ncopenv311\Lib\site-packages\GDAL-3.4.3.dist-info\bin"
# Test your GDAL binaries setup
(ncopenv311) PS D:\muhammad_arsalan\ncop_v1\ncop_local\ncopenv311\Lib\site-packages\GDAL-3.4.3.dist-info\bin> python -c "from django.contrib.gis import gdal; print(gdal.GDAL_VERSION)"
# Console output: (3, 4, 3) --> Works perfect

# Install postgresql and postgis
sudo apt update
sudo apt install postgresql postgresql-contrib -y
sudo apt install postgis postgresql-14-postgis-3 -y

# Start the postgresql service
sudo systemctl enable postgresql
sudo service postgresql restart

# Allow windows to access WSL IP
sudo nano /etc/postgresql/14/main/postgresql.conf
# listen_addresses = '*'
sudo nano /etc/postgresql/14/main/pg_hba.conf
# Database administrative login by Unix domain socket
local   all             postgres                                peer

# "local" is for Unix domain socket connections only
local   all             all                                     peer

# IPv4 local connections:
host    all             all             127.0.0.1/32           md5
host    all             all             0.0.0.0/0              md5   # optional, allows all IPs

# IPv6 local connections:
host    all             all             ::1/128                scram-sha-256

# Allow replication connections
local   replication     all                                     peer
host    replication     all             127.0.0.1/32          scram-sha-256
host    replication     all             ::1/128                scram-sha-256

# Start the postgresql service to take effect
sudo service postgresql start

# Now install and activate the environment
sudo apt install python3.10-venv
python3 -m venv --system-site-packages djangoenv
source djangoenv/bin/activate

# Install python modules
pip install -r requirements.txt

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