#!/bin/bash

echo "======================================"
echo "STARTING MOBILE APP - DEVELOPMENT"
echo "======================================"

cd /home/gtechapp/ncop_app/ncop_local/project

# Checkout mobile-app branch
git checkout mobile-app
git pull origin mobile-app

# Activate venv
source /home/gtechapp/ncop_app/ncopenv311/bin/activate

# Set environment
export DJANGO_SETTINGS_MODULE=ncop_project.settings.mobile_dev
export $(grep -v '^#' /home/gtechapp/ncop_app/ncop_local/.env.mobile-dev | xargs)

# Install dependencies if needed
pip install -r requirements.txt --quiet

# Run migrations
python manage.py migrate --noinput

# Create logs directory
mkdir -p logs

echo ""
echo "✅ Development server starting..."
echo "   Local:   http://127.0.0.1:8000"
echo "   Network: http://182.188.28.163:8000"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Start server
python manage.py runserver 0.0.0.0:8000