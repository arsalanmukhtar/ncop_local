#!/bin/bash

set -e  # Exit on any error

echo "======================================"
echo "DEPLOYING TO MOBILE PRODUCTION"
echo "======================================"

cd /home/gtechapp/ncop_app/ncop_local/project

# Safety check: Are you sure?
echo ""
echo "⚠️  This will deploy to PRODUCTION:"
echo "   https://robotswithfeelspy.ndma.gov.pk"
echo ""
read -p "Continue? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
    echo "❌ Deployment cancelled"
    exit 1
fi

echo ""
echo "Step 1: Saving current mobile-app work..."
git checkout mobile-app
git add .
git status

read -p "Commit your changes? (yes/no): " do_commit
if [ "$do_commit" = "yes" ]; then
    read -p "Commit message: " commit_msg
    git commit -m "$commit_msg"
    git push origin mobile-app
    echo "✅ mobile-app pushed"
fi

echo ""
echo "Step 2: Merging mobile-app into mobile-prod..."
git checkout mobile-prod
git pull origin mobile-prod
git merge mobile-app -m "Merge mobile-app into mobile-prod"
git push origin mobile-prod
echo "✅ mobile-prod updated"

echo ""
echo "Step 3: Activating virtual environment..."
source /home/gtechapp/ncop_app/ncopenv311/bin/activate

echo ""
echo "Step 4: Setting production environment..."
export DJANGO_SETTINGS_MODULE=ncop_project.settings.mobile_prod
export $(grep -v '^#' /home/gtechapp/ncop_app/ncop_local/.env.mobile-prod | xargs)

echo ""
echo "Step 5: Installing dependencies..."
pip install -r requirements.txt

echo ""
echo "Step 6: Running migrations..."
python manage.py migrate --noinput

echo ""
echo "Step 7: Building frontend..."
cd ../frontend
npm install
npm run build
cd ../project

echo ""
echo "Step 8: Collecting static files..."
python manage.py collectstatic --noinput --clear

echo ""
echo "Step 9: Fixing permissions..."
sudo chmod o+x /home/gtechapp
sudo chmod -R 755 /home/gtechapp/ncop_app/ncop_local/project/static

echo ""
echo "Step 10: Restarting production service..."
sudo systemctl restart ncop-mobile-prod
sleep 2
sudo systemctl status ncop-mobile-prod --no-pager

echo ""
echo "======================================"
echo "✅ DEPLOYMENT COMPLETE"
echo "======================================"
echo ""
echo "Production URL (with auto-login):"
echo "https://robotswithfeelspy.ndma.gov.pk/auto-login/?t=eyJpYXQiOjE3NjcxNjMyNDksInUiOiJtdXN0YWZhIn0.JPBqVVQrPKlSVo9yNH_TyKz6LikrXxKbcGA0gSbU-2o&p=tyhntynbtggbhjyuvnujvnyuvjtyujtuijvtynb"
echo ""
echo "Or access dashboard directly:"
echo "https://robotswithfeelspy.ndma.gov.pk/?p=tyhntynbtggbhjyuvnujvnyuvjtyujtuijvtynb"
echo ""