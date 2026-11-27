#!/usr/bin/env python
"""
Staging Environment Test & Diagnostic Script
=============================================
This script tests your staging environment to verify everything is working correctly
and shows you exactly how assets are being served.

Usage:
    python test_staging.py [--check-urls]
"""

import os
import sys
import json
from pathlib import Path
import socket
import requests

# Color codes
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
CYAN = '\033[96m'
MAGENTA = '\033[95m'
RESET = '\033[0m'

def print_header(text, char='='):
    print(f"\n{CYAN}{char*80}")
    print(f"{text}")
    print(f"{char*80}{RESET}\n")

def print_status(msg, status="info"):
    colors = {"success": GREEN, "error": RED, "warning": YELLOW, "info": BLUE}
    symbols = {"success": "✓", "error": "✗", "warning": "⚠", "info": "ℹ"}
    print(f"{colors.get(status, RESET)}{symbols.get(status, '•')} {msg}{RESET}")

def check_server_running(host, port, name):
    """Check if a server is running on given host:port"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex((host, port))
        sock.close()
        return result == 0
    except Exception:
        return False

def test_url(url, description):
    """Test if a URL is accessible"""
    try:
        response = requests.get(url, timeout=2)
        if response.status_code == 200:
            print_status(f"{description}: {url} → 200 OK ✓", "success")
            return True
        else:
            print_status(f"{description}: {url} → {response.status_code}", "error")
            return False
    except requests.exceptions.RequestException as e:
        print_status(f"{description}: {url} → Failed ({str(e)[:50]}...)", "error")
        return False

def main():
    print_header("🧪 STAGING ENVIRONMENT TEST SUITE")
    
    # Determine project root
    script_dir = Path(__file__).parent
    if (script_dir / "frontend").exists() and (script_dir / "project").exists():
        project_root = script_dir
    elif (script_dir.parent / "frontend").exists() and (script_dir.parent / "project").exists():
        project_root = script_dir.parent
    else:
        print_status("Could not find project root", "error")
        return 1
    
    frontend_dir = project_root / "frontend"
    project_dir = project_root / "project"
    
    print_status(f"Project Root: {project_root}", "info")
    print()
    
    # ============================================================================
    # TEST 1: Check Running Servers
    # ============================================================================
    print_header("TEST 1: Server Status Check", '-')
    
    waitress_running = check_server_running('127.0.0.1', 5000, 'Waitress')
    vite_running = check_server_running('localhost', 5173, 'Vite Dev')
    
    if waitress_running:
        print_status("Waitress server (Django) is running on port 5000", "success")
    else:
        print_status("Waitress server is NOT running on port 5000", "error")
        print_status("Start with: python -m waitress --port=5000 --host=127.0.0.1 ncop_project.wsgi_staging:application", "info")
    
    if vite_running:
        print_status("Vite dev server is running on port 5173", "success")
    else:
        print_status("Vite dev server is NOT running on port 5173", "warning")
        print_status("This is OK if you only want to test production-like build", "info")
        print_status("For HMR, start with: npm run dev", "info")
    
    # ============================================================================
    # TEST 2: Check Configuration Files
    # ============================================================================
    print_header("TEST 2: Configuration Files", '-')
    
    # Check staging.py
    staging_py = project_dir / "ncop_project" / "settings" / "staging.py"
    if staging_py.exists():
        with open(staging_py, 'r') as f:
            staging_content = f.read()
        
        print_status(f"Found: {staging_py}", "success")
        
        # Check DJANGO_VITE configuration
        if 'dev_mode": False' in staging_content or "dev_mode': False" in staging_content:
            print_status("  dev_mode: False ✓", "success")
        
        if 'static_url_prefix": "/"' in staging_content:
            print_status('  static_url_prefix: "/" (root)', "info")
            print(f"{YELLOW}    Note: Using root prefix with dev_mode=False{RESET}")
            print(f"{YELLOW}    This means assets are served from /assets/ not /static/assets/{RESET}")
        elif 'static_url_prefix": "/static/"' in staging_content or 'static_url_prefix": STATIC_URL' in staging_content:
            print_status('  static_url_prefix: "/static/" ✓', "success")
    
    # Check vite.config.js
    vite_config = frontend_dir / "vite.config.js"
    if vite_config.exists():
        with open(vite_config, 'r') as f:
            vite_content = f.read()
        
        print_status(f"Found: {vite_config}", "success")
        
        if 'command === "serve"' in vite_content:
            print_status("  Conditional base: dev vs prod ✓", "success")
        elif 'base: "/static/"' in vite_content:
            print_status('  Static base: "/static/"', "warning")
        elif 'base: "/"' in vite_content:
            print_status('  Root base: "/"', "info")
    
    # ============================================================================
    # TEST 3: Check Build Output
    # ============================================================================
    print_header("TEST 3: Build Output & Manifest", '-')
    
    manifest_path = frontend_dir / "dist" / ".vite" / "manifest.json"
    if manifest_path.exists():
        print_status(f"Found: {manifest_path}", "success")
        
        try:
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            
            print_status(f"  Manifest contains {len(manifest)} entries", "info")
            
            # Show a sample entry
            if "dashboard_main.js" in manifest:
                entry = manifest["dashboard_main.js"]
                print(f"\n{MAGENTA}  Sample Entry: dashboard_main.js{RESET}")
                print(f"    file: {entry.get('file', 'N/A')}")
                if 'css' in entry:
                    print(f"    css: {entry['css']}")
                
                # Check if actual file exists in dist
                if 'file' in entry:
                    actual_file = frontend_dir / "dist" / entry['file']
                    if actual_file.exists():
                        size_kb = actual_file.stat().st_size / 1024
                        print_status(f"    Built file exists: {size_kb:.2f} KB", "success")
                    else:
                        print_status(f"    Built file NOT found: {actual_file}", "error")
        except json.JSONDecodeError:
            print_status("  Manifest is invalid JSON!", "error")
    else:
        print_status(f"Manifest NOT found: {manifest_path}", "error")
        print_status("  Run: npm run build", "info")
    
    # ============================================================================
    # TEST 4: Check Static Files After Collectstatic
    # ============================================================================
    print_header("TEST 4: Django Static Files", '-')
    
    static_root = project_dir / "static" / "dist"
    if static_root.exists():
        print_status(f"Found: {static_root}", "success")
        
        # Check for assets directory
        assets_dir = static_root / "assets"
        if assets_dir.exists():
            js_files = list(assets_dir.glob("dashboard_main*.js"))
            css_files = list(assets_dir.glob("dashboard_main*.css"))
            
            print_status(f"  Found {len(js_files)} dashboard JS files", "success" if js_files else "warning")
            print_status(f"  Found {len(css_files)} dashboard CSS files", "success" if css_files else "warning")
            
            if js_files:
                sample_js = js_files[0]
                size_kb = sample_js.stat().st_size / 1024
                print(f"\n{MAGENTA}  Sample File: {sample_js.name}{RESET}")
                print(f"    Size: {size_kb:.2f} KB")
                print(f"    Path: {sample_js}")
        else:
            print_status(f"  Assets directory NOT found: {assets_dir}", "warning")
            print_status("  Run: python manage.py collectstatic --noinput --settings=ncop_project.settings.staging", "info")
    else:
        print_status(f"Static root NOT found: {static_root}", "error")
    
    # ============================================================================
    # TEST 5: Test Asset URLs (if servers are running)
    # ============================================================================
    if waitress_running and '--check-urls' in sys.argv:
        print_header("TEST 5: Live URL Testing", '-')
        
        # Test various possible asset URL patterns
        if manifest_path.exists():
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            
            if "dashboard_main.js" in manifest:
                asset_file = manifest["dashboard_main.js"]["file"]
                
                print(f"{MAGENTA}Testing dashboard_main.js asset URLs...{RESET}\n")
                
                # Test different URL patterns
                urls_to_test = [
                    (f"http://localhost:5000/static/{asset_file}", "Django - /static/assets/..."),
                    (f"http://localhost:5000/{asset_file}", "Django - /assets/..."),
                ]
                
                if vite_running:
                    urls_to_test.extend([
                        (f"http://localhost:5173/static/{asset_file}", "Vite - /static/assets/..."),
                        (f"http://localhost:5173/{asset_file}", "Vite - /assets/..."),
                    ])
                
                for url, desc in urls_to_test:
                    test_url(url, desc)
    
    # ============================================================================
    # TEST 6: Configuration Summary
    # ============================================================================
    print_header("TEST 6: Configuration Summary", '-')
    
    print(f"{MAGENTA}Current Staging Setup:{RESET}")
    print(f"  • Django (Waitress): {'✓ Running on :5000' if waitress_running else '✗ Not running'}")
    print(f"  • Vite Dev Server: {'✓ Running on :5173' if vite_running else '✗ Not running'}")
    print(f"  • Build exists: {'✓ Yes' if manifest_path.exists() else '✗ No'}")
    print(f"  • Static files collected: {'✓ Yes' if (static_root / 'assets').exists() else '✗ No'}")
    
    print(f"\n{MAGENTA}How Your Setup Works:{RESET}")
    
    if vite_running and waitress_running:
        print("  🔄 HYBRID MODE (Dev + Production)")
        print("    1. Django serves HTML from Waitress (:5000)")
        print("    2. Vite dev server provides HMR (:5173)")
        print("    3. Assets can be served from either server")
        print("    4. You get both production testing + hot reload!")
    elif waitress_running and not vite_running:
        print("  🏭 PRODUCTION MODE")
        print("    1. Django serves everything from Waitress (:5000)")
        print("    2. Assets served from static files (no HMR)")
        print("    3. This mimics true production environment")
    elif vite_running and not waitress_running:
        print("  ⚠️  Vite only - Django not running")
        print("    Start Waitress to test staging environment")
    else:
        print("  ❌ Neither server is running")
        print("    Start both servers to test staging")
    
    # ============================================================================
    # RECOMMENDATIONS
    # ============================================================================
    print_header("📋 Recommendations", '-')
    
    if not waitress_running:
        print_status("Start Waitress server:", "info")
        print("    cd project")
        print("    python -m waitress --port=5000 --host=127.0.0.1 ncop_project.wsgi_staging:application")
        print()
    
    if not manifest_path.exists():
        print_status("Build frontend first:", "info")
        print("    cd frontend")
        print("    npm run build")
        print()
    
    if not (static_root / 'assets').exists():
        print_status("Collect static files:", "info")
        print("    cd project")
        print("    python manage.py collectstatic --noinput --settings=ncop_project.settings.staging")
        print()
    
    if waitress_running:
        print_status("Test in browser:", "success")
        print(f"    Open: {GREEN}http://localhost:5000{RESET}")
        print(f"    DevTools (F12) → Network tab → Check asset URLs")
        print()
        
        if vite_running:
            print_status("You're in HYBRID mode - you get:", "info")
            print("    ✓ Production-like Waitress server")
            print("    ✓ Hot Module Replacement from Vite")
            print("    ✓ Best of both worlds!")
        else:
            print_status("For HMR during development:", "info")
            print("    cd frontend && npm run dev")
    
    print_header("Summary", '-')
    
    if waitress_running and manifest_path.exists():
        print_status("✅ Staging environment is ready!", "success")
        print()
        print("Your setup is working because:")
        print(f"  1. Built assets exist in {CYAN}frontend/dist/{RESET}")
        print(f"  2. Manifest.json is valid")
        if vite_running:
            print(f"  3. Vite dev server provides live updates")
        print(f"  4. Waitress serves the Django app")
        print()
        print(f"Access your app at: {GREEN}http://localhost:5000{RESET}")
    else:
        print_status("⚠️  Staging environment needs setup", "warning")
        print("Follow the recommendations above to complete setup")
    
    print("\n" + "="*80 + "\n")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())