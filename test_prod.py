#!/usr/bin/env python
"""
Production Environment Test & Diagnostic Script (prod-arsalan)
===============================================================
Comprehensive testing suite for production deployment on Ubuntu VM.
Tests everything from build integrity to runtime monitoring.

Usage:
    python test_prod.py [--full] [--check-urls] [--monitor]
    
Options:
    --full        : Run all tests including network checks
    --check-urls  : Test actual asset URL accessibility
    --monitor     : Continuous monitoring mode
"""

import os
import sys
import json
import time
import socket
import psutil
import requests
from pathlib import Path
from datetime import datetime
import subprocess
import signal

# Color codes for terminal output
class Colors:
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    MAGENTA = '\033[95m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def print_header(text, char='='):
    """Print a formatted header"""
    print(f"\n{Colors.CYAN}{Colors.BOLD}{char*80}")
    print(f"{text}")
    print(f"{char*80}{Colors.RESET}\n")

def print_status(msg, status="info"):
    """Print a status message with appropriate color and symbol"""
    symbols = {
        "success": "✓",
        "error": "✗",
        "warning": "⚠",
        "info": "ℹ"
    }
    colors = {
        "success": Colors.GREEN,
        "error": Colors.RED,
        "warning": Colors.YELLOW,
        "info": Colors.BLUE
    }
    symbol = symbols.get(status, "•")
    color = colors.get(status, Colors.RESET)
    print(f"{color}{symbol} {msg}{Colors.RESET}")

