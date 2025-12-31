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
echo "Step 1: Saving current mobile-app work (skipping .env files)..."
git checkout mobile-app

# Explicitly ensure .env files are not tracked
git update-index --assume-unchanged ../.env.mobile-dev 2>/dev/null || true
git update-index --assume-unchanged ../.env.mobile-prod 2>/dev/null || true

# Add all changes (respects .gitignore)
git add .

# Ensure .env files are not staged
git reset -- ../.env.mobile-dev ../.env.mobile-prod 2>/dev/null || true

# Check if there are STAGED changes to commit (excluding .env files)
if [[ -n $(git diff --cached --name-only) ]]; then
    echo "✅ Changes ready to commit:"
    git diff --cached --name-only
    echo ""
    
    read -p "Commit your changes? (yes/no): " do_commit
    if [ "$do_commit" = "yes" ]; then
        read -p "Commit message: " commit_msg
        git commit -m "$commit_msg"
        git push origin mobile-app
        echo "✅ mobile-app pushed"
    else
        echo "⚠️  Warning: You have uncommitted changes"
        read -p "Continue anyway? (yes/no): " continue_anyway
        if [ "$continue_anyway" != "yes" ]; then
            echo "❌ Deployment cancelled"
            exit 1
        fi
    fi
else
    echo "✅ No changes to commit (excluding .env files)"
fi

echo ""
echo "Step 2: Merging mobile-app into mobile-prod..."
git checkout mobile-prod

# Try to pull, but don't fail if remote doesn't exist yet
git pull origin mobile-prod 2>/dev/null || echo "⚠️  mobile-prod not on remote yet, will push after merge"

git merge mobile-app -m "Merge mobile-app into mobile-prod - $(date +'%Y-%m-%d %H:%M')"

# Push to remote (creates branch if doesn't exist)
git push -u origin mobile-prod
echo "✅ mobile-prod updated"

echo ""
echo "Step 3: Activating virtual environment..."
source /home/gtechapp/ncop_app/ncopenv311/bin/activate

echo ""
echo "Step 4: Setting production environment..."
export DJANGO_SETTINGS_MODULE=ncop_project.settings.mobile_prod
export $(grep -v '^#' /home/gtechapp/ncop_app/ncop_local/.env.mobile-prod | xargs)

echo ""
echo "Step 5: Running migrations..."
python manage.py migrate --noinput

echo ""
echo "Step 6: Building frontend..."
cd ../frontend
npm install --silent
npm run build
cd ../project

echo ""
echo "Step 7: Collecting static files..."
python manage.py collectstatic --noinput --clear

echo ""
echo "Step 8: Fixing permissions..."
sudo chmod o+x /home/gtechapp
sudo chmod -R 755 /home/gtechapp/ncop_app/ncop_local/project/static

echo ""
echo "Step 9: Restarting production service..."
sudo systemctl restart ncop-mobile-prod
sleep 3

# Check if service started successfully
if sudo systemctl is-active --quiet ncop-mobile-prod; then
    echo "✅ Production service is running"
    sudo systemctl status ncop-mobile-prod --no-pager -l
else
    echo "❌ ERROR: Production service failed to start!"
    sudo journalctl -u ncop-mobile-prod -n 50 --no-pager
    exit 1
fi

echo ""
echo "Step 10: Switching back to mobile-app branch..."
git checkout mobile-app
echo "✅ Back on mobile-app branch for development"

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
echo "You are now back on mobile-app branch for continued development"
echo ""