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

# Create logs directory
mkdir -p logs

echo ""
echo "⚠️  IMPORTANT: You need TWO terminals for dev mode:"
echo ""
echo "Terminal 1 (this one) - Django:"
echo "   http://172.18.7.39:8000"
echo ""
echo "Terminal 2 (open new terminal) - Vite:"
echo "   cd /home/gtechapp/ncop_app/ncop_local/frontend"
echo "   source /home/gtechapp/ncop_app/ncopenv311/bin/activate"
echo "   npm run dev -- --host 0.0.0.0"
echo ""
read -p "Press Enter when Vite server is running in Terminal 2..."

echo ""
echo "🔍 Checking Vite server..."
if curl -s http://172.18.7.39:5173/ > /dev/null 2>&1; then
    echo "✅ Vite server is accessible at http://172.18.7.39:5173/"
else
    echo "❌ WARNING: Vite server NOT accessible at http://172.18.7.39:5173/"
    echo "   Make sure Terminal 2 is running: npm run dev -- --host 0.0.0.0"
    echo "   Waiting 5 seconds before starting Django anyway..."
    sleep 5
fi

echo ""
echo "✅ Starting Django development server..."
echo "   Access your app at: http://172.18.7.39:8000/"
echo ""

# Start Django server
python manage.py runserver 0.0.0.0:8000