class ProductionHealthChecker:
    """Comprehensive production environment health checker"""
    
    def __init__(self, project_root=None):
        self.project_root = project_root or self._find_project_root()
        self.frontend_dir = self.project_root / "frontend"
        self.project_dir = self.project_root / "project"
        self.results = {
            "timestamp": datetime.now().isoformat(),
            "tests": {},
            "overall_status": "unknown"
        }
        
    def _find_project_root(self):
        """Find the project root directory"""
        script_dir = Path(__file__).parent
        if (script_dir / "frontend").exists() and (script_dir / "project").exists():
            return script_dir
        elif (script_dir.parent / "frontend").exists() and (script_dir.parent / "project").exists():
            return script_dir.parent
        else:
            raise RuntimeError("Could not find project root directory")
    
    def run_all_tests(self, full=False, check_urls=False):
        """Run all production tests"""
        print_header("🔍 PRODUCTION HEALTH CHECK - prod-arsalan", "=")
        print_status(f"Project Root: {self.project_root}", "info")
        print_status(f"Test Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", "info")
        
        # Core tests
        self.test_server_status()
        self.test_build_integrity()
        self.test_static_collection()
        self.test_configuration()
        self.test_permissions()
        self.test_database_connection()
        
        if full:
            self.test_disk_space()
            self.test_memory_usage()
            self.test_system_resources()
        
        if check_urls:
            self.test_asset_urls()
        
        # Generate summary
        self.print_summary()
        return self.results
    
    def test_server_status(self):
        """Test if Waitress server is running"""
        print_header("TEST 1: Server Status", '-')
        
        test_result = {
            "waitress_running": False,
            "port": 8000,
            "process_info": None
        }
        
        # Check if process is listening on port 8000
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2)
            result = sock.connect_ex(('127.0.0.1', 8000))
            sock.close()
            
            if result == 0:
                test_result["waitress_running"] = True
                print_status("Waitress server is running on port 8000", "success")
                
                # Try to get process info
                for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
                    try:
                        cmdline = ' '.join(proc.info['cmdline'] or [])
                        if 'waitress' in cmdline.lower() or 'ncop-waitress' in cmdline.lower():
                            test_result["process_info"] = {
                                "pid": proc.info['pid'],
                                "name": proc.info['name'],
                                "memory_mb": proc.memory_info().rss / 1024 / 1024,
                                "cpu_percent": proc.cpu_percent(interval=0.1)
                            }
                            print_status(f"  PID: {proc.info['pid']}", "info")
                            print_status(f"  Memory: {test_result['process_info']['memory_mb']:.2f} MB", "info")
                            break
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        continue
            else:
                print_status("Waitress server is NOT running on port 8000", "error")
                print_status("Start with: sudo systemctl start ncop-waitress.service", "info")
        
        except Exception as e:
            print_status(f"Error checking server status: {e}", "error")
        
        self.results["tests"]["server_status"] = test_result
        return test_result["waitress_running"]
    
    def test_build_integrity(self):
        """Test Vite build integrity"""
        print_header("TEST 2: Build Integrity", '-')
        
        test_result = {
            "manifest_exists": False,
            "manifest_valid": False,
            "entry_points": {},
            "total_assets": 0,
            "issues": []
        }
        
        manifest_path = self.frontend_dir / "dist" / ".vite" / "manifest.json"
        
        if manifest_path.exists():
            test_result["manifest_exists"] = True
            print_status(f"Found manifest: {manifest_path}", "success")
            
            try:
                with open(manifest_path, 'r') as f:
                    manifest = json.load(f)
                
                test_result["manifest_valid"] = True
                test_result["total_assets"] = len(manifest)
                print_status(f"Manifest is valid JSON ({len(manifest)} entries)", "success")
                
                # Check critical entry points
                critical_entries = [
                "src/entries/dashboard_main.js",
                "src/entries/auth_login.js",
                "src/entries/auth_signup.js",
                "src/entries/auth_reset.js",
                "src/entries/auth_reset_confirm.js",
                ]
                
                for entry_name in critical_entries:
                    if entry_name in manifest:
                        entry = manifest[entry_name]
                        test_result["entry_points"][entry_name] = {
                            "file": entry.get("file"),
                            "exists": (self.frontend_dir / "dist" / entry.get("file", "")).exists()
                        }
                        
                        if test_result["entry_points"][entry_name]["exists"]:
                            print_status(f"  ✓ {entry_name}: {entry.get('file')}", "success")
                        else:
                            print_status(f"  ✗ {entry_name}: File missing!", "error")
                            test_result["issues"].append(f"{entry_name} file not found")
                    else:
                        print_status(f"  ✗ {entry_name}: Not in manifest", "error")
                        test_result["issues"].append(f"{entry_name} not in manifest")
                
            except json.JSONDecodeError:
                test_result["manifest_valid"] = False
                test_result["issues"].append("Manifest is invalid JSON")
                print_status("Manifest is invalid JSON!", "error")
        else:
            print_status(f"Manifest NOT found: {manifest_path}", "error")
            print_status("Run: cd frontend && npm run build", "info")
            test_result["issues"].append("Manifest file not found")
        
        self.results["tests"]["build_integrity"] = test_result
        return test_result["manifest_valid"]
    
    def test_static_collection(self):
        """Test Django static file collection"""
        print_header("TEST 3: Static File Collection", '-')
        
        test_result = {
            "static_root_exists": False,
            "assets_collected": False,
            "file_count": 0,
            "sample_files": [],
            "issues": []
        }
        
        static_root = self.project_dir / "static" / "dist"
        
        if static_root.exists():
            test_result["static_root_exists"] = True
            print_status(f"Found static root: {static_root}", "success")
            
            # Check for assets directory
            assets_dir = static_root / "assets"
            if assets_dir.exists():
                test_result["assets_collected"] = True
                
                # Count JS and CSS files
                js_files = list(assets_dir.glob("*.js"))
                css_files = list(assets_dir.glob("*.css"))
                test_result["file_count"] = len(js_files) + len(css_files)
                
                print_status(f"Found {len(js_files)} JavaScript files", "success")
                print_status(f"Found {len(css_files)} CSS files", "success")
                
                # Sample files
                for js_file in js_files[:3]:
                    size_kb = js_file.stat().st_size / 1024
                    test_result["sample_files"].append({
                        "name": js_file.name,
                        "size_kb": round(size_kb, 2)
                    })
                    print(f"    {js_file.name} ({size_kb:.2f} KB)")
                
                # Check for critical files
                dashboard_js = list(assets_dir.glob("dashboard_main*.js"))
                if not dashboard_js:
                    test_result["issues"].append("dashboard_main.js not found in static")
                    print_status("  ⚠ dashboard_main.js not found", "warning")
            else:
                test_result["issues"].append("Assets directory not found in static")
                print_status(f"Assets directory NOT found: {assets_dir}", "error")
                print_status("Run: python manage.py collectstatic --noinput --settings=ncop_project.settings.prod", "info")
        else:
            test_result["issues"].append("Static root directory not found")
            print_status(f"Static root NOT found: {static_root}", "error")
        
        self.results["tests"]["static_collection"] = test_result
        return test_result["assets_collected"]
    
    def test_configuration(self):
        """Test production configuration"""
        print_header("TEST 4: Configuration", '-')
        
        test_result = {
            "prod_settings_exists": False,
            "env_file_exists": False,
            "vite_config_valid": False,
            "wsgi_configured": False,
            "issues": []
        }
        
        # Check prod.py
        prod_settings = self.project_dir / "ncop_project" / "settings" / "prod.py"
        if prod_settings.exists():
            test_result["prod_settings_exists"] = True
            print_status(f"Found prod.py: {prod_settings}", "success")
            
            with open(prod_settings, 'r') as f:
                content = f.read()
                
            if 'DEBUG = False' in content:
                print_status("  DEBUG = False ✓", "success")
            else:
                test_result["issues"].append("DEBUG is not False")
                print_status("  DEBUG is not False!", "error")
            
            if 'dev_mode": False' in content or "dev_mode': False" in content:
                print_status("  Vite dev_mode = False ✓", "success")
            else:
                test_result["issues"].append("Vite dev_mode is not False")
                print_status("  Vite dev_mode is not False!", "error")
        else:
            test_result["issues"].append("prod.py not found")
            print_status(f"prod.py NOT found: {prod_settings}", "error")
        
        # Check .env.prod
        env_file = self.project_root / ".env.prod"
        if env_file.exists():
            test_result["env_file_exists"] = True
            print_status(f"Found .env.prod", "success")
        else:
            test_result["issues"].append(".env.prod not found")
            print_status(".env.prod NOT found", "warning")
        
        # Check vite.config.js
        vite_config = self.frontend_dir / "vite.config.js"
        if vite_config.exists():
            with open(vite_config, 'r') as f:
                content = f.read()
            
            if 'command === "serve"' in content and '"/static/"' in content:
                test_result["vite_config_valid"] = True
                print_status("vite.config.js has correct base configuration ✓", "success")
            else:
                test_result["issues"].append("vite.config.js may have incorrect base config")
                print_status("vite.config.js configuration may be incorrect", "warning")
        
        # Check wsgi_prod.py
        wsgi_prod = self.project_dir / "ncop_project" / "wsgi_prod.py"
        if wsgi_prod.exists():
            test_result["wsgi_configured"] = True
            print_status("wsgi_prod.py exists ✓", "success")
        else:
            test_result["issues"].append("wsgi_prod.py not found")
            print_status("wsgi_prod.py NOT found", "error")
        
        self.results["tests"]["configuration"] = test_result
        return len(test_result["issues"]) == 0
    
    def test_permissions(self):
        """Test file permissions for Nginx"""
        print_header("TEST 5: File Permissions", '-')
        
        test_result = {
            "vite_dist_readable": False,
            "static_dist_readable": False,
            "issues": []
        }
        
        # Check Vite dist permissions
        vite_dist = self.frontend_dir / "dist"
        if vite_dist.exists():
            perms = oct(vite_dist.stat().st_mode)[-3:]
            test_result["vite_dist_readable"] = int(perms[2]) >= 4
            
            if test_result["vite_dist_readable"]:
                print_status(f"Vite dist readable (permissions: {perms}) ✓", "success")
            else:
                print_status(f"Vite dist NOT readable by others (permissions: {perms})", "error")
                print_status("Run: sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/frontend/dist", "info")
                test_result["issues"].append("Vite dist not readable by Nginx")
        
        # Check Django static permissions
        static_dist = self.project_dir / "static" / "dist"
        if static_dist.exists():
            perms = oct(static_dist.stat().st_mode)[-3:]
            test_result["static_dist_readable"] = int(perms[2]) >= 4
            
            if test_result["static_dist_readable"]:
                print_status(f"Static dist readable (permissions: {perms}) ✓", "success")
            else:
                print_status(f"Static dist NOT readable by others (permissions: {perms})", "error")
                print_status("Run: sudo chmod -R o+rX /home/cladmin/ncop_local/ncop_local_prod/project/static/dist", "info")
                test_result["issues"].append("Static dist not readable by Nginx")
        
        self.results["tests"]["permissions"] = test_result
        return len(test_result["issues"]) == 0
    
    def test_database_connection(self):
        """Test database connectivity"""
        print_header("TEST 6: Database Connection", '-')
        
        test_result = {
            "connection_success": False,
            "database_info": {},
            "error": None
        }
        
        try:
            # Try to run Django management command
            result = subprocess.run(
                ["python", "manage.py", "check", "--settings=ncop_project.settings.prod"],
                cwd=self.project_dir,
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode == 0:
                test_result["connection_success"] = True
                print_status("Database connection successful ✓", "success")
                print_status("Django checks passed ✓", "success")
            else:
                print_status("Django checks failed", "error")
                print_status(f"Error: {result.stderr[:200]}", "error")
                test_result["error"] = result.stderr[:500]
        
        except subprocess.TimeoutExpired:
            print_status("Database check timed out", "error")
            test_result["error"] = "Timeout"
        except Exception as e:
            print_status(f"Database check error: {e}", "error")
            test_result["error"] = str(e)
        
        self.results["tests"]["database_connection"] = test_result
        return test_result["connection_success"]
    
    def test_disk_space(self):
        """Test available disk space"""
        print_header("TEST 7: Disk Space", '-')
        
        test_result = {
            "total_gb": 0,
            "used_gb": 0,
            "free_gb": 0,
            "percent_used": 0,
            "warning": False
        }
        
        try:
            disk = psutil.disk_usage('/')
            test_result["total_gb"] = round(disk.total / (1024**3), 2)
            test_result["used_gb"] = round(disk.used / (1024**3), 2)
            test_result["free_gb"] = round(disk.free / (1024**3), 2)
            test_result["percent_used"] = disk.percent
            
            print_status(f"Total: {test_result['total_gb']} GB", "info")
            print_status(f"Used: {test_result['used_gb']} GB ({test_result['percent_used']}%)", "info")
            print_status(f"Free: {test_result['free_gb']} GB", "info")
            
            if disk.percent > 90:
                test_result["warning"] = True
                print_status("⚠ Disk usage above 90%!", "warning")
            elif disk.percent > 80:
                test_result["warning"] = True
                print_status("⚠ Disk usage above 80%", "warning")
            else:
                print_status("Disk space is adequate ✓", "success")
        
        except Exception as e:
            print_status(f"Error checking disk space: {e}", "error")
        
        self.results["tests"]["disk_space"] = test_result
        return not test_result["warning"]
    
    def test_memory_usage(self):
        """Test memory usage"""
        print_header("TEST 8: Memory Usage", '-')
        
        test_result = {
            "total_gb": 0,
            "used_gb": 0,
            "free_gb": 0,
            "percent_used": 0,
            "warning": False
        }
        
        try:
            memory = psutil.virtual_memory()
            test_result["total_gb"] = round(memory.total / (1024**3), 2)
            test_result["used_gb"] = round(memory.used / (1024**3), 2)
            test_result["free_gb"] = round(memory.available / (1024**3), 2)
            test_result["percent_used"] = memory.percent
            
            print_status(f"Total: {test_result['total_gb']} GB", "info")
            print_status(f"Used: {test_result['used_gb']} GB ({test_result['percent_used']}%)", "info")
            print_status(f"Available: {test_result['free_gb']} GB", "info")
            
            if memory.percent > 90:
                test_result["warning"] = True
                print_status("⚠ Memory usage above 90%!", "warning")
            elif memory.percent > 80:
                test_result["warning"] = True
                print_status("⚠ Memory usage above 80%", "warning")
            else:
                print_status("Memory usage is normal ✓", "success")
        
        except Exception as e:
            print_status(f"Error checking memory: {e}", "error")
        
        self.results["tests"]["memory_usage"] = test_result
        return not test_result["warning"]
    
    def test_system_resources(self):
        """Test CPU and system load"""
        print_header("TEST 9: System Resources", '-')
        
        test_result = {
            "cpu_percent": 0,
            "load_average": [],
            "warning": False
        }
        
        try:
            # CPU usage
            cpu_percent = psutil.cpu_percent(interval=1)
            test_result["cpu_percent"] = cpu_percent
            print_status(f"CPU Usage: {cpu_percent}%", "info")
            
            if cpu_percent > 80:
                test_result["warning"] = True
                print_status("⚠ High CPU usage", "warning")
            
            # Load average (Linux)
            if hasattr(os, 'getloadavg'):
                load_avg = os.getloadavg()
                test_result["load_average"] = list(load_avg)
                print_status(f"Load Average: {load_avg[0]:.2f}, {load_avg[1]:.2f}, {load_avg[2]:.2f}", "info")
        
        except Exception as e:
            print_status(f"Error checking system resources: {e}", "error")
        
        self.results["tests"]["system_resources"] = test_result
        return not test_result["warning"]
    
    def test_asset_urls(self):
        """Test if assets are accessible via HTTP"""
        print_header("TEST 10: Asset URL Accessibility", '-')
        
        test_result = {
            "assets_accessible": [],
            "assets_failed": [],
            "base_url": "http://172.18.7.36:8000"
        }
        
        manifest_path = self.frontend_dir / "dist" / ".vite" / "manifest.json"
        
        if not manifest_path.exists():
            print_status("Cannot test URLs - manifest not found", "warning")
            self.results["tests"]["asset_urls"] = test_result
            return False
        
        try:
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)
            
            # Test a few key assets
            test_assets = ["dashboard_main.js", "auth_login.js"]
            
            for entry_name in test_assets:
                if entry_name in manifest:
                    asset_file = manifest[entry_name]["file"]
                    url = f"{test_result['base_url']}/static/{asset_file}"
                    
                    try:
                        response = requests.get(url, timeout=5)
                        if response.status_code == 200:
                            test_result["assets_accessible"].append(url)
                            print_status(f"✓ {url} (200 OK)", "success")
                        else:
                            test_result["assets_failed"].append({
                                "url": url,
                                "status": response.status_code
                            })
                            print_status(f"✗ {url} ({response.status_code})", "error")
                    except requests.RequestException as e:
                        test_result["assets_failed"].append({
                            "url": url,
                            "error": str(e)
                        })
                        print_status(f"✗ {url} (Failed: {e})", "error")
        
        except Exception as e:
            print_status(f"Error testing URLs: {e}", "error")
        
        self.results["tests"]["asset_urls"] = test_result
        return len(test_result["assets_failed"]) == 0
    
    def print_summary(self):
        """Print test summary"""
        print_header("📊 TEST SUMMARY", '=')
        
        total_tests = len(self.results["tests"])
        passed_tests = sum(1 for test in self.results["tests"].values() 
                          if not test.get("issues") and not test.get("error"))
        
        print(f"{Colors.BOLD}Tests Run: {total_tests}{Colors.RESET}")
        print(f"{Colors.GREEN}Passed: {passed_tests}{Colors.RESET}")
        print(f"{Colors.RED}Failed: {total_tests - passed_tests}{Colors.RESET}")
        
        # Overall status
        if passed_tests == total_tests:
            self.results["overall_status"] = "healthy"
            print(f"\n{Colors.GREEN}{Colors.BOLD}✓ Production environment is HEALTHY{Colors.RESET}")
        elif passed_tests >= total_tests * 0.7:
            self.results["overall_status"] = "degraded"
            print(f"\n{Colors.YELLOW}{Colors.BOLD}⚠ Production environment is DEGRADED{Colors.RESET}")
        else:
            self.results["overall_status"] = "critical"
            print(f"\n{Colors.RED}{Colors.BOLD}✗ Production environment is CRITICAL{Colors.RESET}")
        
        # List issues
        all_issues = []
        for test_name, test_data in self.results["tests"].items():
            if test_data.get("issues"):
                all_issues.extend([(test_name, issue) for issue in test_data["issues"]])
            if test_data.get("error"):
                all_issues.append((test_name, test_data["error"]))
        
        if all_issues:
            print(f"\n{Colors.YELLOW}{Colors.BOLD}Issues Found:{Colors.RESET}")
            for test_name, issue in all_issues:
                print(f"  {Colors.YELLOW}•{Colors.RESET} [{test_name}] {issue}")
        
        print("\n" + "="*80 + "\n")

