#!/usr/bin/env python
"""
Django-Vite Configuration Debugger
Run this script to diagnose django-vite setup issues
"""

import os
import sys
from pathlib import Path
import json

# Color codes for terminal output
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
RESET = '\033[0m'

def print_status(message, status="info"):
    """Print colored status message"""
    color = {"success": GREEN, "error": RED, "warning": YELLOW, "info": BLUE}.get(status, RESET)
    symbol = {"success": "✓", "error": "✗", "warning": "⚠", "info": "ℹ"}.get(status, "•")
    print(f"{color}{symbol} {message}{RESET}")

def check_file_exists(filepath, description):
    """Check if file exists and report"""
    if filepath.exists():
        print_status(f"{description}: {filepath}", "success")
        return True
    else:
        print_status(f"{description}: {filepath} NOT FOUND", "error")
        return False

def main():
    print("\n" + "="*80)
    print("Django-Vite Configuration Debugger")
    print("="*80 + "\n")

    # Determine project root
    script_dir = Path(__file__).parent
    project_root = script_dir.parent if (script_dir.parent / "frontend").exists() else script_dir
    frontend_dir = project_root / "frontend"
    project_dir = project_root / "project"

    print_status(f"Project Root: {project_root}", "info")
    print_status(f"Frontend Dir: {frontend_dir}", "info")
    print_status(f"Django Project Dir: {project_dir}", "info")
    print()

    # Check critical files
    print("Checking File Structure:")
    print("-" * 80)
    
    all_good = True
    all_good &= check_file_exists(frontend_dir / "vite.config.js", "Vite Config")
    all_good &= check_file_exists(frontend_dir / "package.json", "Package.json")
    all_good &= check_file_exists(project_dir / "ncop_project" / "settings" / "dev.py", "Dev Settings")
    all_good &= check_file_exists(project_dir / "ncop_project" / "settings" / "base.py", "Base Settings")
    
    # Check for entry files
    entry_dir = frontend_dir / "src" / "entries"
    if entry_dir.exists():
        print_status(f"Entry files directory: {entry_dir}", "success")
        entry_files = list(entry_dir.glob("*.js"))
        for entry in entry_files:
            print(f"  • {entry.name}")
    else:
        print_status(f"Entry files directory NOT FOUND: {entry_dir}", "error")
        all_good = False
    
    print()

    # Check vite.config.js content
    print("Analyzing vite.config.js:")
    print("-" * 80)
    
    vite_config_path = frontend_dir / "vite.config.js"
    if vite_config_path.exists():
        with open(vite_config_path, 'r') as f:
            content = f.read()
            
        # Check for conditional base
        if 'command === "serve"' in content or 'command === "build"' in content:
            print_status("Conditional base path detected (CORRECT)", "success")
            if 'base: command === "serve" ? "/" : "/static/"' in content:
                print_status('  Dev mode: base = "/"', "success")
                print_status('  Build mode: base = "/static/"', "success")
            elif 'base: "/"' in content and 'command' in content:
                print_status("  Using conditional base logic", "success")
        elif 'base: "/static/"' in content:
            print_status('Static base path detected: base: "/static/"', "error")
            print_status("  This will cause 404s in development mode!", "error")
            print_status('  Fix: Change to: base: command === "serve" ? "/" : "/static/"', "warning")
            all_good = False
        elif 'base: "/"' in content:
            print_status('Root base path detected: base: "/"', "warning")
            print_status("  This works for dev but may fail in production", "warning")
        else:
            print_status("No base path set (using default '/')", "info")
    
    print()

    # Check Django settings
    print("Analyzing Django Settings:")
    print("-" * 80)
    
    try:
        sys.path.insert(0, str(project_dir))
        os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'ncop_project.settings.dev')
        
        from django.conf import settings
        
        # Check DJANGO_VITE settings
        if hasattr(settings, 'DJANGO_VITE'):
            vite_config = settings.DJANGO_VITE.get('default', {})
            
            print_status("DJANGO_VITE configuration found", "success")
            print(f"  dev_mode: {vite_config.get('dev_mode', 'NOT SET')}")
            print(f"  dev_server_host: {vite_config.get('dev_server_host', 'NOT SET')}")
            print(f"  dev_server_port: {vite_config.get('dev_server_port', 'NOT SET')}")
            print(f"  static_url_prefix: {vite_config.get('static_url_prefix', 'NOT SET')}")
            
            # Check for issues
            if vite_config.get('dev_mode') and vite_config.get('static_url_prefix') == '/static/':
                print_status("  WARNING: dev_mode=True but static_url_prefix='/static/'", "warning")
                print_status("  This might cause issues. Consider changing to '/'", "warning")
            
            manifest_path = vite_config.get('manifest_path')
            if manifest_path:
                manifest_path_obj = Path(manifest_path)
                if manifest_path_obj.exists():
                    print_status(f"  Manifest exists: {manifest_path}", "success")
                else:
                    print_status(f"  Manifest not found: {manifest_path}", "warning")
                    print_status("  (This is normal before first build)", "info")
        else:
            print_status("DJANGO_VITE not configured", "error")
            all_good = False
        
        # Check STATIC settings
        print()
        print_status(f"STATIC_URL: {settings.STATIC_URL}", "info")
        print_status(f"STATIC_ROOT: {settings.STATIC_ROOT}", "info")
        if hasattr(settings, 'STATICFILES_DIRS'):
            print_status(f"STATICFILES_DIRS: {len(settings.STATICFILES_DIRS)} paths", "info")
            for d in settings.STATICFILES_DIRS:
                exists = Path(d).exists()
                status = "success" if exists else "warning"
                print(f"  • {d} {'(exists)' if exists else '(not found)'}")
        
    except Exception as e:
        print_status(f"Error loading Django settings: {e}", "error")
        all_good = False
    
    print()

    # Check if Vite dev server is running
    print("Checking Vite Dev Server:")
    print("-" * 80)
    
    import socket
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(('localhost', 5173))
        sock.close()
        
        if result == 0:
            print_status("Vite dev server is running on localhost:5173", "success")
        else:
            print_status("Vite dev server is NOT running on localhost:5173", "warning")
            print_status("Start it with: npm run dev", "info")
    except Exception as e:
        print_status(f"Could not check Vite server: {e}", "warning")
    
    print()

    # Final recommendations
    print("Recommendations:")
    print("-" * 80)
    
    if all_good:
        print_status("Configuration looks good! ✓", "success")
    else:
        print_status("Issues found. Please review the errors above.", "error")
    
    print()
    print("Next Steps:")
    print("1. If vite.config.js needs fixing, replace it with the corrected version")
    print("2. If dev.py needs fixing, replace it with the corrected version")
    print("3. Restart both Django and Vite servers")
    print("4. Clear browser cache and test again")
    print()
    print("="*80)

if __name__ == "__main__":
    main()