def monitor_mode(checker):
    """Continuous monitoring mode"""
    print_header("🔄 CONTINUOUS MONITORING MODE", '=')
    print("Press Ctrl+C to stop monitoring\n")
    
    def signal_handler(sig, frame):
        print(f"\n{Colors.YELLOW}Monitoring stopped.{Colors.RESET}")
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    
    iteration = 0
    while True:
        iteration += 1
        print(f"\n{Colors.CYAN}--- Check #{iteration} at {datetime.now().strftime('%H:%M:%S')} ---{Colors.RESET}")
        
        results = checker.run_all_tests(full=False, check_urls=False)
        
        # Quick summary
        status = results["overall_status"]
        if status == "healthy":
            print(f"{Colors.GREEN}Status: HEALTHY ✓{Colors.RESET}")
        elif status == "degraded":
            print(f"{Colors.YELLOW}Status: DEGRADED ⚠{Colors.RESET}")
        else:
            print(f"{Colors.RED}Status: CRITICAL ✗{Colors.RESET}")
        
        print(f"{Colors.BLUE}Waiting 30 seconds...{Colors.RESET}")
        time.sleep(30)

def main():
    """Main entry point"""
    full_test = '--full' in sys.argv
    check_urls = '--check-urls' in sys.argv
    monitor = '--monitor' in sys.argv
    
    try:
        checker = ProductionHealthChecker()
        
        if monitor:
            monitor_mode(checker)
        else:
            results = checker.run_all_tests(full=full_test, check_urls=check_urls)
            
            # Save results to file
            results_file = checker.project_root / "logs" / "production_health.json"
            results_file.parent.mkdir(exist_ok=True)
            with open(results_file, 'w') as f:
                json.dump(results, f, indent=2)
            
            print_status(f"Results saved to: {results_file}", "info")
            
            return 0 if results["overall_status"] == "healthy" else 1
    
    except Exception as e:
        print_status(f"Fatal error: {e}", "error")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())