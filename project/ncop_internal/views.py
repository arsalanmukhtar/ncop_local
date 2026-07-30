# Organized imports for views.py
from django.conf import settings
from django.contrib import messages
from django.contrib.auth import authenticate, login, logout, get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.tokens import default_token_generator
from django.core.mail import send_mail
from django.shortcuts import render, redirect, get_object_or_404
from django.urls import reverse
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.utils.translation import gettext as _
from django.http import JsonResponse, Http404,HttpResponseServerError,HttpResponseBadRequest,HttpResponse,HttpResponseNotAllowed
from django.views import View
from django.core.serializers import serialize
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import status
from django.utils import timezone
from django.db import IntegrityError, transaction, connection
from django.db.models import Q
from django.core.cache import cache
from django.forms.models import model_to_dict
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.decorators.cache import never_cache
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_exempt
from django.core.exceptions import PermissionDenied
from django.utils.dateparse import parse_date, parse_datetime
from difflib import SequenceMatcher
from django.contrib.gis.geos import (
    Polygon, MultiPolygon, GEOSGeometry,
    GeometryCollection as GEOSGeometryCollection,
    MultiPolygon as GEOSMultiPolygon,
)
from shapely.geometry import (
    Polygon as shapelyPolygon,
    MultiPolygon as shapelyMultiPolygon,
    shape as shapelyShape,
    mapping as shapelyMapping,
)
from shapely.geometry.polygon import orient
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict, deque
from datetime import datetime, timedelta
from typing import Optional, Tuple, List, Dict, Any
from xml.etree import ElementTree as ET
from dataclasses import dataclass, asdict
from urllib.parse import urlencode
from datetime import datetime, timedelta
from requests.adapters import HTTPAdapter
from PIL import Image, ImageDraw, ImageFont
from functools import lru_cache
# from ncop.models import (
#     DistrictBoundary, MajorDamsLevel, LayerInfo, Incident,
#     IncidentFeatures, IncidentsMedia, NcopHazardAlert,
#     NcopHazardAlertFeatures, GlobalHazardCalendar,
# )
# from .serializers import IncidentsMediaSerializer
from ncop_project.settings.base import (
    MAPBOX_ACCESS_TOKEN, METEOBLUE_TOKEN, WAQI_API_TOKEN,STORY_JSON_DIR
)

import os
import math
import time
import asyncio
import httpx
import requests
import json
import logging
import geopandas as gpd
import shutil
import re
import wbgapi as wb
import threading
import hashlib
import chromadb
import uuid
import ssl
import socket
import csv
import io
import ee
import urllib3
from urllib3.util.retry import Retry
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, SystemMessage

# Disable SSL warnings for development - remove in production if you fix SSL properly
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
# TLS: fresh CA bundle (fixes stale trust store in prod)
try:
    import certifi
    CERT_PATH = certifi.where()
except Exception:
    CERT_PATH = True  # fallback to system trust if certifi not present
# Use the repo-relative STORY_JSON_DIR from base.py
STORY_DIR = STORY_JSON_DIR

if not STORY_DIR.exists():
    raise RuntimeError(f"STORY_JSON_DIR not found at: {STORY_DIR}")

# Slug validation (lowercase, digits, dash, underscore)
SLUG_RE = re.compile(r"^[a-z0-9-_]+$")

User = get_user_model()



@login_required(login_url="login")
def dashboard_view(request):
    return render(request, "dashboard.html", {
        "mapbox_token": settings.MAPBOX_ACCESS_TOKEN,
        "metblut": settings.METEOBLUE_TOKEN,  # ← add this line
        "waqi_token": settings.WAQI_API_TOKEN,  # ← add this line
    })


# ============================================================================
# NCOP Documentation
# ----------------------------------------------------------------------------
# Renders the self-contained product/technical documentation page consumed by
# the in-app "Documentation" button on the dashboard header.  No login is
# required — the page contains no user data, only platform documentation.
# ============================================================================
def documentation_view(request):
    return render(request, "documentation.html")


def login_view(request):
    if request.user.is_authenticated:
        return redirect("dashboard")

    if request.method == "POST":
        username = request.POST.get("username", "").strip()
        password = request.POST.get("password", "")
        user = authenticate(request, username=username, password=password)
        if user is not None:
            login(request, user)
            return redirect("dashboard")
        messages.error(request, _("Invalid username or password."))
    return render(request, "auth/login.html")


def signup_view(request):
    if request.user.is_authenticated:
        return redirect("dashboard")

    if request.method == "POST":
        first_name = request.POST.get("first_name", "").strip()
        last_name = request.POST.get("last_name", "").strip()
        username = request.POST.get("username", "").strip()
        email = request.POST.get("email", "").strip().lower()
        password1 = request.POST.get("password1", "")
        password2 = request.POST.get("password2", "")

        if not username or not email or not password1:
            messages.error(request, _("Please fill all required fields."))
            return render(request, "auth/signup.html")

        if password1 != password2:
            messages.error(request, _("Passwords do not match."))
            return render(request, "auth/signup.html")

        if User.objects.filter(username=username).exists():
            messages.error(request, _("Username already taken."))
            return render(request, "auth/signup.html")

        if User.objects.filter(email=email).exists():
            messages.error(request, _("Email already in use."))
            return render(request, "auth/signup.html")

        user = User.objects.create_user(
            username=username,
            email=email,
            password=password1,
            first_name=first_name,
            last_name=last_name,
        )
        login(request, user)
        messages.success(request, _("Account created successfully."))
        return redirect("dashboard")

    return render(request, "auth/signup.html")


def logout_view(request):
    logout(request)
    messages.success(request, _("You have been logged out."))
    return redirect("login")


def password_reset_view(request):
    """
    Sends a password reset link using Django's token generator.
    In dev, set EMAIL_BACKEND='django.core.mail.backends.console.EmailBackend'
    to print emails to console.
    """
    if request.method == "POST":
        email = request.POST.get("email", "").strip().lower()
        if not email:
            messages.error(request, _("Please enter your email address."))
            return render(request, "auth/password_reset.html")

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            # Don't reveal whether the email exists
            messages.success(request, _("If that email exists, a reset link has been sent."))
            return redirect("password_reset")

        uid = urlsafe_base64_encode(str(user.pk).encode())
        token = default_token_generator.make_token(user)
        reset_url = request.build_absolute_uri(
            reverse("password_reset_confirm", kwargs={"uidb64": uid, "token": token})
        )

        subject = _("Reset your NCOP password")
        message = _(
            "Hello {name},\n\n"
            "Use the link below to set a new password:\n{url}\n\n"
            "If you didn't request this, you can ignore this email."
        ).format(name=user.get_full_name() or user.username, url=reset_url)

        send_mail(
            subject,
            message,
            getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@ncop.local"),
            [email],
            fail_silently=True,
        )

        messages.success(request, _("If that email exists, a reset link has been sent."))
        return redirect("password_reset")

    return render(request, "auth/password_reset.html")


def password_reset_confirm_view(request, uidb64, token):
    """
    Confirms the token and lets the user set a new password.
    Template uses fields: password1, password2 (matching your HTML).
    """
    try:
        uid = force_str(urlsafe_base64_decode(uidb64))
        user = User.objects.get(pk=uid)
    except Exception:
        user = None

    if user is None or not default_token_generator.check_token(user, token):
        messages.error(request, _("Invalid or expired reset link."))
        return redirect("password_reset")

    if request.method == "POST":
        pwd1 = request.POST.get("password1", "")
        pwd2 = request.POST.get("password2", "")
        if not pwd1 or not pwd2:
            messages.error(request, _("Please enter your new password twice."))
            return render(request, "auth/password_reset_confirm.html")

        if pwd1 != pwd2:
            messages.error(request, _("Passwords do not match."))
            return render(request, "auth/password_reset_confirm.html")

        user.set_password(pwd1)
        user.save()
        messages.success(request, _("Your password has been reset. Please log in."))
        return redirect("login")

    return render(request, "auth/password_reset_confirm.html")


#STORY MODE LOGIC _______________________------------------------------------------------------
def _story_path(slug: str) -> Optional[os.PathLike]:
    """Constructs the path for a story JSON file by slug."""
    if not SLUG_RE.match(slug):
        return None
    return STORY_DIR / f"{slug}.json"


def _list_slugs():
    """Lists all available story JSON files as slugs."""
    out = []
    for name in os.listdir(STORY_DIR):
        if name.lower().endswith(".json"):
            out.append(os.path.splitext(name)[0])
    return sorted(out)


def _load_json(path: os.PathLike):
    """Safely load a JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: os.PathLike, obj):
    """Safely save a JSON object."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


@method_decorator(csrf_exempt, name="dispatch")
class StoriesView(View):
    """
    GET  /stories/            -> list all stories (slugs)
    GET  /stories/?full=1     -> return full story objects as {slug: obj}
    POST /stories/            -> create/overwrite one story ({slug, story})
    """

    def get(self, request):
        slugs = _list_slugs()

        # ?full=1 => return all story contents
        if request.GET.get("full") == "1":
            data = {}
            for s in slugs:
                p = _story_path(s)
                try:
                    data[s] = _load_json(p)
                except Exception as e:
                    data[s] = {"error": f"failed to load: {e}"}
            return JsonResponse(data, safe=True)

        return JsonResponse({"stories": slugs})

    def post(self, request):
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except Exception:
            return HttpResponseBadRequest("Invalid JSON")

        slug = payload.get("slug")
        obj = payload.get("story")

        if not slug or not isinstance(slug, str) or not SLUG_RE.match(slug):
            return HttpResponseBadRequest("Missing/invalid 'slug' (use lowercase letters, digits, - or _)")

        if not isinstance(obj, dict):
            return HttpResponseBadRequest("'story' must be a JSON object")

        path = _story_path(slug)
        if not path:
            return HttpResponseBadRequest("Invalid slug")

        try:
            _save_json(path, obj)
            return JsonResponse({"slug": slug, "saved": True})
        except Exception as e:
            return JsonResponse({"detail": f"Failed to save: {e}"}, status=500)


@method_decorator(csrf_exempt, name="dispatch")
class StoryDetailView(View):
    """
    GET  /stories/<slug>/     -> fetch story json
    PUT  /stories/<slug>/     -> replace with body json
    """

    def get(self, request, slug):
        path = _story_path(slug)
        if not path or not path.exists():
            return JsonResponse({"detail": "Not found"}, status=404)
        try:
            obj = _load_json(path)
            return JsonResponse(obj, safe=False)
        except Exception as e:
            return JsonResponse({"detail": f"Failed to load: {e}"}, status=500)

    def put(self, request, slug):
        path = _story_path(slug)
        if not path or not path.exists():
            return JsonResponse({"detail": "Not found"}, status=404)

        try:
            payload = json.loads(request.body.decode("utf-8"))
        except Exception:
            return HttpResponseBadRequest("Invalid JSON")

        if not isinstance(payload, dict):
            return HttpResponseBadRequest("Body must be a JSON object")

        try:
            _save_json(path, payload)
            return JsonResponse({"slug": slug, "saved": True})
        except Exception as e:
            return JsonResponse({"detail": f"Failed to save: {e}"}, status=500)

    def post(self, request, slug):
        return HttpResponseNotAllowed(["GET", "PUT"])

    def delete(self, request, slug):
        return HttpResponseNotAllowed(["GET", "PUT"])
# PMD WEATHER DATA STATION RECORDS UPDATED DAILY
class WeatherDataPMDFFDView(View):
    # Cache data for 5 minutes to reduce API calls
    CACHE_DURATION = timedelta(minutes=5)
    _cache = {}

    ENDPOINTS = {
        "rainfall": "http://faws.pmd.gov.pk/faws/new/api/loadLatestData.php?product=DailyRainfall",
        "temperature": "http://faws.pmd.gov.pk/faws/new/api/loadLatestData.php?product=Temperature",
        "wind": "http://faws.pmd.gov.pk/faws/new/api/loadLatestData.php?product=Wind",
    }

    def _fetch_endpoint(self, endpoint_name, url):
        """Fetch data from a single endpoint"""
        try:
            response = requests.get(url, timeout=10)
            if response.status_code == 200:
                return endpoint_name, response.json()
        except Exception as e:
            print(f"Error fetching {endpoint_name}: {e}")
        return endpoint_name, []

    def _get_cached_data(self):
        """Get cached data if still valid"""
        if "data" in self._cache and "timestamp" in self._cache:
            if datetime.now() - self._cache["timestamp"] < self.CACHE_DURATION:
                return self._cache["data"]
        return None

    def _merge_data(self, rainfall_data, temperature_data, wind_data):
        """Merge data from all endpoints by station name"""
        merged = {}

        # Process rainfall data
        for item in rainfall_data:
            name = item.get("name")
            if name and item.get("location"):
                merged[name] = {
                    "name": name,
                    "location": item["location"],
                    "rainfall": item.get("totalRainfall", 0),
                    "rainfall_date": item.get("date"),
                    "rainfall_time": item.get("time"),
                }

        # Add temperature data
        for item in temperature_data:
            name = item.get("name")
            if name in merged:
                merged[name].update(
                    {
                        "temperature": (
                            float(item.get("temperature", 0))
                            if item.get("temperature")
                            else 0
                        ),
                        "dewPoint": (
                            float(item.get("dewPoint", 0))
                            if item.get("dewPoint")
                            else 0
                        ),
                        "humidity": float(item.get("RH", 0)) if item.get("RH") else 0,
                        "pressure": (
                            float(item.get("airPressure", 0))
                            if item.get("airPressure")
                            else 0
                        ),
                        "temp_date": item.get("date"),
                        "temp_time": item.get("time"),
                    }
                )
            elif name and item.get("location"):
                # Station not in rainfall data, create new entry
                merged[name] = {
                    "name": name,
                    "location": item["location"],
                    "temperature": (
                        float(item.get("temperature", 0))
                        if item.get("temperature")
                        else 0
                    ),
                    "dewPoint": (
                        float(item.get("dewPoint", 0)) if item.get("dewPoint") else 0
                    ),
                    "humidity": float(item.get("RH", 0)) if item.get("RH") else 0,
                    "pressure": (
                        float(item.get("airPressure", 0))
                        if item.get("airPressure")
                        else 0
                    ),
                    "temp_date": item.get("date"),
                    "temp_time": item.get("time"),
                    "rainfall": 0,
                }

        # Add wind data
        for item in wind_data:
            name = item.get("name")
            if name in merged:
                merged[name].update(
                    {
                        "windSpeed": (
                            float(item.get("windspeed_knot", 0))
                            if item.get("windspeed_knot")
                            else 0
                        ),
                        "windDirection": (
                            float(item.get("windDirection", 0))
                            if item.get("windDirection")
                            else 0
                        ),
                        "wind_date": item.get("date"),
                        "wind_time": item.get("time"),
                    }
                )
            elif name and item.get("location"):
                # Station not in previous data, create new entry
                merged[name] = {
                    "name": name,
                    "location": item["location"],
                    "windSpeed": (
                        float(item.get("windspeed_knot", 0))
                        if item.get("windspeed_knot")
                        else 0
                    ),
                    "windDirection": (
                        float(item.get("windDirection", 0))
                        if item.get("windDirection")
                        else 0
                    ),
                    "wind_date": item.get("date"),
                    "wind_time": item.get("time"),
                    "temperature": 0,
                    "rainfall": 0,
                }

        return merged

    def get(self, request, *args, **kwargs):
        # Check cache first
        cached_data = self._get_cached_data()
        if cached_data:
            return JsonResponse(cached_data)

        # Fetch all endpoints in parallel
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(self._fetch_endpoint, name, url): name
                for name, url in self.ENDPOINTS.items()
            }

            results = {}
            for future in as_completed(futures):
                endpoint_name, data = future.result()
                results[endpoint_name] = data

        # Merge all data
        merged_data = self._merge_data(
            results.get("rainfall", []),
            results.get("temperature", []),
            results.get("wind", []),
        )

        # Convert to GeoJSON
        features = []
        for station_name, data in merged_data.items():
            location = data.get("location", [])
            if len(location) >= 2:
                try:
                    lon = float(location[0])
                    lat = float(location[1])

                    # Only include stations with valid coordinates and some data
                    if -180 <= lon <= 180 and -90 <= lat <= 90:
                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": [lon, lat]},
                            "properties": {
                                "name": station_name,
                                "temperature": data.get("temperature", 0),
                                "dewPoint": data.get("dewPoint", 0),
                                "humidity": data.get("humidity", 0),
                                "pressure": data.get("pressure", 0),
                                "windSpeed": data.get("windSpeed", 0),
                                "windDirection": data.get("windDirection", 0),
                                "rainfall": data.get("rainfall", 0),
                                # Add date/time fields
                                "temp_date": data.get("temp_date"),
                                "temp_time": data.get("temp_time"),
                                "wind_date": data.get("wind_date"),
                                "wind_time": data.get("wind_time"),
                                "rainfall_date": data.get("rainfall_date"),
                                "rainfall_time": data.get("rainfall_time"),
                            },
                        }
                        features.append(feature)
                except (ValueError, TypeError):
                    continue

        geojson = {"type": "FeatureCollection", "features": features}

        # Cache the result
        self._cache = {"data": geojson, "timestamp": datetime.now()}

        return JsonResponse(geojson)


# =============================================================================
# Heatwave Monitoring (Open-Meteo) - Major Pakistani cities
# Used by frontend layer "heatwave_monitoring" under PMD subcategory.
# Two endpoints:
#   GET /get-heatwave-monitoring/  -> GeoJSON FeatureCollection of cities w/ now-temp
#   GET /get-heatwave-detail/?lat&lon&type=forecast|seasonal|climate&name
# Both use ThreadPoolExecutor + a process-wide Semaphore to keep total
# concurrent outbound calls below Open-Meteo's free-tier comfort zone.
# =============================================================================

# Major cities / districts of Pakistan (curated for heatwave coverage)
PAKISTAN_HEATWAVE_CITIES = [
    {"name": "Karachi",          "lat": 24.8607, "lon": 67.0011, "province": "Sindh"},
    {"name": "Lahore",           "lat": 31.5497, "lon": 74.3436, "province": "Punjab"},
    {"name": "Islamabad",        "lat": 33.6844, "lon": 73.0479, "province": "ICT"},
    {"name": "Rawalpindi",       "lat": 33.5651, "lon": 73.0169, "province": "Punjab"},
    {"name": "Faisalabad",       "lat": 31.4504, "lon": 73.1350, "province": "Punjab"},
    {"name": "Multan",           "lat": 30.1575, "lon": 71.5249, "province": "Punjab"},
    {"name": "Hyderabad",        "lat": 25.3960, "lon": 68.3578, "province": "Sindh"},
    {"name": "Peshawar",         "lat": 34.0151, "lon": 71.5249, "province": "KPK"},
    {"name": "Quetta",           "lat": 30.1798, "lon": 66.9750, "province": "Balochistan"},
    {"name": "Gujranwala",       "lat": 32.1877, "lon": 74.1945, "province": "Punjab"},
    {"name": "Sialkot",          "lat": 32.4945, "lon": 74.5229, "province": "Punjab"},
    {"name": "Bahawalpur",       "lat": 29.3956, "lon": 71.6836, "province": "Punjab"},
    {"name": "Sukkur",           "lat": 27.7059, "lon": 68.8574, "province": "Sindh"},
    {"name": "Sargodha",         "lat": 32.0836, "lon": 72.6711, "province": "Punjab"},
    {"name": "Larkana",          "lat": 27.5590, "lon": 68.2123, "province": "Sindh"},
    {"name": "Sheikhupura",      "lat": 31.7167, "lon": 73.9850, "province": "Punjab"},
    {"name": "Mardan",           "lat": 34.1989, "lon": 72.0231, "province": "KPK"},
    {"name": "Mingora",          "lat": 34.7795, "lon": 72.3614, "province": "KPK"},
    {"name": "Dera Ghazi Khan",  "lat": 30.0561, "lon": 70.6403, "province": "Punjab"},
    {"name": "Rahim Yar Khan",   "lat": 28.4202, "lon": 70.2952, "province": "Punjab"},
    {"name": "Sahiwal",          "lat": 30.6707, "lon": 73.1064, "province": "Punjab"},
    {"name": "Okara",            "lat": 30.8138, "lon": 73.4534, "province": "Punjab"},
    {"name": "Mirpur Khas",      "lat": 25.5269, "lon": 69.0125, "province": "Sindh"},
    {"name": "Jacobabad",        "lat": 28.2823, "lon": 68.4514, "province": "Sindh"},
    {"name": "Khairpur",         "lat": 27.5295, "lon": 68.7592, "province": "Sindh"},
    {"name": "Nawabshah",        "lat": 26.2442, "lon": 68.4100, "province": "Sindh"},
    {"name": "Turbat",           "lat": 26.0031, "lon": 63.0440, "province": "Balochistan"},
    {"name": "Sibi",             "lat": 29.5430, "lon": 67.8773, "province": "Balochistan"},
    {"name": "Gwadar",           "lat": 25.1216, "lon": 62.3254, "province": "Balochistan"},
    {"name": "Khuzdar",          "lat": 27.8126, "lon": 66.6173, "province": "Balochistan"},
    {"name": "Abbottabad",       "lat": 34.1463, "lon": 73.2117, "province": "KPK"},
    {"name": "Dera Ismail Khan", "lat": 31.8313, "lon": 70.9019, "province": "KPK"},
    {"name": "Chitral",          "lat": 35.8511, "lon": 71.7889, "province": "KPK"},
    {"name": "Skardu",           "lat": 35.2987, "lon": 75.6304, "province": "GB"},
    {"name": "Gilgit",           "lat": 35.9208, "lon": 74.3144, "province": "GB"},
    {"name": "Muzaffarabad",     "lat": 34.3700, "lon": 73.4711, "province": "AJK"},
    {"name": "Jhelum",           "lat": 32.9425, "lon": 73.7257, "province": "Punjab"},
    {"name": "Gujrat",           "lat": 32.5700, "lon": 74.0789, "province": "Punjab"},
    {"name": "Kasur",            "lat": 31.1156, "lon": 74.4467, "province": "Punjab"},
    {"name": "Khanewal",         "lat": 30.3017, "lon": 71.9321, "province": "Punjab"},
]

# Process-wide semaphore so concurrent endpoint hits don't blow the
# Open-Meteo free-tier rate limit (~10 req/s).
_HEATWAVE_API_SEMAPHORE = threading.Semaphore(8)
# Single shared session with retry/backoff.
_heatwave_session = requests.Session()
_heatwave_session.mount(
    "https://",
    HTTPAdapter(
        max_retries=Retry(
            total=2,
            backoff_factor=0.4,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET",),
        ),
        pool_connections=16,
        pool_maxsize=32,
    ),
)


def _heatwave_get(url, params, timeout=8):
    """Rate-limited GET wrapper for Open-Meteo. Returns (json, error)."""
    with _HEATWAVE_API_SEMAPHORE:
        try:
            r = _heatwave_session.get(url, params=params, timeout=timeout)
            if r.status_code == 200:
                return r.json(), None
            # Surface upstream error messages (helps debug 4xx mistakes).
            try:
                body = r.json()
            except Exception:
                body = {"raw": r.text[:300]}
            logger.warning("Open-Meteo non-200 (%s) for %s: %s", r.status_code, url, body)
            return None, {"status": r.status_code, "body": body}
        except Exception as exc:
            logger.warning("Open-Meteo fetch failed for %s: %s", url, exc)
            return None, {"status": 0, "body": str(exc)}


# ---------------------------------------------------------------------------
# Disk-backed persistent cache for Open-Meteo data
# ---------------------------------------------------------------------------
# LocMemCache (the project default) evaporates on every gunicorn restart, which
# turns into a thundering-herd of Open-Meteo calls and trips the free-tier
# rate limit. This little helper mirrors every (kind, lat, lon) result to a
# JSON blob on disk so a restart re-uses the prior fetches until they expire.
#
# Two-tier reads: the in-memory cache on each view stays the hot path; misses
# fall through to disk; misses there hit the network.
# ---------------------------------------------------------------------------

try:
    _HEATWAVE_CACHE_DIR = os.path.join(settings.BASE_DIR, "cache", "heatwave")
except Exception:
    # BASE_DIR may not be available during cold imports — fall back to /tmp.
    import tempfile as _tempfile
    _HEATWAVE_CACHE_DIR = os.path.join(_tempfile.gettempdir(), "ncop_heatwave_cache")

os.makedirs(_HEATWAVE_CACHE_DIR, exist_ok=True)
_HEATWAVE_DISK_LOCK = threading.Lock()
_HEATWAVE_DISK_MAX_FILES = 1024  # soft cap; janitor trims oldest beyond this


def _heatwave_disk_path(key):
    digest = hashlib.md5(key.encode("utf-8")).hexdigest()
    return os.path.join(_HEATWAVE_CACHE_DIR, f"{digest}.json")


def _heatwave_disk_get(key, ttl_seconds):
    """Return cached JSON for `key` if it's on disk and within TTL."""
    path = _heatwave_disk_path(key)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    if (time.time() - st.st_mtime) > ttl_seconds:
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        logger.debug("Heatwave disk-cache read failed for %s: %s", key, exc)
        return None


def _heatwave_disk_put(key, payload):
    """Atomically write `payload` to disk for `key`."""
    path = _heatwave_disk_path(key)
    tmp_path = f"{path}.{os.getpid()}.tmp"
    try:
        with _HEATWAVE_DISK_LOCK:
            with open(tmp_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            os.replace(tmp_path, path)
            _heatwave_disk_janitor()
    except Exception as exc:
        logger.debug("Heatwave disk-cache write failed for %s: %s", key, exc)
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except OSError:
            pass


def _heatwave_disk_janitor():
    """Best-effort prune so the cache dir doesn't grow unbounded."""
    try:
        names = [
            n for n in os.listdir(_HEATWAVE_CACHE_DIR)
            if n.endswith(".json")
        ]
        if len(names) <= _HEATWAVE_DISK_MAX_FILES:
            return
        entries = []
        for n in names:
            p = os.path.join(_HEATWAVE_CACHE_DIR, n)
            try:
                entries.append((os.path.getmtime(p), p))
            except OSError:
                continue
        entries.sort()
        for _, p in entries[: len(entries) - _HEATWAVE_DISK_MAX_FILES]:
            try:
                os.remove(p)
            except OSError:
                continue
    except Exception:
        pass


class HeatwaveMonitoringView(View):
    """
    GeoJSON of major Pakistani cities with current temperature, humidity,
    precipitation, and daily min/max — sourced from the Open-Meteo public
    forecast API.

    Cache layers:
      * in-memory  (10 min) — hot path for repeat hits within a process
      * disk       (30 min) — survives restarts, blunts the rate-limit storm
      * per-city disk (15 min) — persists each city's current-weather sample
        so a fresh aggregate after a restart only refetches stale cities.
    """
    CACHE_TTL = timedelta(minutes=10)
    DISK_TTL_SECONDS = 30 * 60
    PER_CITY_DISK_TTL = 15 * 60
    _cache_lock = threading.Lock()
    _cache = {"data": None, "ts": None}

    FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

    def _fetch_city_now(self, city):
        # Per-city disk cache — survives restarts and lets the aggregate fetch
        # only call Open-Meteo for cities whose sample has expired.
        ck = f"city-now:{city['name']}:{round(float(city['lat']), 3)}:{round(float(city['lon']), 3)}"
        cached_feature = _heatwave_disk_get(ck, self.PER_CITY_DISK_TTL)
        if cached_feature is not None:
            return cached_feature

        params = {
            "latitude": city["lat"],
            "longitude": city["lon"],
            "current": "temperature_2m,relative_humidity_2m,precipitation,weather_code,apparent_temperature,wind_speed_10m",
            "daily": "temperature_2m_max,temperature_2m_min",
            "forecast_days": 1,
            "timezone": "Asia/Karachi",
        }
        data, _err = _heatwave_get(self.FORECAST_URL, params, timeout=8)
        cur = (data or {}).get("current") or {}
        daily = (data or {}).get("daily") or {}
        temp = cur.get("temperature_2m")
        try:
            t_max = (daily.get("temperature_2m_max") or [None])[0]
            t_min = (daily.get("temperature_2m_min") or [None])[0]
        except Exception:
            t_max = t_min = None
        # Heatwave alert tier (PMD-style thresholds for Pakistan)
        alert = "Normal"
        if isinstance(temp, (int, float)):
            if temp >= 48:
                alert = "Extreme"
            elif temp >= 44:
                alert = "Severe"
            elif temp >= 40:
                alert = "High"
            elif temp >= 36:
                alert = "Elevated"
        feature = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [city["lon"], city["lat"]]},
            "properties": {
                "name": city["name"],
                "province": city["province"],
                "temperature": temp,
                "apparent_temperature": cur.get("apparent_temperature"),
                "humidity": cur.get("relative_humidity_2m"),
                "precipitation": cur.get("precipitation"),
                "wind_speed": cur.get("wind_speed_10m"),
                "weather_code": cur.get("weather_code"),
                "temp_max": t_max,
                "temp_min": t_min,
                "alert_level": alert,
                "updated": cur.get("time"),
            },
        }
        # Persist this city's sample so a later restart can rebuild the
        # aggregate without re-hammering Open-Meteo for every city.
        if temp is not None:
            _heatwave_disk_put(ck, feature)
        return feature

    def _read_cache(self):
        with self._cache_lock:
            if self._cache["data"] and self._cache["ts"]:
                if datetime.now() - self._cache["ts"] < self.CACHE_TTL:
                    return self._cache["data"]
        return None

    def _write_cache(self, data):
        with self._cache_lock:
            self._cache = {"data": data, "ts": datetime.now()}

    def get(self, request, *args, **kwargs):
        # 1. Hot in-memory cache
        cached = self._read_cache()
        if cached is not None:
            return JsonResponse(cached)

        # 2. Disk cache (persistent across restarts)
        disk_key = "heatwave-monitoring:aggregate"
        disk_cached = _heatwave_disk_get(disk_key, self.DISK_TTL_SECONDS)
        if disk_cached is not None:
            self._write_cache(disk_cached)
            return JsonResponse(disk_cached)

        # 3. Network — _fetch_city_now itself reads/writes per-city disk
        # entries, so cities whose samples are still fresh skip the API.
        features = []
        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = [executor.submit(self._fetch_city_now, c) for c in PAKISTAN_HEATWAVE_CITIES]
            for fut in as_completed(futures):
                try:
                    feat = fut.result()
                    if feat and feat["properties"].get("temperature") is not None:
                        features.append(feat)
                except Exception as exc:
                    logger.debug("Heatwave city fetch failed: %s", exc)

        geojson = {"type": "FeatureCollection", "features": features}
        self._write_cache(geojson)
        if features:
            _heatwave_disk_put(disk_key, geojson)
        return JsonResponse(geojson)


class HeatwaveDetailView(View):
    """
    Detail endpoint used by the popup charts. Returns one of three datasets:

        type=forecast  -> 16-day daily forecast (api.open-meteo.com /forecast)
        type=seasonal  -> 6-month seasonal/weekly forecast (seasonal-forecast-api)
        type=climate   -> climate-change daily projection (climate-api)

    Per (lat, lon, type) results are cached in-process AND on disk so a
    server restart doesn't burn through the Open-Meteo rate limit. TTLs are
    chosen to match how often each upstream actually changes.

    Outbound calls are funneled through the same semaphore as
    HeatwaveMonitoringView.
    """
    CACHE_TTL = timedelta(minutes=15)
    _cache_lock = threading.Lock()
    _cache = {}  # key -> (data, ts)

    URLS = {
        "forecast": "https://api.open-meteo.com/v1/forecast",
        "seasonal": "https://seasonal-api.open-meteo.com/v1/seasonal",
        "climate":  "https://climate-api.open-meteo.com/v1/climate",
    }

    # Disk TTLs (seconds). Forecast updates ~hourly upstream so 1h is fine;
    # seasonal refreshes daily (cap at 6h); climate projections are
    # effectively static (24h is more than enough).
    DISK_TTL_SECONDS = {
        "forecast": 60 * 60,
        "seasonal": 6 * 60 * 60,
        "climate":  24 * 60 * 60,
    }

    def _cache_get(self, key):
        with self._cache_lock:
            entry = self._cache.get(key)
            if entry and datetime.now() - entry[1] < self.CACHE_TTL:
                return entry[0]
        return None

    def _cache_put(self, key, data):
        with self._cache_lock:
            # Soft cap to avoid unbounded growth
            if len(self._cache) > 256:
                self._cache.clear()
            self._cache[key] = (data, datetime.now())

    def _build_params(self, kind, lat, lon):
        if kind == "forecast":
            return {
                "latitude": lat,
                "longitude": lon,
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_max,relative_humidity_2m_min,apparent_temperature_max",
                "current": "temperature_2m,relative_humidity_2m,precipitation",
                "forecast_days": 16,
                "timezone": "Asia/Karachi",
            }
        if kind == "seasonal":
            # NOTE: seasonal-api supports a *very* narrow set of weekly
            # variables — only `temperature_2m_mean` validates. Humidity / min
            # / max come from the `daily` series instead.
            return {
                "latitude": lat,
                "longitude": lon,
                "weekly": "temperature_2m_mean",
                "daily": "temperature_2m_max,temperature_2m_min,relative_humidity_2m_max,relative_humidity_2m_min",
                "timezone": "Asia/Karachi",
            }
        if kind == "climate":
            today = datetime.utcnow().date()
            start = today.replace(year=today.year - 1).isoformat()
            end = today.replace(year=today.year + 4).isoformat()
            return {
                "latitude": lat,
                "longitude": lon,
                "start_date": start,
                "end_date": end,
                "daily": "temperature_2m_mean,temperature_2m_max,precipitation_sum",
                "models": "MRI_AGCM3_2_S",
                "timezone": "Asia/Karachi",
            }
        return None

    def get(self, request, *args, **kwargs):
        try:
            lat = float(request.GET.get("lat"))
            lon = float(request.GET.get("lon"))
        except (TypeError, ValueError):
            return JsonResponse({"error": "lat/lon required"}, status=400)
        kind = (request.GET.get("type") or "forecast").lower()
        if kind not in self.URLS:
            return JsonResponse({"error": "invalid type"}, status=400)

        key = f"{kind}:{round(lat, 3)}:{round(lon, 3)}"

        # 1. Hot in-memory cache
        cached = self._cache_get(key)
        if cached is not None:
            return JsonResponse(cached)

        # 2. Disk cache — survives gunicorn restarts
        disk_ttl = self.DISK_TTL_SECONDS.get(kind, 60 * 60)
        disk_key = f"detail:{key}"
        disk_cached = _heatwave_disk_get(disk_key, disk_ttl)
        if disk_cached is not None:
            self._cache_put(key, disk_cached)
            return JsonResponse(disk_cached)

        # 3. Network
        params = self._build_params(kind, lat, lon)
        url = self.URLS[kind]

        # Even though this is a single call we still wrap it so the same
        # semaphore caps total concurrent outbound traffic across endpoints.
        with ThreadPoolExecutor(max_workers=1) as ex:
            data, err = ex.submit(_heatwave_get, url, params, 12).result()

        if data is None:
            # Last-ditch fallback: if Open-Meteo refused/rate-limited but we
            # have a stale-but-not-ancient disk entry, serve it rather than
            # surfacing a 502 to the user. Marks the response so the client
            # can flag it as stale if it cares.
            stale = _heatwave_disk_get(disk_key, disk_ttl * 4)
            if stale is not None:
                stale_marked = dict(stale)
                stale_marked["stale"] = True
                return JsonResponse(stale_marked)
            return JsonResponse(
                {"error": "upstream fetch failed", "type": kind, "detail": err or {}},
                status=502,
            )

        payload = {"type": kind, "lat": lat, "lon": lon, "data": data}
        self._cache_put(key, payload)
        _heatwave_disk_put(disk_key, payload)
        return JsonResponse(payload)


#WAQI LOCAL PAKISTAN STATION SMOG VIEW

class WAQIgeojson(View):
    MAX_WORKERS = 8
    REQUEST_TIMEOUT = 5
    DETAIL_PER_STATION = False
    STATION_DETAIL_TIMEOUT = 4
    AIRNET_TIMEOUT = 5

    FORCE_UIDS = [
        511660,
        541396,
        544699,
        545356,
        544681,
        545149,
        547342,
        558319,
        544708,
        545395,
        545503,
        544966,
        545332,
        546253,
        546205,
        554545,
        544084,
        544297,
        544321,
        544111,
        544294,
        544291,
        561409,
        544114,
        544450,
        544315,
        544300,
        544288,
        544972,
        544720,
        544462,
        545143,
        544960,
        544678,
        545977,
        545968,
        545857,
        545347,
        545326,
        544087,
        541369,
        541762,
        541186,
        543349,
        541198,
        569905,
        540817,
        541213,
        546370,
        545734,
        545536,
        545302,
        545494,
        544723,
        543562,
        542482,
        544693,
        563377,
        541366,
        541363,
        541375,
        541180,
        521242,
    ]

    # High-priority micro city boxes
    CITY_TILES = [
        {"lat1": 24.4, "lng1": 66.5, "lat2": 25.4, "lng2": 67.7},  # Karachi
        {"lat1": 30.9, "lng1": 72.5, "lat2": 31.9, "lng2": 73.7},  # Faisalabad
        {"lat1": 29.7, "lng1": 70.8, "lat2": 30.7, "lng2": 72.0},  # Multan
        {"lat1": 29.7, "lng1": 66.3, "lat2": 30.7, "lng2": 67.6},  # Quetta
        {"lat1": 31.2, "lng1": 74.0, "lat2": 31.8, "lng2": 74.6},  # Lahore
        {"lat1": 33.4, "lng1": 72.9, "lat2": 34.1, "lng2": 73.6},  # Islamabad/Rawalpindi
    ]

    # Pakistan-wide tiles
    PAKISTAN_TILES = [
        {"lat1": 23.0, "lng1": 66.0, "lat2": 28.5, "lng2": 71.0},
        {"lat1": 27.0, "lng1": 70.0, "lat2": 34.0, "lng2": 75.5},
        {"lat1": 31.0, "lng1": 70.0, "lat2": 37.5, "lng2": 74.5},
        {"lat1": 23.0, "lng1": 60.0, "lat2": 29.5, "lng2": 67.5},
        {"lat1": 33.0, "lng1": 73.0, "lat2": 37.8, "lng2": 78.0},
    ]

    def get(self, request, *args, **kwargs):
        features = self.fetch_waqi_global_data()

        if not features:
            logger.error("No WAQI data could be fetched at all.")
            return HttpResponseServerError(
                JsonResponse(
                    {
                        "error": "Failed to fetch air quality data from WAQI.",
                        "detail": "Upstream returned empty for all regions.",
                    }
                ).content,
                content_type="application/json",
            )

        api_key = getattr(settings, "WAQI_API_TOKEN", "")
        forced_features = self.fetch_forced_uids(api_key, features)

        features.extend(forced_features)

        geojson = {"type": "FeatureCollection", "features": features}
        return JsonResponse(geojson, safe=False)

    def fetch_waqi_global_data(self):
        api_key = getattr(settings, "WAQI_API_TOKEN", "")
        if not api_key:
            logger.error("WAQI_API_TOKEN not configured")
            return []

        # Only Pakistan (city tiles + national tiles). Global chunks removed.
        chunks = self.CITY_TILES + self.PAKISTAN_TILES

        features = []
        seen_uids = set()

        with ThreadPoolExecutor(max_workers=self.MAX_WORKERS) as executor:
            futures = [executor.submit(self.fetch_chunk, api_key, bbox) for bbox in chunks]

            for future in as_completed(futures):
                try:
                    for feat in future.result():
                        uid = feat["properties"]["uid"]
                        if uid not in seen_uids:
                            seen_uids.add(uid)
                            features.append(feat)
                except Exception as e:
                    logger.warning(f"Failed to fetch one bbox: {e}")

        if self.DETAIL_PER_STATION and features:
            features = self.enrich_features(api_key, features)

        return features

    def fetch_chunk(self, api_key, bbox):
        latlng = f"{bbox['lat1']},{bbox['lng1']},{bbox['lat2']},{bbox['lng2']}"
        url = (
            "https://api.waqi.info/v2/map/bounds"
            f"?latlng={latlng}&networks=all&token={api_key}"
        )
        try:
            r = requests.get(url, timeout=self.REQUEST_TIMEOUT)
            data = r.json()
        except requests.Timeout:
            logger.warning(f"Timeout fetching bbox {bbox}")
            return []
        except Exception as e:
            logger.error(f"Error fetching bbox {bbox}: {e}")
            return []

        if data.get("status") != "ok":
            logger.warning(f"WAQI status not ok for bbox {bbox}: {data}")
            return []

        out = []
        for st in data.get("data", []):
            feat = self.create_feature_basic(st)
            if feat:
                out.append(feat)
        return out

    def normalize_aqi(self, raw_aqi):
        if raw_aqi is None:
            return None
        if isinstance(raw_aqi, (int, float)):
            return int(raw_aqi) if raw_aqi >= 0 else None
        if isinstance(raw_aqi, str):
            m = re.match(r"^\s*(-?\d+)", raw_aqi)
            if m:
                try:
                    val = int(m.group(1))
                    return val if val >= 0 else None
                except ValueError:
                    return None
        return None

    def create_feature_basic(self, station):
        try:
            lat = station.get("lat")
            lon = station.get("lon")
            if lat is None or lon is None:
                return None

            aqi_val = self.normalize_aqi(station.get("aqi"))
            if aqi_val is None:
                return None

            raw_uid = station.get("uid", 0)
            try:
                uid_clean = abs(int(str(raw_uid).strip()))
            except (ValueError, TypeError):
                uid_clean = 0

            props = {
                "aqi": aqi_val,
                "uid": uid_clean,
                "name": station.get("station", {}).get("name", "Unknown Station"),
                "time": station.get("station", {}).get("time", ""),
            }

            return {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [float(lon), float(lat)],
                },
                "properties": props,
            }
        except Exception as e:
            logger.debug(f"Error creating feature_basic: {e}")
            return None

    def enrich_features(self, api_key, features):
        def fetch_detail(uid):
            url = f"https://api.waqi.info/feed/@{uid}/?token={api_key}"
            try:
                r = requests.get(url, timeout=self.STATION_DETAIL_TIMEOUT)
                d = r.json()
                if d.get("status") != "ok":
                    return None
                return d.get("data")
            except Exception as e:
                logger.debug(f"Detail fetch failed uid {uid}: {e}")
                return None

        uid_list = [f["properties"]["uid"] for f in features]
        details_map = {}

        with ThreadPoolExecutor(max_workers=self.MAX_WORKERS) as executor:
            future_map = {executor.submit(fetch_detail, uid): uid for uid in uid_list}
            for fut in as_completed(future_map):
                uid = future_map[fut]
                details_map[uid] = fut.result()

        for f in features:
            uid = f["properties"]["uid"]
            detail = details_map.get(uid)
            if not detail:
                continue
            iaqi = detail.get("iaqi", {})
            f["properties"].update(
                {
                    "dominantpol": detail.get("dominentpol")
                    or detail.get("dominent_pol")
                    or detail.get("dominantpol"),
                    "pm25": iaqi.get("pm25", {}).get("v"),
                    "pm10": iaqi.get("pm10", {}).get("v"),
                    "no2": iaqi.get("no2", {}).get("v"),
                    "so2": iaqi.get("so2", {}).get("v"),
                    "o3": iaqi.get("o3", {}).get("v"),
                    "co": iaqi.get("co", {}).get("v"),
                    "attribution": detail.get("attributions", []),
                }
            )

        return features

    def fetch_airnet_station_feature(self, uid):
        url = f"https://airnet.waqi.info/airnet/feed/hourly/{uid}"
        try:
            r = requests.get(url, timeout=self.AIRNET_TIMEOUT)
            data = r.json()
        except Exception as e:
            logger.debug(f"AirNet fetch failed uid {uid}: {e}")
            return None

        # Must be ok
        if data.get("status") != "ok":
            return None

        meta = data.get("meta", {}) or {}
        loiq = data.get("loiq", {}) or {}

        # IMPORTANT: AirNet sometimes returns "data": null
        data_block = data.get("data")
        if not isinstance(data_block, dict):
            # No usable time series -> let fallback (/feed/@uid) handle it
            return None

        lat = None
        lon = None
        if "geo" in meta and isinstance(meta.get("geo"), (list, tuple)) and len(meta["geo"]) >= 2:
            try:
                lat = meta["geo"][0]
                lon = meta["geo"][1]
            except Exception:
                lat = None
                lon = None
        elif "display_name" in loiq:
            lat = None
            lon = None

        def latest_series_value(series_name):
            series = data_block.get(series_name)
            if not series or not isinstance(series, list):
                return None, None
            try:
                last_entry = series[-1] or {}
            except Exception:
                return None, None
            ts = last_entry.get("time")
            mean_val = last_entry.get("mean")
            return mean_val, ts

        pm25_val, ts_pm25 = latest_series_value("pm25")
        pm10_val, ts_pm10 = latest_series_value("pm10")
        co2_val, ts_co2   = latest_series_value("co2")
        tvoc_val, ts_tvoc = latest_series_value("tvoc")
        t_val, ts_t       = latest_series_value("met.t")
        h_val, ts_h       = latest_series_value("met.h")

        ts_final = ts_pm25 or ts_pm10 or ts_co2 or ts_tvoc or ts_t or ts_h or ""

        try:
            aqi_val = pm25_val if isinstance(pm25_val, (int, float)) else None
        except Exception:
            aqi_val = None
        if aqi_val is None:
            aqi_val = pm10_val if isinstance(pm10_val, (int, float)) else None
        if aqi_val is None:
            return None

        try:
            uid_clean = abs(int(str(meta.get("id", uid)).strip()))
        except Exception:
            try:
                uid_clean = abs(int(str(uid).strip()))
            except Exception:
                uid_clean = 0

        name_val = meta.get("name") or loiq.get("display_name") or "Unknown Station"

        if lat is None or lon is None:
            return None

        props = {
            "aqi": int(aqi_val) if isinstance(aqi_val, (int, float)) else aqi_val,
            "uid": uid_clean,
            "name": name_val,
            "time": ts_final or "",
            "pm25": pm25_val,
            "pm10": pm10_val,
            "co2": co2_val,
            "tvoc": tvoc_val,
            "temp": t_val,
            "rh": h_val,
        }

        feat = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
            "properties": props,
        }
        return feat

    def fetch_single_station_detail(self, api_key, uid):
        """
        Fetch one WAQI /feed/@<uid> and convert it into a Feature with enrichment.
        """
        url = f"https://api.waqi.info/feed/@{uid}/?token={api_key}"
        try:
            r = requests.get(url, timeout=self.STATION_DETAIL_TIMEOUT)
            data = r.json()
        except Exception as e:
            logger.debug(f"Forced UID {uid} fetch failed: {e}")
            return None

        if data.get("status") != "ok":
            return None

        d = data.get("data", {})
        if not d:
            return None

        station_like = {
            "lat": d.get("city", {}).get("geo", [None, None])[0],
            "lon": d.get("city", {}).get("geo", [None, None])[1],
            "aqi": d.get("aqi"),
            "uid": uid,
            "station": {
                "name": d.get("city", {}).get("name", "Unknown Station"),
                "time": d.get("time", {}).get("s", ""),
            },
        }

        feat = self.create_feature_basic(station_like)
        if not feat:
            return None

        iaqi = d.get("iaqi", {})
        feat["properties"].update(
            {
                "dominantpol": d.get("dominentpol")
                or d.get("dominent_pol")
                or d.get("dominantpol"),
                "pm25": iaqi.get("pm25", {}).get("v"),
                "pm10": iaqi.get("pm10", {}).get("v"),
                "no2": iaqi.get("no2", {}).get("v"),
                "so2": iaqi.get("so2", {}).get("v"),
                "o3": iaqi.get("o3", {}).get("v"),
                "co": iaqi.get("co", {}).get("v"),
                "attribution": d.get("attributions", []),
            }
        )
        return feat

    def fetch_forced_uids(self, api_key, existing_features):
        """
        Fetch all FORCE_UIDS by first trying AirNet hourly, and if that fails, falling back to WAQI /feed/@.
        Deduplicate against stations already in existing_features.
        """
        present = {f["properties"]["uid"] for f in existing_features}
        want = [uid for uid in self.FORCE_UIDS if uid not in present]

        if not want:
            return []

        forced_out = []

        with ThreadPoolExecutor(max_workers=self.MAX_WORKERS) as executor:
            future_map = {}
            for uid in want:
                future_map[executor.submit(self.fetch_airnet_station_feature, uid)] = (
                    uid,
                    "airnet",
                )
            for fut in as_completed(future_map):
                feat = fut.result()
                uid_val, _src = future_map[fut]
                if feat:
                    forced_out.append(feat)
                else:
                    waqi_feat = self.fetch_single_station_detail(api_key, uid_val)
                    if waqi_feat:
                        forced_out.append(waqi_feat)

        return forced_out
# OIl SLicks 
class SlickPlusGeojsonApi(View):
    def get(self, request, *args, **kwargs):
        # Calculate the end date as today's date with time set to 00:00:00
        end_date = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        # Calculate the start date as 20 days before the end date, also with time set to 00:00:00
        start_date = (end_date - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        end_date = end_date.strftime("%Y-%m-%dT%H:%M:%SZ")

        # API URL with dynamic datetime parameter
        api_url = (
            "https://api.cerulean.skytruth.org/collections/public.slick_plus/items"
            f"?sortby=slick_timestamp&datetime={start_date}/{end_date}&bbox=59.458008,17.266728,68.818359,25.363882&limit=10&f=geojson"
        )
        # Fetch the data from the API
        response = requests.get(api_url)
        # Check if the request was successful
        if response.status_code == 200:
            data = response.json()  # Parse the JSON response
            return JsonResponse(data)  # Return the data as JSON
        else:
            # If the request failed, return an error message
            return JsonResponse(
                {"error": "Failed to fetch data from the API"},
                status=response.status_code,
            )

#-------------------------GDACS--------------------------------------------------
# GDACS
# return: Geojson(Feature Collection)
# ---------- helpers ----------


def deep_get(obj: Dict[str, Any], path: List[str], default=None):
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
        if cur is None:
            return default
    return cur


def try_number(v: Any):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    s = str(v).strip()
    # dbnulls or blanks → None
    if s == "" or s.upper() == "DBNULL":
        return None
    try:
        if "." in s:
            return float(s)
        return int(s)
    except Exception:
        return s


def get_json(url: str, timeout: float = 20.0) -> Dict[str, Any]:
    r = requests.get(url, timeout=timeout)
    r.raise_for_status()
    return r.json()


# flatten the datums/scalars payloads returned by /export/getimpact & friends
def parse_impact_payload(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for block in payload.get("datums", []):
        alias = block.get("alias") or block.get("source")
        for datum in block.get("datum", []):
            scalars = {
                s.get("name"): try_number(s.get("value"))
                for s in (datum.get("scalars", {}) or {}).get("scalar", [])  # tolerant
            }
            out.append(
                {
                    "dataset_alias": alias,
                    "datasource": datum.get("datasource"),
                    "type": datum.get("type"),
                    "io": datum.get("io"),
                    "scalars": scalars,
                }
            )
    return out


def extract_impact_links(
    event_type: str, details: Dict[str, Any]
) -> List[Tuple[str, str]]:
    # impacts usually live under details.properties.impacts
    impacts = (
        deep_get(details, ["details", "properties", "impacts"], default=None)
        or deep_get(details, ["properties", "impacts"], default=None)
        or details.get("impacts")
        or []
    )

    links: List[Tuple[str, str]] = []
    for imp in impacts or []:
        src = imp.get("source") or "UNKNOWN"
        res = imp.get("resource", {}) or {}
        if event_type == "EQ":
            for key in ("impact", "shake_preliminary", "shakemap"):
                url = res.get(key)
                if isinstance(url, str) and url.startswith("http"):
                    links.append((f"{src}:{key}", url))
        elif event_type == "TC":
            # buffer39 contains the POP* sums; timeline/locations optional
            for key in ("buffer39", "timeline", "locations"):
                url = res.get(key)
                if isinstance(url, str) and url.startswith("http"):
                    links.append((f"{src}:{key}", url))
        elif event_type == "WF":
            url = res.get("impact")
            if isinstance(url, str) and url.startswith("http"):
                links.append((f"{src}:impact", url))
        else:
            # fallback: grab any http-ish field
            for k, v in res.items():
                if isinstance(v, str) and v.startswith("http"):
                    links.append((f"{src}:{k}", v))
    return links


def parse_sendai_records(details: Dict[str, Any]) -> List[Dict[str, Any]]:
    sendai = (
        deep_get(details, ["details", "properties", "sendai"])
        or deep_get(details, ["properties", "sendai"])
        or details.get("sendai")
        or []
    )
    out: List[Dict[str, Any]] = []
    for s in sendai:
        out.append(
            {
                "source": "SENDAI",
                "latest": bool(s.get("latest")),
                "category": s.get("sendaitype"),  # A/B/C
                "metric": s.get(
                    "sendainame"
                ),  # e.g., death, injured, houses damaged, displaced, rescued, affected
                "value": try_number(s.get("sendaivalue")),
                "country": s.get("country"),
                "region": s.get("region"),
                "onset_date": s.get("onset_date"),
                "expires_date": s.get("expires_date"),
                "effective_date": s.get("effective_date"),
                "description": s.get("description"),
                "raw": s,  # keep the raw if you need it
            }
        )
    return out


def summarize_flat_blocks(blocks: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Lightweight summary across common scalar names used by EQ/TC/WF payloads.
    (You can expand this to fit your UI.)
    """
    summary: Dict[str, Any] = {
        "population_affected": None,
        "sum_pop_bands": {},  # e.g. {"SUMPOP200.0": 2181, "SUMPOP175.0": 2121, ...}
    }
    # prefer POPAFFECTED if present
    for b in blocks:
        scalars = b.get("scalars", {})
        if "POPAFFECTED" in scalars:
            summary["population_affected"] = scalars["POPAFFECTED"]
        # collect SUMPOP* bands
        for k, v in scalars.items():
            if k.upper().startswith("SUMPOP"):
                summary["sum_pop_bands"][k] = v
    return summary


# ---------- main entry ----------


def normalize_gdacs_impacts(event_type: str, details: Dict[str, Any]) -> Dict[str, Any]:
    """
    Returns a normalized dict you can rely on for any GDACS event:
    {
      "event_type": "EQ|TC|FL|WF|...",
      "datasets": [  # for EQ/TC/WF: flattened results of impact URLs
         {"label": "NEIC:impact", "url": "...", "blocks": [...]} , ...
      ],
      "sendai": [...],   # for FL (and any event that happens to include Sendai)
      "summary": {...}   # quick high-level metrics extracted from datasets
    }
    """
    out: Dict[str, Any] = {
        "event_type": event_type,
        "datasets": [],
        "sendai": [],
        "summary": {},
    }

    # FL: use sendai (impacts may be empty)
    if event_type == "FL":
        out["sendai"] = parse_sendai_records(details)
        out["summary"] = {}  # you can compute totals here if you want
        return out

    # others: follow impact links
    links = extract_impact_links(event_type, details)
    datasets = []
    all_blocks: List[Dict[str, Any]] = []
    for label, url in links:
        try:
            payload = get_json(url)
            blocks = parse_impact_payload(payload)
            datasets.append({"label": label, "url": url, "blocks": blocks})
            all_blocks.extend(blocks)
        except Exception as e:
            datasets.append({"label": label, "url": url, "error": str(e), "blocks": []})

    out["datasets"] = datasets
    out["sendai"] = parse_sendai_records(
        details
    )  # some events also include sendai; harmless to add
    out["summary"] = summarize_flat_blocks(all_blocks)
    return out

# ---------- example usage ----------

# details_json = get_json("http://127.0.0.1:8000/get-gdacs-event-details/EQ/1497545/1657308/?expand_impacts=1&include_media=1")
# event_type = deep_get(details_json, ["details", "properties", "eventtype"]) or details_json.get("eventtype")
# normalized = normalize_gdacs_impacts(event_type, details_json)
# print(normalized)
GDACS_BASE = "https://www.gdacs.org/gdacsapi/api"
EONET_BASE = "https://eonet.gsfc.nasa.gov/api/v3"
USGS_BASE = "https://earthquake.usgs.gov/fdsnws/event/1"
GEOGLOWS_BASE = "https://geoglows.ecmwf.int/api"


def _safe_get_json(url, params=None, timeout=15):
    try:
        r = requests.get(url, params=params, timeout=timeout)
        if r.ok:
            return r.json()
    except requests.RequestException as e:
        print("GDACS JSON error:", url, e)
    return None


def _safe_geoglows_json(path, params=None, timeout=20):
    try:
        response = requests.get(
            f"{GEOGLOWS_BASE}{path}",
            params=params,
            timeout=timeout,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        return response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("GeoGLOWS JSON error for %s: %s", path, exc)
        return None


def _parse_geoglows_csv(text):
    stream = io.StringIO(text.strip())
    reader = csv.DictReader(stream)
    rows = list(reader)
    if not rows or not reader.fieldnames:
        return None

    label_field = next(
        (
            field
            for field in reader.fieldnames
            if field and field.lower() in {"datetime", "date", "time", "timestamp"}
        ),
        reader.fieldnames[0],
    )

    numeric_fields = []
    for field in reader.fieldnames:
        if not field or field == label_field:
            continue
        if any(
            row.get(field) not in (None, "", "nan", "NaN")
            and _is_numeric(row.get(field))
            for row in rows
        ):
            numeric_fields.append(field)

    if not numeric_fields:
        return rows

    if len(numeric_fields) == 1:
        value_field = numeric_fields[0]
        return [
            {
                "date": row.get(label_field),
                "value": float(row.get(value_field)),
            }
            for row in rows
            if row.get(value_field) not in (None, "", "nan", "NaN")
            and _is_numeric(row.get(value_field))
        ]

    grouped = {}
    for field in numeric_fields:
        grouped[field] = [
            {
                "date": row.get(label_field),
                "value": float(row.get(field)),
            }
            for row in rows
            if row.get(field) not in (None, "", "nan", "NaN")
            and _is_numeric(row.get(field))
        ]

    return grouped


def _safe_geoglows_payload(path, params=None, timeout=20):
    try:
        response = requests.get(
            f"{GEOGLOWS_BASE}{path}",
            params=params,
            timeout=timeout,
            headers={"Accept": "application/json,text/csv;q=0.9,*/*;q=0.8"},
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = getattr(getattr(exc, "response", None), "text", "") or str(exc)
        detail = str(detail).strip().replace("\n", " ")[:280]
        logger.warning("GeoGLOWS request error for %s: %s", path, detail)
        return None, detail

    content_type = (response.headers.get("Content-Type") or "").lower()
    text = response.text or ""
    trimmed = text.lstrip()

    if "json" in content_type or trimmed.startswith("{") or trimmed.startswith("["):
        try:
            return response.json(), None
        except ValueError as exc:
            logger.warning("GeoGLOWS JSON parse error for %s: %s", path, exc)

    parsed_csv = _parse_geoglows_csv(text)
    if parsed_csv is not None:
        return parsed_csv, None

    detail = trimmed[:280] or "GeoGLOWS returned an empty response"
    logger.warning("GeoGLOWS unsupported payload for %s: %s", path, detail)
    return None, detail


def _coerce_geoglows_dates(payload):
    def _normalize_date(value):
        if value in (None, ""):
            return None
        if isinstance(value, dict):
            for nested_value in value.values():
                normalized = _normalize_date(nested_value)
                if normalized:
                    return normalized
            return None

        text = str(value).strip()
        digits = "".join(ch for ch in text if ch.isdigit())
        if len(digits) >= 8:
            return digits[:8]
        return None

    if isinstance(payload, dict):
        for key in ("available_dates", "dates", "data"):
            value = payload.get(key)
            if isinstance(value, list):
                normalized = [_normalize_date(item) for item in value]
                return [item for item in normalized if item]
            normalized_single = _normalize_date(value)
            if normalized_single:
                return [normalized_single]
    if isinstance(payload, list):
        normalized = [_normalize_date(item) for item in payload]
        return [item for item in normalized if item]
    return []


def _get_recent_geoglows_dates(limit=5):
    today = timezone.now().date()
    min_allowed = today - timedelta(days=14)
    payload, _ = _safe_geoglows_payload("/v2/dates", timeout=15)
    dates = _coerce_geoglows_dates(payload)
    if dates:
        deduped = list(dict.fromkeys(dates))
        filtered = []
        for item in deduped:
            try:
                parsed = datetime.strptime(item, "%Y%m%d").date()
            except ValueError:
                continue
            if parsed >= min_allowed:
                filtered.append(item)
        if filtered:
            return filtered[-limit:]

    fallback = []
    for offset in range(1, limit + 1):
        fallback.append((today - timedelta(days=offset)).strftime("%Y%m%d"))
    return list(reversed(fallback))


def _get_preferred_geoglows_forecast_dates(limit=6):
    """
    Prefer very recent forecast runs first, matching the desired behavior:
    today or yesterday, then only a few earlier days if GeoGLOWS has not
    published/served the latest run yet.
    """
    today = timezone.now().date()
    preferred = []
    for offset in range(0, limit):
        preferred.append((today - timedelta(days=offset)).strftime("%Y%m%d"))
    return preferred


def _fetch_geoglows_with_date_fallback(path, request_params=None, timeout=25):
    params = dict(request_params or {})
    explicit_date = params.get("date")
    if explicit_date:
        payload, error_detail = _safe_geoglows_payload(path, params=params, timeout=timeout)
        if payload is not None:
            return payload, explicit_date, None
        return None, explicit_date, error_detail

    error_detail = None
    for forecast_date in _get_preferred_geoglows_forecast_dates(limit=6):
        retry_params = dict(params)
        retry_params["date"] = forecast_date
        payload, retry_error = _safe_geoglows_payload(
            path,
            params=retry_params,
            timeout=timeout,
        )
        if payload is not None:
            return payload, forecast_date, None
        error_detail = retry_error or error_detail

    # Secondary fallback: try any recent dates advertised by GeoGLOWS,
    # but keep them constrained to the recent window instead of drifting
    # to older runs.
    for forecast_date in reversed(_get_recent_geoglows_dates(limit=6)):
        retry_params = dict(params)
        retry_params["date"] = forecast_date
        payload, retry_error = _safe_geoglows_payload(
            path,
            params=retry_params,
            timeout=timeout,
        )
        if payload is not None:
            return payload, forecast_date, None
        error_detail = retry_error or error_detail

    return (
        None,
        None,
        error_detail
        or "No recent GeoGLOWS forecast was available within the last 14 days.",
    )


def _is_numeric(value):
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _extract_geoglows_river_id(payload):
    if isinstance(payload, (int, float)):
        return int(payload)

    if isinstance(payload, dict):
        for key in ("river_id", "reach_id", "comid", "id"):
            value = payload.get(key)
            if value not in (None, ""):
                try:
                    return int(float(value))
                except (TypeError, ValueError):
                    continue

        if len(payload) == 1:
            only_value = next(iter(payload.values()))
            return _extract_geoglows_river_id(only_value)

    if isinstance(payload, list) and payload:
        return _extract_geoglows_river_id(payload[0])

    return None


def _try_fetch_geojson(url, timeout=20):
    """
    Best-effort: some GDACS 'impact' endpoints return JSON/GeoJSON,
    others return zipped shapefiles or images. We only accept JSON here.
    """
    try:
        r = requests.get(url, timeout=timeout)
        ctype = r.headers.get("Content-Type", "")
        if r.ok and "application/json" in ctype:
            data = r.json()
            if isinstance(data, dict) and data.get("type") in (
                "Feature",
                "FeatureCollection",
            ):
                if data["type"] == "Feature":
                    return {"type": "FeatureCollection", "features": [data]}
                return data
    except requests.RequestException as e:
        print("Impact fetch failed:", url, e)
    except ValueError:
        pass
    return None


# ---- Existing list endpoint (unchanged behavior) ----
class GdacsEventsGeojsonApi(View):
    def get(self, request, event_slug):
        url = f"{GDACS_BASE}/events/geteventlist/MAP"
        params = {"eventtypes": event_slug}
        response_data = _safe_get_json(url, params) or {
            "type": "FeatureCollection",
            "features": [],
        }
        return JsonResponse(response_data)


def _safe_json_dumps(value):
    try:
        return json.dumps(value or [])
    except Exception:
        return "[]"


def _normalize_eonet_feature(feature):
    props = feature.get("properties", {}) or {}
    categories = props.get("categories") or []
    sources = props.get("sources") or []

    category_titles = ", ".join(
        [c.get("title", "") for c in categories if isinstance(c, dict) and c.get("title")]
    )
    category_ids = ", ".join(
        [c.get("id", "") for c in categories if isinstance(c, dict) and c.get("id")]
    )
    source_titles = ", ".join(
        [s.get("id", "") for s in sources if isinstance(s, dict) and s.get("id")]
    )
    source_urls = ", ".join(
        [
            s.get("url", "")
            for s in sources
            if isinstance(s, dict) and s.get("url")
        ]
    )

    normalized_props = {
        **props,
        "event_id": feature.get("id") or props.get("id"),
        "title": props.get("title") or "NASA EONET Event",
        "event_link": props.get("link"),
        "event_status": "Closed" if props.get("closed") else "Open",
        "category_titles": category_titles,
        "category_ids": category_ids,
        "source_titles": source_titles,
        "source_urls": source_urls,
        "categories_json": _safe_json_dumps(categories),
        "sources_json": _safe_json_dumps(sources),
        "magnitude_label": " ".join(
            [
                str(props.get("magnitudeValue", "")).strip(),
                str(props.get("magnitudeUnit", "")).strip(),
            ]
        ).strip(),
        "magnitude_description": props.get("magnitudeDescription"),
    }

    return {
        "type": "Feature",
        "id": feature.get("id"),
        "geometry": feature.get("geometry"),
        "properties": normalized_props,
    }


class NasaEonetEventsGeojsonApi(View):
    """
    NASA EONET v3 GeoJSON proxy.

    GET /get-nasa-eonet-events/<category_slug>/
    category_slug: all | severeStorms | wildfires | volcanoes | earthquakes | seaLakeIce

    Supported passthrough query params from EONET v3:
      - source
      - status
      - limit
      - days
      - start
      - end
      - magID
      - magMin
      - magMax
      - bbox
    """

    def get(self, request, category_slug="all"):
        params = {
            "status": request.GET.get("status", "open"),
            "days": request.GET.get("days", "60"),
            "limit": request.GET.get("limit", "200"),
        }

        passthrough_keys = [
            "source",
            "start",
            "end",
            "magID",
            "magMin",
            "magMax",
            "bbox",
        ]
        for key in passthrough_keys:
            value = request.GET.get(key)
            if value not in (None, ""):
                params[key] = value

        if category_slug and category_slug != "all":
            params["category"] = category_slug

        response_data = _safe_get_json(f"{EONET_BASE}/events/geojson", params) or {
            "type": "FeatureCollection",
            "features": [],
        }

        features = response_data.get("features", []) or []
        normalized = [_normalize_eonet_feature(feature) for feature in features]

        return JsonResponse(
            {
                "type": "FeatureCollection",
                "features": normalized,
            }
        )


def _usgs_default_starttime(days=2):
    return (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")


def _normalize_usgs_feature(feature):
    props = feature.get("properties", {}) or {}
    geometry = feature.get("geometry", {}) or {}
    coordinates = geometry.get("coordinates", []) or []
    depth = coordinates[2] if len(coordinates) > 2 else None

    normalized_props = {
        **props,
        "event_id": feature.get("id"),
        "depth_km": depth,
        "magnitude": props.get("mag"),
        "event_time_iso": datetime.utcfromtimestamp((props.get("time") or 0) / 1000).strftime("%Y-%m-%d %H:%M UTC") if props.get("time") else None,
        "updated_time_iso": datetime.utcfromtimestamp((props.get("updated") or 0) / 1000).strftime("%Y-%m-%d %H:%M UTC") if props.get("updated") else None,
        "usgs_detail_url": props.get("detail"),
        "usgs_event_url": props.get("url"),
        "felt_reports": props.get("felt"),
        "mmi_value": props.get("mmi"),
        "cdi_value": props.get("cdi"),
        "significance": props.get("sig"),
    }

    return {
        "type": "Feature",
        "id": feature.get("id"),
        "geometry": geometry,
        "properties": normalized_props,
    }


class UsgsEarthquakeAlertsGeojsonApi(View):
    """
    USGS realtime earthquake feed proxy with optimized defaults.
    Defaults to the last 2 days of events ordered by time.
    """

    def get(self, request):
        params = {
            "format": "geojson",
            "orderby": request.GET.get("orderby", "time"),
            "starttime": request.GET.get("starttime", _usgs_default_starttime(2)),
            "endtime": request.GET.get("endtime", datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")),
            "limit": request.GET.get("limit", "400"),
        }

        passthrough_keys = [
            "minmagnitude",
            "maxmagnitude",
            "minlatitude",
            "maxlatitude",
            "minlongitude",
            "maxlongitude",
            "latitude",
            "longitude",
            "maxradius",
            "maxradiuskm",
            "updatedafter",
        ]
        for key in passthrough_keys:
            value = request.GET.get(key)
            if value not in (None, ""):
                params[key] = value

        response_data = _safe_get_json(f"{USGS_BASE}/query", params) or {
            "type": "FeatureCollection",
            "metadata": {},
            "features": [],
        }

        features = response_data.get("features", []) or []
        normalized = [_normalize_usgs_feature(feature) for feature in features]

        return JsonResponse(
            {
                "type": "FeatureCollection",
                "metadata": response_data.get("metadata", {}),
                "features": normalized,
            }
        )


class UsgsEarthquakeDetailApi(View):
    def get(self, request, event_id):
        response_data = _safe_get_json(
            f"{USGS_BASE}/query",
            {"format": "geojson", "eventid": event_id},
        ) or {}
        return JsonResponse(response_data)


class UsgsShakemapContentProxyApi(View):
    def get(self, request):
        url = request.GET.get("url", "")
        if not url.startswith("https://earthquake.usgs.gov/"):
            return JsonResponse({"detail": "Invalid ShakeMap URL"}, status=400)

        try:
            response = requests.get(url, timeout=20)
            response.raise_for_status()
            payload = response.json()
            return JsonResponse(payload, safe=isinstance(payload, dict))
        except Exception as exc:
            return JsonResponse({"detail": f"Failed to load ShakeMap content: {exc}"}, status=502)


class GeoGlowsRiverIdApi(View):
    def get(self, request):
        lat = request.GET.get("lat")
        lon = request.GET.get("lon")

        if lat in (None, "") or lon in (None, ""):
            return JsonResponse({"detail": "lat and lon are required"}, status=400)

        try:
            lat_value = float(lat)
            lon_value = float(lon)
        except (TypeError, ValueError):
            return JsonResponse({"detail": "lat and lon must be numeric"}, status=400)

        payload = _safe_geoglows_json(
            "/v2/getriverid",
            {"lat": lat_value, "lon": lon_value},
        )
        if payload is None:
            return JsonResponse({"detail": "Failed to load GeoGLOWS river ID"}, status=502)

        river_id = _extract_geoglows_river_id(payload)
        if river_id is None:
            return JsonResponse(
                {"detail": "GeoGLOWS did not return a valid river ID", "raw": payload},
                status=502,
            )

        return JsonResponse(
            {
                "river_id": river_id,
                "selected_point": {"lat": lat_value, "lon": lon_value},
                "raw": payload,
            }
        )


class GeoGlowsForecastApi(View):
    def get(self, request, river_id):
        params = {"format": request.GET.get("format", "json")}
        date = request.GET.get("date")
        if date:
            params["date"] = date

        payload, resolved_date, error_detail = _fetch_geoglows_with_date_fallback(
            f"/v2/forecast/{river_id}",
            request_params=params,
            timeout=25,
        )
        if payload is None:
            return JsonResponse(
                {
                    "detail": "Failed to load GeoGLOWS forecast",
                    "upstream_detail": error_detail,
                },
                status=502,
            )

        return JsonResponse(
            {
                "river_id": river_id,
                "kind": "forecast",
                "date": resolved_date or params.get("date"),
                "raw": payload,
            },
            safe=True,
        )


class GeoGlowsForecastStatsApi(View):
    def get(self, request, river_id):
        params = {"format": request.GET.get("format", "json")}
        date = request.GET.get("date")
        if date:
            params["date"] = date

        payload, resolved_date, error_detail = _fetch_geoglows_with_date_fallback(
            f"/v2/forecaststats/{river_id}",
            request_params=params,
            timeout=25,
        )
        if payload is None:
            return JsonResponse(
                {
                    "detail": "Failed to load GeoGLOWS forecast statistics",
                    "upstream_detail": error_detail,
                },
                status=502,
            )

        return JsonResponse(
            {
                "river_id": river_id,
                "kind": "forecaststats",
                "date": resolved_date or params.get("date"),
                "raw": payload,
            },
            safe=True,
        )


class GeoGlowsDailyAveragesApi(View):
    def get(self, request, river_id):
        params = {"format": request.GET.get("format", "json")}
        payload, error_detail = _safe_geoglows_payload(
            f"/v2/dailyaverages/{river_id}",
            params=params,
            timeout=25,
        )
        if payload is None:
            return JsonResponse(
                {
                    "detail": "Failed to load GeoGLOWS daily averages",
                    "upstream_detail": error_detail,
                },
                status=502,
            )
        return JsonResponse(
            {"river_id": river_id, "kind": "dailyaverages", "raw": payload},
            safe=True,
        )


class GeoGlowsMonthlyAveragesApi(View):
    def get(self, request, river_id):
        params = {"format": request.GET.get("format", "json")}
        payload, error_detail = _safe_geoglows_payload(
            f"/v2/monthlyaverages/{river_id}",
            params=params,
            timeout=25,
        )
        if payload is None:
            return JsonResponse(
                {
                    "detail": "Failed to load GeoGLOWS monthly averages",
                    "upstream_detail": error_detail,
                },
                status=502,
            )
        return JsonResponse(
            {"river_id": river_id, "kind": "monthlyaverages", "raw": payload},
            safe=True,
        )


class GeoGlowsAnnualAveragesApi(View):
    def get(self, request, river_id):
        params = {"format": request.GET.get("format", "json")}
        payload, error_detail = _safe_geoglows_payload(
            f"/v2/annualaverages/{river_id}",
            params=params,
            timeout=25,
        )
        if payload is None:
            return JsonResponse(
                {
                    "detail": "Failed to load GeoGLOWS annual averages",
                    "upstream_detail": error_detail,
                },
                status=502,
            )
        return JsonResponse(
            {"river_id": river_id, "kind": "annualaverages", "raw": payload},
            safe=True,
        )


# ---- NEW: per-event details + optional impact polygons/media ----
class GdacsEventDetailsApi(View):
    """
    GET /get-gdacs-event-details/<eventtype>/<eventid>[/<episodeid>]/?expand_impacts=1&include_media=1
    Returns: { details: {...}, impacts_geojson?: FeatureCollection, media?: <GDACS EMM JSON> }
    """

    def get(self, request, event_type, event_id, episode_id=None):
        details = (
            _safe_get_json(
                f"{GDACS_BASE}/events/geteventdata",
                {"eventtype": event_type, "eventid": event_id},
            )
            or {}
        )

        expand_impacts = str(request.GET.get("expand_impacts", "")).lower() in (
            "1",
            "true",
            "yes",
        )
        include_media = str(request.GET.get("include_media", "")).lower() in (
            "1",
            "true",
            "yes",
        )

        result = {"details": details}
        # add a normalized summary usable by all hazards
        try:
            result["normalized_impacts"] = normalize_gdacs_impacts(event_type, details)
        except Exception as e:
            result["normalized_impacts_error"] = str(e)

        # Try to expand impact polygons (if any endpoint returns GeoJSON)
        if expand_impacts and isinstance(details, dict):
            collected = []
            for imp in details.get("impacts", []):
                res = (imp or {}).get("resource", {})
                # Typical keys we’ve seen in GDACS JSON
                for key in ("shakemap", "shake_preliminary", "impact"):
                    u = res.get(key)
                    if not u:
                        continue
                    gj = _try_fetch_geojson(u)
                    if gj and isinstance(gj.get("features"), list):
                        for f in gj["features"]:
                            props = f.setdefault("properties", {})
                            props.setdefault("eventtype", event_type)
                            props.setdefault("eventid", int(event_id))
                            props.setdefault("episodeid", int(episode_id or 0))
                            props.setdefault(
                                "impact_source", (imp.get("source") or key).upper()
                            )
                        collected.extend(gj["features"])
            if collected:
                result["impacts_geojson"] = {
                    "type": "FeatureCollection",
                    "features": collected,
                }

        # Optionally return media list (GDACS EMM) so you can render links inside popups
        if include_media:
            media_url = (details.get("url") or {}).get("media")
            if media_url:
                media_items = _safe_get_json(media_url)  # returns EMM JSON
                if media_items:
                    result["media"] = media_items

        return JsonResponse(result)
    
    

#----------------------GOOGLE EARTH ENGINE VIEWS HERE (ENHANCED)------------------------------
# ============================================================================
# GOOGLE EARTH ENGINE INITIALIZATION
# ============================================================================

GEE_PROJECT_ID = getattr(settings, 'GEE_PROJECT_ID', 'flood-mapping-dashboard-471116')

def initialize_earth_engine():
    """Initialize Earth Engine with error handling"""
    try:
        ee.Initialize(project=GEE_PROJECT_ID)
        print("=" * 60)
        print("✅ Google Earth Engine Initialized Successfully")
        print(f"   Project: {GEE_PROJECT_ID}")
        print("=" * 60)
        return True
    except Exception as e:
        print("=" * 60)
        print(f"❌ GEE Initialization Failed: {e}")
        print("=" * 60)
        return False

GEE_INITIALIZED = initialize_earth_engine()
# ============================================================================
# SEMANTIC SEARCH HELPER
# ============================================================================

class SemanticSearchHelper:
    """Enhanced semantic search for better dataset matching"""
    
    # Synonym mapping for better semantic understanding
    SYNONYM_MAP = {
        'flood': ['flooding', 'inundation', 'deluge', 'overflow', 'submersion', 'water logging'],
        'fire': ['wildfire', 'forest fire', 'burning', 'blaze', 'conflagration'],
        'drought': ['dry spell', 'water scarcity', 'arid conditions', 'water stress'],
        'landslide': ['mudslide', 'rockslide', 'slope failure', 'mass movement', 'landslip'],
        'cyclone': ['hurricane', 'typhoon', 'tropical storm', 'storm surge'],
        'earthquake': ['seismic', 'tremor', 'quake', 'tectonic activity'],
        'temperature': ['heat', 'thermal', 'hot', 'cold', 'climate'],
        'vegetation': ['greenery', 'plants', 'forest', 'crops', 'agriculture'],
        'water': ['aquatic', 'hydro', 'moisture', 'precipitation', 'rainfall'],
        'urban': ['city', 'metropolitan', 'built-up', 'developed area'],
        'snow': ['ice', 'glacier', 'frozen', 'winter'],
        'pollution': ['air quality', 'smog', 'contamination', 'aerosol'],
        'sea level': ['ocean rise', 'coastal flooding', 'submersion'],
        'heat island': ['urban heat', 'city heat', 'temperature anomaly'],
    }
    
    # Context patterns for better understanding
    CONTEXT_PATTERNS = {
        'risk': ['susceptibility', 'hazard', 'vulnerability', 'prone', 'exposure'],
        'current': ['latest', 'active', 'real-time', 'now', 'present'],
        'historical': ['past', 'archive', 'frequency', 'occurrence'],
        'future': ['projection', 'forecast', 'scenario', 'prediction'],
        'extent': ['area', 'coverage', 'spread', 'distribution'],
        'severity': ['intensity', 'magnitude', 'strength', 'power'],
    }
    
    @classmethod
    def expand_query(cls, query):
        """Expand query with synonyms and related terms"""
        query_lower = query.lower()
        expanded_terms = [query_lower]
        
        # Add synonyms
        for key, synonyms in cls.SYNONYM_MAP.items():
            if key in query_lower:
                expanded_terms.extend(synonyms)
            for syn in synonyms:
                if syn in query_lower:
                    expanded_terms.append(key)
                    expanded_terms.extend(synonyms)
        
        # Add context patterns
        for context, patterns in cls.CONTEXT_PATTERNS.items():
            if any(pattern in query_lower for pattern in patterns):
                expanded_terms.extend(patterns)
        
        return list(set(expanded_terms))
    
    @classmethod
    def calculate_semantic_score(cls, query, dataset):
        """Calculate semantic similarity score between query and dataset"""
        query_lower = query.lower()
        expanded_query = cls.expand_query(query)
        
        score = 0
        
        # 1. Direct keyword matching (highest weight)
        for keyword in dataset['keywords']:
            if keyword in query_lower:
                word_count = len(keyword.split())
                score += 10 if word_count > 1 else 5
        
        # 2. Expanded term matching (medium weight)
        for term in expanded_query:
            for keyword in dataset['keywords']:
                if term in keyword or keyword in term:
                    score += 3
        
        # 3. Description matching (lower weight)
        description = dataset.get('description', '').lower()
        for term in expanded_query[:5]:  # Use top 5 expanded terms
            if term in description:
                score += 2
        
        # 4. Fuzzy matching for typos (lowest weight)
        for keyword in dataset['keywords']:
            similarity = SequenceMatcher(None, query_lower, keyword).ratio()
            if similarity > 0.7:
                score += int(similarity * 5)
        
        # 5. Type matching bonus
        if 'susceptibility' in query_lower and 'susceptibility' in dataset['type']:
            score += 8
        if 'hazard' in query_lower and 'hazard' in dataset['type']:
            score += 8
        if 'active' in query_lower or 'current' in query_lower:
            if dataset.get('time_filter') == 'latest':
                score += 5
        
        return score

# ============================================================================
# ENHANCED GEE DATA CATALOG - MORE ENVIRONMENTAL DATASETS
# ============================================================================
class GEEDataCatalog:
    """Advanced hazard management system with semantic search + Environmental Monitoring"""
    
    PAKISTAN_BOUNDS = [60.872, 23.634, 77.837, 37.097] 
    # EXPANDED PAKISTAN LOCATIONS (55+)
    LOCATIONS = {
        # --- National / Provincial ---
        'pakistan': [60.5, 23.3, 77.9, 37.3],
        'punjab': [69.0, 27.0, 75.8, 34.5],
        'sindh': [66.0, 23.3, 71.2, 28.7],
        'kpk': [69.0, 31.0, 74.8, 36.8],
        'khyber_pakhtunkhwa': [69.0, 31.0, 74.8, 36.8],
        'balochistan': [60.5, 24.0, 70.7, 32.2],
        'gilgit_baltistan': [72.0, 34.0, 78.0, 37.3],
        'azad_kashmir': [73.2, 33.3, 75.6, 35.2],
        'fata': [67.5, 31.0, 71.7, 35.5],

        # --- Major Cities ---
        'islamabad': [72.8, 33.5, 73.3, 33.9],
        'rawalpindi': [73.0, 33.5, 73.3, 33.8],
        'lahore': [74.0, 31.3, 74.6, 31.7],
        'faisalabad': [72.8, 31.2, 73.3, 31.6],
        'multan': [71.2, 30.0, 71.8, 30.5],
        'bahawalpur': [71.4, 29.1, 72.1, 29.6],
        'sargodha': [72.5, 31.8, 73.0, 32.3],
        'gujranwala': [74.0, 32.0, 74.4, 32.4],
        'sialkot': [74.3, 32.3, 74.8, 32.8],
        'karachi': [66.8, 24.7, 67.4, 25.3],
        'hyderabad': [68.2, 25.2, 68.6, 25.6],
        'sukkur': [68.7, 27.5, 69.2, 28.0],
        'larkana': [67.9, 27.3, 68.4, 27.8],
        'quetta': [66.8, 30.0, 67.3, 30.4],
        'gwadar': [62.2, 24.8, 62.6, 25.4],
        'turbat': [62.9, 25.8, 63.4, 26.3],
        'peshawar': [71.3, 33.9, 71.9, 34.2],
        'mardan': [72.0, 34.0, 72.3, 34.4],
        'abbottabad': [73.0, 34.0, 73.4, 34.3],
        'swat': [71.8, 34.5, 72.8, 35.7],
        'gilgit': [74.2, 35.7, 74.7, 36.2],
        'skardu': [75.4, 35.1, 76.0, 35.6],
        'hunza': [74.3, 35.9, 75.0, 36.5],
        'muzaffarabad': [73.3, 34.2, 73.6, 34.5],
        'mirpur': [73.7, 33.1, 74.1, 33.4],

        # --- Pakistan Major River Systems ---
        'indus_river': [66.5, 23.5, 75.0, 36.5],
        'upper_indus': [73.0, 34.5, 77.5, 36.5],
        'lower_indus': [67.0, 23.5, 69.5, 28.5],

        'jhelum_river': [73.1, 33.0, 75.7, 35.5],
        'chenab_river': [71.2, 29.0, 75.0, 33.2],
        'ravi_river': [73.5, 29.5, 75.7, 32.8],
        'sutlej_river': [71.0, 28.0, 75.0, 31.5],
        'kabul_river': [70.8, 33.4, 72.7, 34.9],
        'swat_river': [71.5, 34.5, 72.5, 35.5],

        'panjnad_river': [70.3, 28.6, 71.4, 29.5],

        # --- Secondary Rivers (Flood-Prone) ---
        'gilgit_river': [74.0, 35.5, 74.9, 36.3],
        'shyok_river': [75.0, 34.8, 77.0, 35.8],
        'astore_river': [74.5, 35.1, 75.2, 35.7],
        'ghizer_river': [73.2, 36.0, 74.5, 36.8],
        'dasht_river': [62.0, 25.0, 63.3, 26.7],
        'hub_river': [66.3, 24.0, 67.1, 25.2],
        'zhob_river': [67.0, 30.0, 69.0, 32.0],
        'gomal_river': [69.0, 31.0, 70.5, 33.0],
        'kurram_river': [69.5, 33.5, 70.7, 34.8],
        'tochi_river': [69.5, 32.8, 70.8, 33.8],

        # --- Deltas & Wetlands ---
        'indus_delta': [67.1, 23.4, 68.2, 24.7],
        'manchar_lake': [67.4, 26.3, 67.9, 26.7],
        'hamun_mashkel': [62.8, 27.5, 64.3, 29.0],

        # --- Critical Mountain / GLOF Basins ---
        'shigar_valley': [75.4, 35.2, 76.2, 36.0],
        'nagar_valley': [74.2, 36.0, 75.0, 36.6],
        'chitral_valley': [71.3, 35.2, 72.7, 36.9],
        'ghizer_valley': [72.8, 35.8, 74.5, 36.8],
        'attabad_lake': [74.4, 35.9, 74.6, 36.2],
        'shishper_glacier': [74.5, 36.2, 74.7, 36.4],
        'badswat_glof_zone': [72.5, 35.1, 73.2, 35.8],

        # --- Plains / Basins ---
        'punjab_plains': [70.5, 28.0, 74.8, 33.3],
        'khyber_basin': [70.5, 33.0, 72.3, 34.8],
        'murree_hills': [73.3, 33.8, 73.6, 34.1],
        'salt_range': [71.5, 31.0, 73.5, 32.7],

        # --- Special Hazard Zones ---
        'glof_hotspots': [72.8, 34.8, 76.0, 36.8],
        'monsoon_core_zone': [69.0, 28.0, 75.0, 33.0],
        'makran_coastal_belt': [61.5, 24.0, 65.0, 26.5],
    }

    
    # ========================================================================
    # COMPREHENSIVE HAZARD-SPECIFIC DATASETS WITH ENRICHED METADATA
    # ========================================================================
    
    DATASETS = {
        # ====================================================================
        # FLOOD HAZARDS - REAL FLOOD DATA (HIGH PRIORITY)
        # ====================================================================
        'flood_sar_extent': {
            'name': 'Flood Extent (Sentinel-1 SAR)',
            'collection': 'COPERNICUS/S1_GRD',
            'compute': lambda img: img.select('VV').lt(-15).selfMask().rename('Flood_SAR'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffffff', '0000ff']},
            'type': 'hazard_flood',
            'priority': 10,
            'keywords': [
                'flood extent', 'flooding', 'inundation', 'flood mapping', 'flooded area', 
                'water extent', 'flood detection', 'active flooding', 'current flood',
                'real-time flood', 'flood monitoring', 'water logging', 'submersion',
                'overflow', 'deluge', 'flood zone'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Flood+Extent+(SAR)&palette=ffffff,0000ff&min=0&max=1',
            'description': 'Sentinel-1 SAR detects active flooding using radar backscatter. Shows current inundated areas regardless of cloud cover - essential for emergency response during monsoon floods.',
            'supports_temporal': True,
            'temporal_range': 'monthly',
            'temporal_start_year': 2014,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'water-related',
                'urgency': 'high',
                'use_cases': ['emergency response', 'flood mapping', 'disaster assessment'],
                'data_source': 'satellite radar',
                'update_frequency': 'daily'
            }
        },
        'flood_occurrence': {
            'name': 'Flood Frequency (JRC)',
            'collection': 'JRC/GSW1_4/GlobalSurfaceWater',
            'compute': lambda img: img.select('occurrence').rename('Flood_Frequency'),
            'vis': {'min': 0, 'max': 100, 'palette': ['ffffff', 'ffffcc', 'c7e9b4', '7fcdbb', '41b6c4', '1d91c0', '225ea8', '0c2c84']},
            'type': 'hazard_flood',
            'priority': 9,
            'keywords': [
                'flood occurrence', 'flood frequency', 'historical flooding', 'flood history', 
                'recurring flood', 'permanent water', 'flood probability', 'flood recurrence',
                'chronic flooding', 'repeat flooding', 'flood pattern', 'flood statistics',
                'long-term flood', 'persistent flooding'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Frequency+%25&palette=ffffff,7fcdbb,225ea8,0c2c84&min=0&max=100',
            'description': 'Historical flood frequency from 1984-2021. Shows how often an area has been underwater - higher % means more frequent flooding risk. Essential for long-term planning and identifying chronic flood zones.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'water-related',
                'temporal_scope': 'historical',
                'use_cases': ['urban planning', 'risk assessment', 'insurance'],
                'data_source': 'landsat archive'
            }
        },
        'flood_susceptibility_ahp': {
            'name': 'Flood Susceptibility (AHP Multi-Criteria)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_flood',
            'vis': {'min': 0, 'max': 1, 'palette': ['00ff00', '7fff00', 'ffff00', 'ff7f00', 'ff0000', '8b0000']},
            'type': 'susceptibility_flood',
            'priority': 8,
            'keywords': [
                'flood susceptibility', 'flood risk', 'flood prone', 'flood hazard', 'floodplain', 
                'flood vulnerability', 'flood-prone areas', 'flood risk zones', 'flood danger',
                'flood exposure', 'flood likelihood', 'flood potential', 'flood threat',
                'flood-sensitive areas', 'at-risk areas'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Susceptibility+(AHP)&palette=00ff00,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'elevation': 0.30,
                'slope': 0.25,
                'rainfall': 0.20,
                'distance_water': 0.15,
                'soil_moisture': 0.10
            },
            'description': 'Multi-criteria flood risk combining elevation, slope, rainfall, proximity to water, and soil saturation. Red zones are high-risk floodplains where multiple factors increase vulnerability.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'water-related',
                'analysis_type': 'multi-criteria',
                'use_cases': ['risk assessment', 'land use planning', 'disaster preparedness'],
                'methodology': 'AHP weighted analysis'
            }
        },
        'flood_depth_proxy': {
            'name': 'Potential Flood Depth (Elevation-based)',
            'collection': 'COPERNICUS/DEM/GLO30',
            'compute': lambda img: ee.Image(50).subtract(img.select('DEM')).clamp(0, 50).rename('Flood_Depth'),
            'vis': {'min': 0, 'max': 20, 'palette': ['ffffff', 'c7e9b4', '7fcdbb', '41b6c4', '1d91c0', '225ea8', '0c2c84']},
            'type': 'susceptibility_flood',
            'priority': 7,
            'keywords': [
                'flood depth', 'inundation depth', 'flood level', 'water depth',
                'submersion depth', 'flood height', 'water level', 'flooding severity'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Depth+(m)&palette=ffffff,7fcdbb,225ea8,0c2c84&min=0&max=20',
            'description': 'Estimated flood depth based on elevation. Lower areas (blues/purples) could experience deeper inundation during major floods - critical for evacuation planning.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'water-related',
                'measurement': 'depth estimate',
                'use_cases': ['evacuation planning', 'infrastructure design']
            }
        },
        
        # ====================================================================
        # WILDFIRE HAZARDS - REAL FIRE DATA (HIGH PRIORITY)
        # ====================================================================
        'active_fire_viirs': {
            'name': 'Active Fires (VIIRS 375m)',
            'collection': 'FIRMS',
            'compute': lambda img: img.select('T21').gt(300).selfMask().rename('Active_Fire'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'hazard_fire',
            'priority': 10,
            'keywords': [
                'active fire', 'fire detection', 'burning', 'flames', 'fire hotspot', 
                'thermal anomaly', 'wildfire', 'forest fire', 'current fire', 'real-time fire',
                'fire outbreak', 'conflagration', 'blaze', 'inferno', 'fire incident',
                'burning areas', 'fire location', 'fire alert'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Active+Fires+(VIIRS)&palette=ffff00,ff0000,8b0000&min=0&max=1',
            'description': 'Real-time fire hotspots detected by VIIRS satellite. Shows active burning locations updated daily - critical for emergency response and firefighting coordination.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2012,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'fire-related',
                'urgency': 'critical',
                'use_cases': ['emergency response', 'firefighting', 'real-time monitoring'],
                'data_source': 'thermal satellite',
                'update_frequency': 'daily'
            }
        },
        'active_fire_modis': {
            'name': 'Active Fire (MODIS)',
            'collection': 'MODIS/061/MOD14A1',
            'compute': lambda img: img.select('FireMask').rename('Fire'),
            'vis': {
                'min': 7, 'max': 9,
                'palette': ['ffff00', 'ff6600', 'ff0000', '8b0000']
            },
            'type': 'fire',
            'keywords': [
                'fire', 'wildfire', 'forest fire', 'active fire', 'burning', 'modis',
                'fire detection', 'fire hotspots', 'fire monitoring', 'thermal anomaly',
                'fire alert', 'fire activity', 'fire outbreak', 'conflagration', 'blaze',
                'fire incident', 'fire location', 'fire intensity', 'smoke', 'burning areas'
            ],
            'time_filter': True,
            'legend': '/api/gee/legend/?dataset=Active+Fire+(MODIS)&palette=ffff00,ff6600,ff0000,8b0000&min=7&max=9',
            'description': 'Daily active fire detections from MODIS Terra (2000-present). 1km resolution thermal anomaly detection. Values: 7=low confidence, 8=nominal, 9=high confidence fire. Essential for fire monitoring, early warning, and emergency response.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'temporal_note': 'Daily product from Terra satellite, near real-time with ~3 hour latency.',
            'semantic_context': {
                'indicator': 'fire_hazard',
                'use_cases': [
                    'fire monitoring', 'wildfire detection', 'fire early warning',
                    'fire incident mapping', 'emergency response', 'fire activity tracking',
                    'agricultural burning monitoring', 'air quality assessment', 'smoke detection'
                ],
                'temporal_note': 'Near real-time daily fire detection'
            }
        },
        'fire_radiative_power': {
            'name': 'Fire Radiative Power (MODIS)',
            'collection': 'MODIS/061/MOD14A1',
            'compute': lambda img: img.select('MaxFRP').rename('Fire_Power'),
            'vis': {'min': 0, 'max': 500, 'palette': ['000000', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'hazard_fire',
            'priority': 9,
            'keywords': [
                'fire intensity', 'fire power', 'fire energy', 'frp', 'fire strength',
                'fire magnitude', 'heat release', 'fire severity', 'burn intensity',
                'fire force', 'thermal output'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Fire+Power+(MW)&palette=000000,ff8c00,8b0000&min=0&max=500',
            'description': 'Fire intensity measured in megawatts. Higher values (red) indicate more intense fires with greater heat release and destructive potential - helps prioritize response.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'fire-related',
                'measurement': 'energy output',
                'use_cases': ['fire assessment', 'resource allocation', 'damage prediction']
            }
        },
        'fire_susceptibility_ahp': {
            'name': 'Fire Susceptibility (AHP Multi-Criteria)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_fire',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_fire',
            'priority': 8,
            'keywords': [
                'fire susceptibility', 'fire risk', 'fire hazard', 'fire prone', 'wildfire risk', 
                'burn probability', 'fire danger', 'fire-prone areas', 'fire vulnerability',
                'ignition risk', 'fire potential', 'combustion risk', 'fire threat'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Fire+Susceptibility+(AHP)&palette=006400,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'vegetation_dryness': 0.35,
                'temperature': 0.25,
                'slope': 0.20,
                'wind_exposure': 0.15,
                'distance_settlement': 0.05
            },
            'description': 'Wildfire risk based on dry vegetation, temperature, terrain, and human activity. Red zones have conditions favorable for fire ignition and spread.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'fire-related',
                'analysis_type': 'multi-criteria',
                'use_cases': ['prevention planning', 'resource positioning', 'land management']
            }
        },
        'burned_area': {
            'name': 'Burned Area (MODIS)',
            'collection': 'MODIS/061/MCD64A1',
            'compute': lambda img: img.select('BurnDate').gt(0).selfMask().rename('Burned'),
            'vis': {'min': 0, 'max': 366, 'palette': ['000000', '8b4513', 'ff8c00', 'ff0000']},
            'type': 'hazard_fire',
            'priority': 7,
            'keywords': [
                'burned area', 'fire scar', 'post fire', 'burn extent', 'burnt land',
                'fire damage', 'combusted area', 'charred land', 'fire footprint',
                'burn perimeter', 'fire-affected area'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Burned+Area&palette=000000,ff8c00,ff0000&min=0&max=366',
            'description': 'Areas that have burned recently. Shows fire scars and helps assess post-fire recovery needs and environmental impact.',
            'supports_temporal': True,
            'temporal_range': 'monthly',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'fire-related',
                'temporal_scope': 'historical',
                'use_cases': ['recovery assessment', 'rehabilitation planning']
            }
        },
        # ========================================================================
        # OPTICAL IMAGERY
        # ========================================================================
    
        'sentinel2': {
            'name': 'Sentinel-2 (True Color)',
            'collection': 'COPERNICUS/S2_SR_HARMONIZED',
            'compute': lambda img: img.select(['B4', 'B3', 'B2']).divide(10000),
            'vis': {
                'min': 0, 'max': 0.3,
                'bands': ['B4', 'B3', 'B2']
            },
            'type': 'optical',
            'keywords': [
                'sentinel-2', 'optical', 'imagery', 'multispectral', 'rgb', 'true color',
                'satellite imagery', 'earth observation', 'high resolution', 'land monitoring',
                'surface reflectance', 'cloud-free', 'vegetation mapping', 'water detection',
                'urban mapping', 'change detection', 'visual interpretation'
            ],
            'time_filter': True,
            'legend': None,
            'description': 'High-resolution optical imagery from Sentinel-2 satellites (2017-present). 10m resolution true color composite. 5-day revisit with both 2A and 2B satellites. Excellent for visual interpretation, change detection, and detailed land cover mapping.',
            'supports_temporal': True,
            'temporal_range': '5-day',
            'temporal_start_year': 2017,
            'temporal_end_year': 2024,
            'temporal_note': 'Sentinel-2A (2015) + 2B (2017) provide 5-day revisit. Global coverage.',
            'semantic_context': {
                'indicator': 'land_surface',
                'use_cases': [
                    'visual interpretation', 'change detection', 'land cover mapping',
                    'damage assessment', 'infrastructure monitoring', 'urban planning',
                    'agriculture monitoring', 'water body detection', 'disaster mapping'
                ],
                'temporal_note': 'High-frequency 5-day revisit for change monitoring'
            }
        },
    
        'landsat8': {
            'name': 'Landsat 8 (True Color)',
            'collection': 'LANDSAT/LC08/C02/T1_L2',
            'compute': lambda img: img.select(['SR_B4', 'SR_B3', 'SR_B2']).multiply(0.0000275).add(-0.2),
            'vis': {
                'min': 0, 'max': 0.3,
                'bands': ['SR_B4', 'SR_B3', 'SR_B2']
            },
            'type': 'optical',
            'keywords': [
                'landsat', 'landsat 8', 'optical', 'imagery', 'multispectral', 'rgb',
                'true color', 'satellite imagery', 'moderate resolution', 'land monitoring',
                'historical archive', 'long-term monitoring', 'change detection',
                'surface reflectance', 'multi-temporal', 'time series'
            ],
            'time_filter': True,
            'legend': None,
            'description': 'Landsat 8 optical imagery (2013-present). 30m resolution true color composite. 16-day revisit. Part of the continuous Landsat archive since 1972, enabling long-term change analysis when combined with Landsat 4-7.',
            'supports_temporal': True,
            'temporal_range': '16-day',
            'temporal_start_year': 2013,
            'temporal_end_year': 2024,
            'temporal_note': 'Landsat 8 launched Feb 2013. 16-day repeat cycle.',
            'semantic_context': {
                'indicator': 'land_surface',
                'use_cases': [
                    'long-term change analysis', 'historical comparison', 'land cover change',
                    'vegetation monitoring', 'water resource monitoring', 'urban expansion',
                    'time series analysis', 'baseline assessment'
                ],
                'temporal_note': 'Part of 50+ year Landsat archive'
            }
        },
        
        # ====================================================================
        # LANDSLIDE HAZARDS - MULTI-CRITERIA AHP
        # ====================================================================
        'landslide_susceptibility_ahp': {
            'name': 'Landslide Susceptibility (AHP)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_landslide',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_landslide',
            'priority': 10,
            'keywords': [
                'landslide susceptibility', 'landslide risk', 'landslip', 'mass movement', 
                'slope failure', 'hillside hazard', 'mudslide risk', 'rockslide', 'debris flow',
                'slope instability', 'land collapse', 'earth movement', 'slope hazard',
                'gravitational hazard', 'slope susceptibility'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Landslide+Susceptibility+(AHP)&palette=006400,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'slope': 0.35,
                'aspect': 0.15,
                'elevation': 0.15,
                'soil_moisture': 0.20,
                'rainfall': 0.15
            },
            'description': 'Landslide risk from steep slopes, rainfall, soil saturation, and terrain. Red areas in mountainous regions are most vulnerable to slope failures.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'geological',
                'terrain_focus': 'mountainous',
                'use_cases': ['infrastructure planning', 'early warning', 'risk mitigation']
            }
        },
        'slope_angle': {
            'name': 'Slope Angle (Degrees)',
            'collection': 'USGS/SRTMGL1_003',
            'compute': lambda img: ee.Terrain.slope(img.select('elevation')).rename('Slope'),
            'vis': {'min': 0, 'max': 45, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'terrain',
            'priority': 6,
            'keywords': [
                'slope', 'steepness', 'grade', 'incline', 'terrain angle', 'hillslope',
                'gradient', 'declivity', 'pitch', 'terrain steepness'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Slope+(degrees)&palette=006400,ffff00,ff0000&min=0&max=45',
            'description': 'Terrain steepness in degrees. Slopes > 25° (red) are prone to landslides, especially during heavy rainfall or earthquakes.',
            'supports_temporal': False,
            'semantic_context': {
                'measurement': 'angle',
                'use_cases': ['stability analysis', 'construction planning']
            }
        },
        
        # ====================================================================
        # CYCLONE/STORM HAZARDS - METEOROLOGICAL DATA
        # ====================================================================
        'wind_speed_era5': {
            'name': 'Wind Speed (ERA5 10m)',
            'collection': 'ECMWF/ERA5_LAND/DAILY_AGGR',
            'compute': lambda img: img.select('u_component_of_wind_10m').pow(2).add(
                img.select('v_component_of_wind_10m').pow(2)
            ).sqrt().rename('Wind_Speed'),
            'vis': {'min': 0, 'max': 20, 'palette': ['ffffff', 'c6dbef', '6baed6', '3182bd', '08519c', '08306b']},
            'type': 'hazard_cyclone',
            'priority': 10,
            'keywords': [
                'wind speed', 'wind', 'cyclone', 'storm', 'tropical storm', 'gale',
                'windstorm', 'hurricane', 'typhoon', 'wind velocity', 'gust', 'breeze',
                'wind intensity', 'atmospheric circulation'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Wind+Speed+(m/s)&palette=ffffff,6baed6,08519c&min=0&max=20',
            'description': 'Wind speed at 10m height from ERA5 reanalysis. Darker blues indicate stronger winds - useful for storm tracking and cyclone forecasting.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 1950,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'meteorological',
                'measurement': 'velocity',
                'use_cases': ['storm tracking', 'cyclone forecasting', 'wind energy']
            }
        },
        'cyclone_susceptibility_ahp': {
            'name': 'Cyclone Susceptibility (Coastal AHP)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_cyclone',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_cyclone',
            'priority': 9,
            'keywords': [
                'cyclone susceptibility', 'cyclone risk', 'storm surge', 'coastal hazard', 
                'tropical cyclone risk', 'hurricane risk', 'typhoon risk', 'storm vulnerability',
                'coastal flooding', 'storm impact', 'cyclone exposure'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Cyclone+Susceptibility&palette=006400,ffff00,ff0000&min=0&max=1',
            'ahp_weights': {
                'coastal_elevation': 0.40,
                'distance_coast': 0.30,
                'population': 0.20,
                'wind_exposure': 0.10
            },
            'description': 'Coastal cyclone risk from low elevation, proximity to coast, and population exposure. Red zones face severe storm surge and wind damage threats.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'meteorological',
                'location_focus': 'coastal',
                'use_cases': ['coastal management', 'evacuation planning', 'storm preparedness']
            }
        },
        
        # ====================================================================
        # EARTHQUAKE HAZARDS - TERRAIN PROXY
        # ====================================================================
        'seismic_susceptibility_ahp': {
            'name': 'Seismic Susceptibility (Terrain-based)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_seismic',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_seismic',
            'priority': 10,
            'keywords': [
                'earthquake', 'seismic', 'tectonic', 'fault', 'earthquake risk', 'seismic hazard',
                'tremor', 'quake', 'seismic activity', 'ground shaking', 'seismic vulnerability',
                'earthquake susceptibility', 'tectonic hazard', 'seismic zone'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Seismic+Susceptibility&palette=006400,ffff00,ff0000&min=0&max=1',
            'ahp_weights': {
                'elevation': 0.30,
                'slope': 0.30,
                'geology_proxy': 0.25,
                'population': 0.15
            },
            'description': 'Earthquake vulnerability based on mountainous terrain and population exposure. Red zones in northern Pakistan face highest seismic risks due to active tectonics.',
            'supports_temporal': False,
            'semantic_context': {
                'hazard_type': 'geological',
                'terrain_focus': 'mountainous',
                'use_cases': ['building codes', 'seismic design', 'emergency preparedness']
            }
        },
        
        # ====================================================================
        # DROUGHT HAZARDS - COMPOSITE INDICES
        # ====================================================================
        'drought_severity_composite': {
            'name': 'Drought Severity (Composite Index)',
            'collection': 'COMPOSITE',
            'compute': 'composite_drought',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'hazard_drought',
            'priority': 10,
            'keywords': [
                'drought', 'drought severity', 'dry conditions', 'water stress', 'arid', 'dryness',
                'water scarcity', 'dry spell', 'arid conditions', 'water deficit', 'aridity',
                'drought intensity', 'moisture deficit', 'agricultural drought', 'hydrological drought'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Drought+Severity&palette=006400,ffff00,ff0000&min=0&max=1',
            'weights': {
                'vegetation_health': 0.40,
                'soil_moisture': 0.30,
                'precipitation_deficit': 0.30
            },
            'description': 'Drought conditions from vegetation stress, dry soils, and low rainfall. Red areas face severe agricultural and water supply impacts.',
            'supports_temporal': True,
            'temporal_range': 'monthly',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'hazard_type': 'climatic',
                'impact_scope': 'agriculture and water',
                'use_cases': ['crop monitoring', 'water management', 'food security']
            }
        },
        
        # ====================================================================
        # 🔥 ENHANCED ENVIRONMENTAL INDICES
        # ====================================================================
        'lst_enhanced': {
            'name': 'Land Surface Temperature (Enhanced)',
            'collection': 'MODIS/061/MOD11A1',
            'compute': lambda img: img.select('LST_Day_1km').multiply(0.02).subtract(273.15).rename('LST'),
            'vis': {'min': 0, 'max': 50, 'palette': ['313695', '4575b4', '74add1', 'abd9e9', 'e0f3f8', 'ffffbf', 'fee090', 'fdae61', 'f46d43', 'd73027', 'a50026']},
            'type': 'environmental',
            'priority': 8,
            'keywords': [
                'land surface temperature', 'temperature', 'heat', 'thermal', 'lst', 'surface heat', 
                'warming', 'ground temperature', 'surface temp', 'hot', 'heat stress', 'thermal stress',
                'temperature anomaly', 'heat wave'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Land+Surface+Temp+(°C)&palette=313695,abd9e9,ffffbf,d73027,a50026&min=0&max=50',
            'description': 'Daytime land surface temperature from MODIS. Red zones (40°C+) indicate extreme heat - critical for urban planning and heat stress monitoring.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'measurement': 'temperature celsius',
                'use_cases': ['heat monitoring', 'urban planning', 'climate analysis']
            }
        },
        
        'urban_heat_island': {
            'name': 'Urban Heat Island Index (UHII)',
            'collection': 'COMPOSITE',
            'compute': 'compute_uhii',
            'vis': {'min': -5, 'max': 15, 'palette': ['2166ac', '4393c3', '92c5de', 'd1e5f0', 'f7f7f7', 'fddbc7', 'f4a582', 'd6604d', 'b2182b']},
            'type': 'environmental',
            'priority': 9,
            'keywords': [
                'urban heat island', 'uhii', 'city heat', 'urban temperature', 'heat island effect', 
                'urban warming', 'metropolitan heat', 'city temperature', 'urban thermal',
                'heat accumulation', 'urban climate', 'microclimate'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Urban+Heat+Island+(°C+above+rural)&palette=2166ac,f7f7f7,b2182b&min=-5&max=15',
            'description': 'Temperature difference between urban and rural areas. Red zones show cities 10-15°C hotter than surroundings - indicates poor ventilation and lack of green space.',
            'supports_temporal': False,
            'semantic_context': {
                'phenomenon': 'urban climate',
                'use_cases': ['urban design', 'green infrastructure', 'public health']
            }
        },
        
        'sea_level_rise_2050': {
            'name': 'Sea Level Rise Scenario (2050)',
            'collection': 'COMPOSITE',
            'compute': 'compute_slr_2050',
            'vis': {'min': 0, 'max': 3, 'palette': ['006d2c', '31a354', '74c476', 'a1d99b', 'c7e9c0', 'edf8e9', 'fee5d9', 'fcae91', 'fb6a4a', 'de2d26', 'a50f15']},
            'type': 'environmental',
            'priority': 10,
            'keywords': [
                'sea level rise', 'slr', 'coastal flooding', 'ocean rise', 'climate change', 
                'coastal risk', 'submersion', 'inundation projection', 'coastal vulnerability',
                'sea encroachment', 'coastal erosion', 'future flooding', '2050 scenario'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Sea+Level+Rise+(meters)&palette=006d2c,edf8e9,a50f15&min=0&max=3',
            'description': 'Projected coastal inundation from 1-3m sea level rise by 2050. Red areas in Karachi, Gwadar, and Indus Delta face severe flooding risk under climate scenarios.',
            'supports_temporal': False,
            'semantic_context': {
                'temporal_scope': 'future projection',
                'location_focus': 'coastal',
                'use_cases': ['climate adaptation', 'coastal management', 'infrastructure planning']
            }
        },
        
        'sea_level_rise_2100': {
            'name': 'Sea Level Rise Scenario (2100)',
            'collection': 'COMPOSITE',
            'compute': 'compute_slr_2100',
            'vis': {'min': 0, 'max': 5, 'palette': ['006d2c', '31a354', '74c476', 'a1d99b', 'c7e9c0', 'edf8e9', 'fee5d9', 'fcae91', 'fb6a4a', 'de2d26', 'a50f15']},
            'type': 'environmental',
            'priority': 9,
            'keywords': [
                'sea level rise 2100', 'long term flooding', 'future coastal risk', 'climate projection',
                'century projection', 'extreme scenario', 'worst case', 'long-term impact'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Sea+Level+Rise+2100+(meters)&palette=006d2c,edf8e9,a50f15&min=0&max=5',
            'description': 'Worst-case sea level rise projection (up to 5m) by 2100. Shows catastrophic coastal flooding potential - critical for long-term infrastructure planning.',
            'supports_temporal': False,
            'semantic_context': {
                'temporal_scope': 'long-term future',
                'scenario_type': 'worst-case',
                'use_cases': ['strategic planning', 'policy making', 'climate modeling']
            }
        },
        
        'thermal_comfort_index': {
            'name': 'Thermal Comfort Index',
            'collection': 'COMPOSITE',
            'compute': 'compute_thermal_comfort',
            'vis': {'min': 0, 'max': 100, 'palette': ['00ff00', '7fff00', 'ffff00', 'ff8c00', 'ff4500', 'ff0000', '8b0000']},
            'type': 'environmental',
            'priority': 7,
            'keywords': [
                'thermal comfort', 'heat stress', 'human comfort', 'livability', 'temperature comfort',
                'comfort index', 'heat index', 'outdoor comfort', 'habitability', 'climate comfort'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Thermal+Comfort+Index&palette=00ff00,ffff00,ff0000,8b0000&min=0&max=100',
            'description': 'Human thermal comfort from temperature and humidity. Red zones (80+) indicate severe heat stress - unsafe outdoor conditions without cooling.',
            'supports_temporal': False,
            'semantic_context': {
                'focus': 'human health',
                'use_cases': ['public health', 'urban design', 'occupational safety']
            }
        },
        
        'surface_water_extent': {
            'name': 'Surface Water Extent (Latest)',
            'collection': 'JRC/GSW1_4/MonthlyHistory',
            'compute': lambda img: img.select('water').eq(2).selfMask().rename('Water'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffffff', '0066ff']},
            'type': 'environmental',
            'priority': 8,
            'keywords': [
                'surface water', 'water bodies', 'lakes', 'rivers', 'water extent', 'hydrology',
                'reservoirs', 'ponds', 'wetlands', 'aquatic areas', 'water coverage',
                'hydrological features', 'water resources'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Surface+Water&palette=ffffff,0066ff&min=0&max=1',
            'description': 'Current extent of lakes, rivers, and reservoirs. Blue areas show permanent and seasonal water bodies - critical for water resource management.',
            'supports_temporal': True,
            'temporal_range': 'monthly',
            'temporal_start_year': 1984,
            'temporal_end_year': 2024,
            'semantic_context': {
                'resource_type': 'water',
                'use_cases': ['water management', 'irrigation planning', 'conservation']
            }
        },
        
        'evapotranspiration': {
            'name': 'Evapotranspiration (ET)',
            'collection': 'MODIS/061/MOD16A2GF',
            'compute': lambda img: img.select('ET').multiply(0.1).rename('ET'),
            'vis': {'min': 0, 'max': 5, 'palette': ['f7fbff', 'deebf7', 'c6dbef', '9ecae1', '6baed6', '4292c6', '2171b5', '08519c', '08306b']},
            'type': 'environmental',
            'priority': 6,
            'keywords': [
                'evapotranspiration', 'et', 'water loss', 'evaporation', 'transpiration', 'water cycle',
                'moisture loss', 'water demand', 'crop water use', 'plant water loss'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Evapotranspiration+(mm/day)&palette=f7fbff,6baed6,08306b&min=0&max=5',
            'description': 'Water loss from vegetation and soil (mm/day). Higher rates (blue) indicate active vegetation and high water demand - key for irrigation planning.',
            'supports_temporal': True,
            'temporal_range': '8-day',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'process': 'hydrological',
                'use_cases': ['irrigation scheduling', 'water balance', 'crop management']
            }
        },
        
        'glacier_extent': {
            'name': 'Glacier & Ice Cover',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B3', 'B11']).gt(0.4).selfMask().rename('Glacier'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffffff', 'e0f3f8', 'abd9e9', '74add1', '4575b4', '313695']},
            'type': 'environmental',
            'priority': 9,
            'keywords': [
                'glacier', 'ice', 'snow cover', 'glacial', 'ice extent', 'cryosphere',
                'ice cap', 'ice field', 'permanent ice', 'glacial coverage', 'frozen water',
                'ice mass', 'glacier monitoring'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Glacier+Cover&palette=ffffff,abd9e9,313695&min=0&max=1',
            'description': 'Glaciers and permanent ice in northern Pakistan. Critical for monitoring glacial retreat and water security in Gilgit-Baltistan and Hunza regions.',
            'supports_temporal': True,
            'temporal_range': '5-day',
            'temporal_start_year': 2017,
            'temporal_end_year': 2024,
            'semantic_context': {
                'resource_type': 'frozen water',
                'location_focus': 'high altitude',
                'use_cases': ['water security', 'climate monitoring', 'glacier tracking']
            }
        },
        
        'lulc_worldcover': {
            'name': 'Land Use Land Cover (ESA WorldCover)',
            'collection': 'ESA/WorldCover/v200',
            'compute': lambda img: img.select('Map').rename('LULC'),
            'vis': {
                'min': 10,
                'max': 95,
                'palette': [
                    '006400', 'ffbb22', 'ffff4c', 'f096ff', 'fa0000',
                    'b4b4b4', 'f0f0f0', '0064c8', '0096a0', '00cf75', 'fae6a0'
                ]
            },
            'type': 'environmental',
            'priority': 8,
            'keywords': [
                'land use', 'land cover', 'lulc', 'landcover', 'landuse', 'classification', 
                'land classification', 'land types', 'terrain classification', 'surface cover',
                'vegetation cover', 'urban areas', 'agricultural land', 'forest cover'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Land+Use+Cover&palette=006400,ffbb22,f096ff,fa0000,0064c8&min=10&max=95',
            'description': 'ESA WorldCover 10m land use classification. Shows forests (green), croplands (pink), urban areas (red), water (blue), and other land cover types. Essential for urban planning and environmental monitoring.',
            'supports_temporal': True,
            'temporal_range': 'annual',
            'temporal_start_year': 2020,
            'temporal_end_year': 2021,
            'semantic_context': {
                'data_type': 'classification',
                'use_cases': ['urban planning', 'conservation', 'agriculture monitoring']
            }
        },
        
        'lulc_modis': {
            'name': 'Land Cover (MODIS Annual)',
            'collection': 'MODIS/061/MCD12Q1',
            'compute': lambda img: img.select('LC_Type1').rename('LandCover'),
            'vis': {
                'min': 1, 'max': 17,
                'palette': [
                    '05450a', '086a10', '54a708', '78d203', '009900',
                    'c6b044', 'dcd159', 'dade48', 'fbff13', 'b6ff05',
                    'aec3d4', '152106', 'e6ae66', '071c00', '1c0dff',
                    '6f6f6f', 'ffffff'
                ]
            },
            'type': 'land_cover',
            'keywords': [
                'land cover', 'lulc', 'modis', 'vegetation', 'forest', 'agriculture',
                'urban', 'land use', 'classification', 'ecosystem', 'habitat',
                'deforestation', 'afforestation', 'cropland', 'grassland', 'wetland',
                'shrubland', 'savanna', 'barren', 'snow', 'water bodies', 'built-up'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Land+Cover+(MODIS)&palette=05450a,086a10,54a708,78d203,009900,c6b044,dcd159,dade48,fbff13,b6ff05,aec3d4,152106,e6ae66,071c00,1c0dff&min=1&max=17',
            'description': 'Annual global land cover classification from MODIS (2001-2022). 17 classes including forests, croplands, urban areas, and water bodies. Essential for monitoring deforestation, urbanization, and ecosystem changes. 500m resolution.',
            'supports_temporal': True,
            'temporal_range': 'annual',
            'temporal_start_year': 2001,
            'temporal_end_year': 2022,
            'temporal_note': 'Annual product released typically 1 year after acquisition.',
            'semantic_context': {
                'indicator': 'land_use',
                'use_cases': [
                    'deforestation monitoring', 'urbanization tracking', 'agricultural expansion',
                    'ecosystem monitoring', 'habitat loss assessment', 'land use planning',
                    'environmental impact assessment'
                ],
                'temporal_note': 'Annual snapshots for trend analysis'
            }
        },
        
        # ====================================================================
        # EXISTING ENVIRONMENTAL INDICES (PRESERVED)
        # ====================================================================
        'ndvi_modis': {
            'name': 'NDVI (MODIS 16-day)',
            'collection': 'MODIS/061/MOD13Q1',
            'compute': lambda img: img.select('NDVI').multiply(0.0001).rename('NDVI'),
            'vis': {
                'min': -0.2, 'max': 0.8,
                'palette': [
                    'FFFFFF', 'CE7E45', 'DF923D', 'F1B555', 'FCD163',
                    '99B718', '74A901', '66A000', '529400', '3E8601',
                    '207401', '056201', '004C00', '023B01', '012E01', '011D01'
                ]
            },
            'type': 'vegetation',
            'keywords': [
                'ndvi', 'vegetation', 'health', 'greenness', 'modis', 'agriculture',
                'crop health', 'drought', 'vegetation index', 'photosynthesis',
                'biomass', 'crop monitoring', 'vegetation stress', 'agricultural productivity',
                'food security', 'grassland health', 'forest health', 'degradation'
            ],
            'time_filter': True,
            'legend': '/api/gee/legend/?dataset=NDVI+(MODIS)&palette=FFFFFF,CE7E45,DF923D,F1B555,FCD163,99B718,74A901,66A000,529400,3E8601,207401,056201,004C00,023B01,012E01,011D01&min=0&max=1',
            'description': 'Vegetation health index from MODIS (2000-present). 16-day composite at 250m resolution. Values 0-1 where higher values indicate healthier, denser vegetation. Critical for monitoring drought, crop conditions, and ecosystem health.',
            'supports_temporal': True,
            'temporal_range': '16-day',
            'temporal_start_year': 2000,
            'temporal_end_year': datetime.now().year,
            'temporal_note': 'Updated every 16 days, near real-time with ~2 week delay.',
            'semantic_context': {
                'indicator': 'vegetation_health',
                'use_cases': [
                    'drought monitoring', 'crop health assessment', 'agricultural monitoring',
                    'food security', 'vegetation stress detection', 'rangeland monitoring',
                    'forest health', 'post-disaster vegetation recovery'
                ],
                'temporal_note': '16-day composites for seasonal and inter-annual analysis'
            }
        },
        'ndsi': {
            'name': 'Snow Cover (NDSI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B3', 'B11']).rename('NDSI'),
            'vis': {'min': -0.5, 'max': 0.8, 'palette': ['0d47a1', '42a5f5', 'ffffff', 'e3f2fd']},
            'type': 'environmental',
            'priority': 8,
            'keywords': [
                'snow', 'snow cover', 'ice', 'glacier', 'ndsi', 'winter', 'avalanche',
                'snow extent', 'ice coverage', 'frozen precipitation', 'snowpack',
                'snow depth indicator', 'winter conditions'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Snow+Cover+(NDSI)&palette=0d47a1,42a5f5,ffffff,e3f2fd&min=-0.5&max=0.8',
            'description': 'Snow and ice coverage. White zones indicate fresh snow; light blue shows older snow/ice - essential for avalanche risk and water forecasting.',
            'supports_temporal': True,
            'temporal_range': '5-day',
            'temporal_start_year': 2017,
            'temporal_end_year': 2024,
            'semantic_context': {
                'index_type': 'spectral',
                'season_focus': 'winter',
                'use_cases': ['avalanche prediction', 'water resource forecasting', 'winter monitoring']
            }
        },
        'ndbi': {
            'name': 'Urban Areas (NDBI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B11', 'B8']).rename('NDBI'),
            'vis': {'min': -0.5, 'max': 0.5, 'palette': ['2e7d32', 'ffeb3b', 'ff6f00', 'd32f2f']},
            'type': 'environmental',
            'priority': 6,
            'keywords': [
                'urban', 'urban areas', 'built', 'city', 'development', 'ndbi', 'building', 
                'infrastructure', 'built-up areas', 'construction', 'urbanization', 'metropolitan',
                'developed land', 'urban expansion', 'settlement'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Urban+Areas+(NDBI)&palette=2e7d32,ffeb3b,ff6f00,d32f2f&min=-0.5&max=0.5',
            'description': 'Built-up areas and infrastructure. Red zones show dense urban development - useful for tracking city expansion and heat island effects.',
            'supports_temporal': True,
            'temporal_range': '5-day',
            'temporal_start_year': 2017,
            'temporal_end_year': 2024,
            'semantic_context': {
                'index_type': 'spectral',
                'use_cases': ['urban planning', 'growth monitoring', 'heat island analysis']
            }
        },
        'ndwi': {
            'name': 'Water Bodies (NDWI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B3', 'B8']).rename('NDWI'),
            'vis': {'min': -0.5, 'max': 0.5, 'palette': ['d7ccc8', '81d4fa', '039be5', '01579b']},
            'type': 'environmental',
            'priority': 5,
            'keywords': [
                'ndwi', 'water index', 'water bodies index', 'water content', 'moisture index',
                'water detection', 'aquatic features', 'water mapping', 'moisture content'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Water+Bodies+(NDWI)&palette=d7ccc8,81d4fa,039be5,01579b&min=-0.5&max=0.5',
            'description': 'Water content in vegetation and surface water. Dark blues indicate open water; light blues show moist soils or wetlands.',
            'supports_temporal': True,
            'temporal_range': '5-day',
            'temporal_start_year': 2017,
            'temporal_end_year': 2024,
            'semantic_context': {
                'index_type': 'spectral',
                'use_cases': ['water mapping', 'wetland monitoring', 'irrigation assessment']
            }
        },
        'nightlights_dmsp': {
            'name': 'Nighttime Lights (DMSP 1992-2013)',
            'collection': 'NOAA/DMSP-OLS/NIGHTTIME_LIGHTS',
            'compute': lambda img: img.select('stable_lights').rename('Nightlights'),
            'vis': {'min': 0, 'max': 63, 'palette': ['000000', '0d0887', '7e03a8', 'cc4778', 'f89540', 'f0f921']},
            'type': 'socioeconomic',
            'keywords': [
                'nightlights', 'lights', 'economic', 'activity', 'development', 'urbanization',
                'night illumination', 'artificial light', 'electrification', 'economic development',
                'infrastructure development', 'settlement patterns', 'dmsp', 'historical lights',
                'urban expansion', 'energy consumption', 'population density proxy'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Nighttime+Lights+(DMSP)&palette=000000,0d0887,7e03a8,cc4778,f89540,f0f921&min=0&max=63',
            'description': 'Historical nighttime lights (1992-2013) from DMSP satellites showing economic activity and electrification. Bright areas indicate developed urban centers; dark zones lack infrastructure. NOTE: DMSP program ended in 2013 - use VIIRS for recent data.',
            'supports_temporal': True,
            'temporal_range': 'annual',
            'temporal_start_year': 1992,
            'temporal_end_year': 2013,
            'temporal_note': 'DMSP satellite program ended in 2013. Use nightlights_viirs for 2014-present.',
            'semantic_context': {
                'indicator': 'socioeconomic',
                'use_cases': ['development monitoring', 'electrification tracking', 'economic activity', 'historical urbanization', 'power grid expansion'],
                'temporal_note': 'Historical dataset only - ended 2013'
            }
        },
    
        'nightlights_viirs': {
            'name': 'Nighttime Lights (VIIRS 2014-Present)',
            'collection': 'NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG',
            'compute': lambda img: img.select('avg_rad').rename('Nightlights'),
            'vis': {'min': 0, 'max': 60, 'palette': ['000000', '0d0887', '7e03a8', 'cc4778', 'f89540', 'f0f921']},
            'type': 'socioeconomic',
            'keywords': [
                'nightlights', 'lights', 'economic', 'activity', 'development', 'urbanization',
                'night illumination', 'artificial light', 'electrification', 'economic development',
                'infrastructure development', 'settlement patterns', 'viirs', 'modern lights',
                'urban expansion', 'energy consumption', 'real-time development', 'monthly lights'
            ],
            'time_filter': True,
            'legend': '/api/gee/legend/?dataset=Nighttime+Lights+(VIIRS)&palette=000000,0d0887,7e03a8,cc4778,f89540,f0f921&min=0&max=60',
            'description': 'Modern nighttime lights (2014-present) from VIIRS satellite showing current economic activity and electrification. Higher resolution than DMSP. Updated monthly with cloud-free composites. Essential for monitoring urban growth and disaster recovery.',
            'supports_temporal': True,
            'temporal_range': 'monthly',
            'temporal_start_year': 2014,
            'temporal_end_year': 2024,
            'temporal_note': 'Updated monthly, typically 2-3 months delay. Successor to DMSP.',
            'semantic_context': {
                'indicator': 'socioeconomic',
                'use_cases': ['development monitoring', 'electrification tracking', 'economic activity', 'disaster recovery monitoring', 'power outage detection', 'urban expansion tracking'],
                'temporal_note': 'Current operational dataset'
            }
        },
        'air_quality': {
            'name': 'Air Quality (AOD)',
            'collection': 'MODIS/061/MCD19A2_GRANULES',
            'compute': lambda img: img.select('Optical_Depth_047').multiply(0.001).rename('AOD'),
            'vis': {'min': 0, 'max': 1, 'palette': ['00ff00', 'ffff00', 'ff7e00', 'ff0000', '8f3f97', '7e0023']},
            'type': 'environmental',
            'keywords': [
                'air quality', 'pollution', 'smog', 'aerosol', 'aod', 'environment',
                'air pollution', 'particulate matter', 'atmospheric pollution', 'haze',
                'air contamination', 'pollution monitoring', 'aerosol optical depth'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Air+Quality+(AOD)&palette=00ff00,ffff00,ff7e00,ff0000,8f3f97,7e0023&min=0&max=1',
            'description': 'Air pollution from aerosols and particulates. Red/purple zones show hazardous air quality - common in winter smog season in Punjab.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'health_impact': 'respiratory',
                'use_cases': ['health monitoring', 'pollution control', 'environmental policy']
            }
        },
        'temperature': {
            'name': 'Land Surface Temperature',
            'collection': 'MODIS/061/MOD11A1',
            'compute': lambda img: img.select('LST_Day_1km').multiply(0.02).subtract(273.15).rename('Temperature'),
            'vis': {'min': 0, 'max': 50, 'palette': ['313695', '4575b4', 'abd9e9', 'ffffbf', 'fdae61', 'f46d43', 'd73027', 'a50026']},
            'type': 'environmental',
            'priority': 3,
            'keywords': [
                'temperature', 'heat', 'thermal', 'lst', 'surface temperature', 'ground heat',
                'thermal radiation', 'heat distribution', 'temperature map'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Temperature+(Celsius)&palette=313695,ffffbf,a50026&min=0&max=50',
            'description': 'Land surface temperature from MODIS. Shows ground-level heat - red zones (40°C+) face extreme heat stress risks.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2000,
            'temporal_end_year': 2024,
            'semantic_context': {
                'measurement': 'celsius',
                'use_cases': ['heat monitoring', 'climate analysis', 'thermal mapping']
            }
        },
        'precipitation': {
            'name': 'Rainfall Data',
            'collection': 'UCSB-CHG/CHIRPS/DAILY',
            'compute': lambda img: img.select('precipitation').rename('Precipitation'),
            'vis': {'min': 0, 'max': 50, 'palette': ['ffffff', 'c6dbef', '9ecae1', '6baed6', '3182bd', '08519c']},
            'type': 'environmental',
            'priority': 3,
            'keywords': [
                'rainfall', 'precipitation', 'rain', 'rainfall data', 'rain measurement',
                'precipitation rate', 'wet conditions', 'monsoon', 'rainfall intensity',
                'rain accumulation', 'precipitation patterns'
            ],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Rainfall+(mm)&palette=ffffff,6baed6,08519c&min=0&max=50',
            'description': 'Daily rainfall from CHIRPS satellite. Darker blues show heavy rain (30mm+) - useful for flood forecasting and agricultural planning.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 1981,
            'temporal_end_year': 2024,
            'semantic_context': {
                'measurement': 'millimeters',
                'use_cases': ['flood forecasting', 'agriculture', 'water management']
            }
        },
        'soil_moisture': {
            'name': 'Soil Moisture (SMAP)',
            'collection': 'NASA_USDA/HSL/SMAP10KM_soil_moisture',
            'compute': lambda img: img.select('ssm').rename('SoilMoisture'),
            'vis': {
                'min': 0, 'max': 28,
                'palette': ['d7191c', 'fdae61', 'ffffbf', 'a6d96a', '1a9641']
            },
            'type': 'water',
            'keywords': [
                'soil moisture', 'soil', 'water content', 'drought', 'agriculture',
                'soil water', 'surface moisture', 'agricultural drought', 'crop water stress',
                'irrigation', 'water availability', 'hydrological drought', 'soil saturation',
                'field capacity', 'water stress', 'agricultural monitoring'
            ],
            'time_filter': True,
            'legend': '/api/gee/legend/?dataset=Soil+Moisture+(SMAP)&palette=d7191c,fdae61,ffffbf,a6d96a,1a9641&min=0&max=28',
            'description': 'Surface soil moisture from SMAP satellite (2015-present). Daily product at 10km resolution showing top 5cm soil water content. Critical for drought monitoring, agricultural planning, and flood forecasting. Values in percent volumetric water content.',
            'supports_temporal': True,
            'temporal_range': 'daily',
            'temporal_start_year': 2015,
            'temporal_end_year': 2024,
            'temporal_note': 'SMAP launched April 2015. Daily products with ~2 day latency.',
            'semantic_context': {
                'indicator': 'drought',
                'use_cases': [
                    'drought monitoring', 'agricultural drought assessment', 'crop water stress',
                    'irrigation planning', 'flood forecasting', 'water resource management',
                    'agricultural advisory', 'food security monitoring'
                ],
                'temporal_note': 'Daily updates for operational drought monitoring'
            }
        },
        'population': {
            'name': 'Population Density (WorldPop)',
            'collection': 'WorldPop/GP/100m/pop',
            'compute': lambda img: img.rename('Population'),
            'vis': {
                'min': 0, 'max': 100,
                'palette': [
                    'ffffcc', 'ffeda0', 'fed976', 'feb24c', 'fd8d3c',
                    'fc4e2a', 'e31a1c', 'bd0026', '800026'
                ]
            },
            'type': 'socioeconomic',
            'keywords': [
                'population', 'density', 'demographics', 'people', 'settlement',
                'population distribution', 'human settlement', 'population count',
                'urban population', 'rural population', 'population growth',
                'population exposure', 'disaster exposure', 'risk assessment',
                'humanitarian planning', 'vulnerable populations'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Population+Density&palette=ffffcc,ffeda0,fed976,feb24c,fd8d3c,fc4e2a,e31a1c,bd0026,800026&min=0&max=100',
            'description': 'Annual population density estimates from WorldPop (2000-2020) at 100m resolution. Shows people per hectare. Essential for disaster risk assessment, exposure analysis, and humanitarian planning. Typically 2-3 years behind current year.',
            'supports_temporal': True,
            'temporal_range': 'annual',
            'temporal_start_year': 2000,
            'temporal_end_year': 2020,
            'temporal_note': 'WorldPop releases typically lag 2-3 years behind current year.',
            'semantic_context': {
                'indicator': 'demographic',
                'use_cases': [
                    'disaster exposure assessment', 'risk analysis', 'humanitarian planning',
                    'evacuation planning', 'resource allocation', 'impact assessment',
                    'vulnerable population identification', 'population growth monitoring'
                ],
                'temporal_note': 'Annual estimates with 2-3 year lag'
            }
        },
        'elevation': {
            'name': 'Elevation (DEM)',
            'collection': 'USGS/SRTMGL1_003',
            'compute': lambda img: img.select('elevation').rename('Elevation'),
            'vis': {'min': 0, 'max': 5000, 'palette': ['006400', '228b22', 'adff2f', 'ffff00', 'ff8c00', 'ff4500', '8b4513', 'ffffff']},
            'type': 'terrain',
            'priority': 2,
            'keywords': [
                'elevation', 'altitude', 'dem', 'height', 'terrain height', 'topography',
                'digital elevation model', 'ground elevation', 'elevation data', 'height above sea level',
                'terrain elevation', 'topographic height'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Elevation+(m)&palette=006400,ffff00,ffffff&min=0&max=5000',
            'description': 'Terrain elevation from sea level. White peaks show Karakoram mountains (5000m+); greens are lowland plains vulnerable to flooding.',
            'supports_temporal': False,
            'semantic_context': {
                'measurement': 'meters',
                'use_cases': ['topographic analysis', 'hazard mapping', 'infrastructure planning']
            }
        },
        'multi_hazard_exposure': {
            'name': 'Multi-Hazard Exposure',
            'collection': 'WorldPop/GP/100m/pop',
            'compute': lambda img: img.select('population').gt(50).selfMask().rename('Exposure'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffeda0', 'feb24c', 'fd8d3c', 'fc4e2a', 'e31a1c', 'b10026']},
            'type': 'susceptibility',
            'keywords': [
                'multi hazard', 'exposure', 'vulnerability', 'risk', 'population risk', 
                'composite risk', 'combined hazards', 'multiple threats', 'compound risk',
                'integrated risk', 'cumulative hazard', 'risk overlap'
            ],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Multi-Hazard+Exposure&palette=ffeda0,fd8d3c,e31a1c,b10026&min=0&max=1',
            'description': 'Population exposure to multiple hazards. Red areas face compound risks from floods, landslides, and earthquakes - priority zones for resilience planning.',
            'supports_temporal': False,
            'semantic_context': {
                'analysis_type': 'composite',
                'use_cases': ['resilience planning', 'disaster preparedness', 'risk reduction']
            }
        },
    }
    
    @classmethod
    def get_dataset(cls, query):
        """Enhanced semantic search with priority scoring"""
        query_lower = query.lower()
        
        scores = {}
        for key, dataset in cls.DATASETS.items():
            # Calculate semantic score
            semantic_score = SemanticSearchHelper.calculate_semantic_score(query, dataset)
            priority = dataset.get('priority', 1)
            
            # Combine semantic score with priority
            final_score = semantic_score * priority
            
            if final_score > 0:
                scores[key] = final_score
        
        if not scores:
            return None, None
        
        best_match = max(scores, key=scores.get)
        return best_match, cls.DATASETS[best_match]
    
    @classmethod
    def get_location(cls, query):
        """Extract location from query"""
        query_lower = query.lower().replace(' ', '_').replace('-', '_')
        
        for loc_name, bbox in cls.LOCATIONS.items():
            if loc_name in query_lower:
                return loc_name, bbox
        
        return 'pakistan', cls.PAKISTAN_BOUNDS
    
    @classmethod
    def extract_dates(cls, message):
        """Extract date range - always prefer latest data"""
        today = datetime.now()
        
        if any(word in message.lower() for word in ['active', 'current', 'latest', 'recent', 'now']):
            start = (today - timedelta(days=7)).strftime('%Y-%m-%d')
            return [start, today.strftime('%Y-%m-%d')]
        
        default_start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
        default_end = today.strftime('%Y-%m-%d')
        
        message_lower = message.lower()
        
        if 'yesterday' in message_lower:
            yesterday = (today - timedelta(days=1)).strftime('%Y-%m-%d')
            return [yesterday, yesterday]
        
        if 'last week' in message_lower:
            start = (today - timedelta(days=7)).strftime('%Y-%m-%d')
            return [start, default_end]
        
        if 'last month' in message_lower:
            start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
            return [start, default_end]
        
        return [default_start, default_end]
# ============================================================================
# 🔥 NEW ENHANCED COMPUTATION FUNCTIONS
# ============================================================================
# ============================================================================
# 🔥 ENHANCED COMPUTATION FUNCTIONS (PRESERVED)
# ============================================================================

class EnhancedCompute:
    """New environmental computation methods"""
    
    @staticmethod
    def compute_uhii(aoi, date_range):
        """Urban Heat Island Index - difference between urban and rural temps"""
        try:
            lst = ee.ImageCollection('MODIS/061/MOD11A1') \
                .filterBounds(aoi) \
                .filterDate(date_range[0], date_range[1]) \
                .mean() \
                .select('LST_Day_1km') \
                .multiply(0.02) \
                .subtract(273.15) \
                .clip(aoi)
            
            urban = ee.ImageCollection('COPERNICUS/S2_SR') \
                .filterBounds(aoi) \
                .filterDate(date_range[0], date_range[1]) \
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20)) \
                .median() \
                .normalizedDifference(['B11', 'B8']) \
                .gt(0.1) \
                .clip(aoi)
            
            rural_temp = lst.updateMask(urban.Not()).reduceRegion(
                reducer=ee.Reducer.percentile([30]),
                geometry=aoi,
                scale=1000,
                maxPixels=1e9
            ).getNumber('LST_Day_1km')
            
            uhii = lst.subtract(ee.Image.constant(rural_temp)).rename('UHII')
            
            return uhii.updateMask(urban)
            
        except Exception as e:
            print(f"❌ UHII Error: {e}")
            return ee.Image.constant(0).clip(aoi).rename('UHII_Fallback')
    
    @staticmethod
    def compute_slr_2050(aoi):
        """Sea Level Rise 2050 - 1-3m inundation scenario"""
        try:
            dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM').mosaic().clip(aoi)
            slr_risk = dem.lt(3).multiply(3).subtract(dem).clamp(0, 3).rename('SLR_2050')
            coastal_mask = dem.lt(10).And(dem.gt(-5))
            return slr_risk.updateMask(coastal_mask)
        except Exception as e:
            print(f"❌ SLR 2050 Error: {e}")
            return ee.Image.constant(0).clip(aoi).rename('SLR_Fallback')
    
    @staticmethod
    def compute_slr_2100(aoi):
        """Sea Level Rise 2100 - 1-5m worst case scenario"""
        try:
            dem = ee.ImageCollection('COPERNICUS/DEM/GLO30').select('DEM').mosaic().clip(aoi)
            slr_risk = dem.lt(5).multiply(5).subtract(dem).clamp(0, 5).rename('SLR_2100')
            coastal_mask = dem.lt(15).And(dem.gt(-5))
            return slr_risk.updateMask(coastal_mask)
        except Exception as e:
            print(f"❌ SLR 2100 Error: {e}")
            return ee.Image.constant(0).clip(aoi).rename('SLR_Fallback')
    
    @staticmethod
    def compute_thermal_comfort(aoi, date_range):
        """Thermal Comfort Index from temp + humidity proxy"""
        try:
            temp = ee.ImageCollection('MODIS/061/MOD11A1') \
                .filterBounds(aoi) \
                .filterDate(date_range[0], date_range[1]) \
                .mean() \
                .select('LST_Day_1km') \
                .multiply(0.02) \
                .subtract(273.15) \
                .clip(aoi)
            
            comfort = temp.multiply(2).clamp(0, 100).rename('Thermal_Comfort')
            return comfort
        except Exception as e:
            print(f"❌ Thermal Comfort Error: {e}")
            return ee.Image.constant(50).clip(aoi).rename('Comfort_Fallback')

# ============================================================================
# AHP COMPUTATION FUNCTIONS - PRESERVED FROM ORIGINAL
# ============================================================================

class AHPModels:
    """Analytical Hierarchy Process for multi-criteria susceptibility - PRESERVED"""
    
    @staticmethod
    def compute_flood_susceptibility(aoi):
        """Multi-criteria flood susceptibility using AHP"""
        try:
            dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
            dem = dem_collection.select('DEM').mosaic().clip(aoi)
            
            elevation_risk = dem.lt(100).multiply(1.0) \
                .where(dem.gte(100).And(dem.lt(500)), 0.5) \
                .where(dem.gte(500), 0.1) \
                .unmask(0.1)
            
            slope = ee.Terrain.slope(dem)
            slope_risk = slope.lt(5).multiply(1.0) \
                .where(slope.gte(5).And(slope.lt(15)), 0.5) \
                .where(slope.gte(15), 0.1) \
                .unmask(0.1)
            
            today = datetime.now()
            start_date = (today - timedelta(days=90)).strftime('%Y-%m-%d')
            end_date = today.strftime('%Y-%m-%d')
            
            try:
                rainfall = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
                    .filterBounds(aoi) \
                    .filterDate(start_date, end_date) \
                    .sum() \
                    .select('precipitation') \
                    .clip(aoi)
                
                rainfall_risk = rainfall.gt(200).multiply(1.0) \
                    .where(rainfall.gte(100).And(rainfall.lte(200)), 0.7) \
                    .where(rainfall.gte(50).And(rainfall.lt(100)), 0.4) \
                    .where(rainfall.lt(50), 0.2) \
                    .unmask(0.3)
            except:
                rainfall_risk = ee.Image.constant(0.5).clip(aoi)
            
            try:
                water_occurrence = ee.Image('JRC/GSW1_4/GlobalSurfaceWater') \
                    .select('occurrence') \
                    .clip(aoi)
                
                water_risk = water_occurrence.gt(50).multiply(1.0) \
                    .where(water_occurrence.gte(20).And(water_occurrence.lte(50)), 0.6) \
                    .where(water_occurrence.gte(5).And(water_occurrence.lt(20)), 0.3) \
                    .where(water_occurrence.lt(5), 0.1) \
                    .unmask(0.1)
            except:
                water_risk = ee.Image.constant(0.3).clip(aoi)
            
            soil_start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
            
            try:
                soil_collection = ee.ImageCollection('NASA_USDA/HSL/SMAP10KM_soil_moisture') \
                    .filterBounds(aoi) \
                    .filterDate(soil_start, end_date)
                
                soil_count = soil_collection.size().getInfo()
                
                if soil_count > 0:
                    soil = soil_collection.mean().select('ssm').clip(aoi)
                    soil_risk = soil.gt(20).multiply(1.0) \
                        .where(soil.gte(10).And(soil.lte(20)), 0.6) \
                        .where(soil.lt(10), 0.2) \
                        .unmask(0.3)
                else:
                    soil_risk = ee.Image.constant(0.4).clip(aoi)
            except:
                soil_risk = ee.Image.constant(0.4).clip(aoi)
            
            susceptibility = elevation_risk.multiply(0.30) \
                .add(slope_risk.multiply(0.25)) \
                .add(rainfall_risk.multiply(0.20)) \
                .add(water_risk.multiply(0.15)) \
                .add(soil_risk.multiply(0.10)) \
                .clamp(0, 1)
            
            susceptibility = susceptibility.updateMask(susceptibility.gt(0.05))
            
            return susceptibility.rename('Flood_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Flood Error: {e}")
            dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
            dem = dem_collection.select('DEM').mosaic().clip(aoi)
            simple = dem.lt(200).multiply(1.0) \
                .where(dem.gte(200).And(dem.lt(500)), 0.5) \
                .where(dem.gte(500), 0.1) \
                .updateMask(dem.lt(500))
            return simple.rename('Flood_Susceptibility_Simple')
    
    @staticmethod
    def compute_fire_susceptibility(aoi, date_range):
        """Multi-criteria fire susceptibility using AHP"""
        try:
            try:
                s2_collection = ee.ImageCollection('COPERNICUS/S2_SR') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1]) \
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                
                s2_count = s2_collection.size().getInfo()
                
                if s2_count > 0:
                    ndvi = s2_collection.median().normalizedDifference(['B8', 'B4']).clip(aoi)
                else:
                    ndvi = ee.ImageCollection('MODIS/061/MOD13A1') \
                        .filterBounds(aoi) \
                        .filterDate(date_range[0], date_range[1]) \
                        .mean() \
                        .select('NDVI') \
                        .multiply(0.0001) \
                        .clip(aoi)
                
                veg_risk = ndvi.lt(0.3).multiply(1.0) \
                    .where(ndvi.gte(0.3).And(ndvi.lt(0.5)), 0.6) \
                    .where(ndvi.gte(0.5), 0.1) \
                    .unmask(0.3)
            except:
                veg_risk = ee.Image.constant(0.5).clip(aoi)
            
            try:
                temp = ee.ImageCollection('MODIS/061/MOD11A1') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1]) \
                    .mean() \
                    .select('LST_Day_1km') \
                    .multiply(0.02) \
                    .subtract(273.15) \
                    .clip(aoi)
                
                temp_risk = temp.gt(40).multiply(1.0) \
                    .where(temp.gte(30).And(temp.lte(40)), 0.7) \
                    .where(temp.gte(20).And(temp.lt(30)), 0.3) \
                    .where(temp.lt(20), 0.1) \
                    .unmask(0.3)
            except:
                temp_risk = ee.Image.constant(0.5).clip(aoi)
            
            dem_srtm = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem_srtm).clip(aoi)
            slope_risk = slope.gte(10).And(slope.lte(30)).multiply(1.0) \
                .where(slope.lt(10), 0.3) \
                .where(slope.gt(30), 0.5) \
                .unmask(0.3)
            
            susceptibility = veg_risk.multiply(0.35) \
                .add(temp_risk.multiply(0.25)) \
                .add(slope_risk.multiply(0.20)) \
                .clamp(0, 1) \
                .updateMask(veg_risk.gt(0.05))
            
            return susceptibility.rename('Fire_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Fire Error: {e}")
            return ee.Image.constant(0.5).clip(aoi).rename('Fire_Risk_Fallback')
    
    @staticmethod
    def compute_landslide_susceptibility(aoi):
        """Multi-criteria landslide susceptibility - PRESERVED"""
        try:
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            
            slope = ee.Terrain.slope(dem).clip(aoi)
            slope_risk = slope.gt(25).multiply(1.0) \
                .where(slope.gte(15).And(slope.lte(25)), 0.7) \
                .where(slope.gte(10).And(slope.lt(15)), 0.4) \
                .where(slope.lt(10), 0.1) \
                .unmask(0.1)
            
            elev_risk = dem.clip(aoi).gt(1500).multiply(1.0) \
                .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(1500)), 0.7) \
                .where(dem.clip(aoi).gte(500).And(dem.clip(aoi).lt(1000)), 0.4) \
                .where(dem.clip(aoi).lt(500), 0.2) \
                .unmask(0.2)
            
            aspect = ee.Terrain.aspect(dem).clip(aoi)
            aspect_risk = aspect.gte(315).Or(aspect.lte(45)).multiply(1.0) \
                .where(aspect.gt(45).And(aspect.lt(315)), 0.3) \
                .unmask(0.5)
            
            today = datetime.now()
            soil_start = (today - timedelta(days=30)).strftime('%Y-%m-%d')
            soil_end = today.strftime('%Y-%m-%d')
            
            try:
                soil_collection = ee.ImageCollection('NASA_USDA/HSL/SMAP10KM_soil_moisture') \
                    .filterBounds(aoi) \
                    .filterDate(soil_start, soil_end)
                
                soil_count = soil_collection.size().getInfo()
                
                if soil_count > 0:
                    soil = soil_collection.mean().select('ssm').clip(aoi)
                    soil_risk = soil.gt(20).multiply(1.0) \
                        .where(soil.gte(10).And(soil.lte(20)), 0.6) \
                        .where(soil.lt(10), 0.2) \
                        .unmask(0.4)
                else:
                    soil_risk = dem.clip(aoi).gt(2000).multiply(0.8) \
                        .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(2000)), 0.6) \
                        .where(dem.clip(aoi).lt(1000), 0.3) \
                        .unmask(0.4)
            except:
                soil_risk = slope.gt(20).multiply(0.7) \
                    .where(slope.gte(10).And(slope.lte(20)), 0.5) \
                    .where(slope.lt(10), 0.3) \
                    .unmask(0.4)
            
            rain_start = (today - timedelta(days=90)).strftime('%Y-%m-%d')
            
            try:
                rainfall_collection = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
                    .filterBounds(aoi) \
                    .filterDate(rain_start, soil_end)
                
                rain_count = rainfall_collection.size().getInfo()
                
                if rain_count > 0:
                    rainfall = rainfall_collection.sum().select('precipitation').clip(aoi)
                    rain_risk = rainfall.gt(300).multiply(1.0) \
                        .where(rainfall.gte(150).And(rainfall.lte(300)), 0.7) \
                        .where(rainfall.gte(50).And(rainfall.lt(150)), 0.4) \
                        .where(rainfall.lt(50), 0.2) \
                        .unmask(0.5)
                else:
                    rain_risk = dem.clip(aoi).gt(2000).multiply(0.8) \
                        .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(2000)), 0.6) \
                        .where(dem.clip(aoi).lt(1000), 0.3) \
                        .unmask(0.5)
            except Exception as rain_error:
                rain_risk = slope.gt(20).multiply(0.7) \
                    .where(slope.gte(10).And(slope.lte(20)), 0.5) \
                    .where(slope.lt(10), 0.3) \
                    .unmask(0.5)
            
            susceptibility = slope_risk.multiply(0.35) \
                .add(elev_risk.multiply(0.15)) \
                .add(aspect_risk.multiply(0.15)) \
                .add(soil_risk.multiply(0.20)) \
                .add(rain_risk.multiply(0.15)) \
                .clamp(0, 1)
            
            susceptibility = susceptibility.updateMask(susceptibility.gt(0.1))
            
            return susceptibility.rename('Landslide_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Landslide Error: {e}")
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem).clip(aoi)
            simple = slope.gt(15).multiply(1.0) \
                .where(slope.gte(10).And(slope.lte(15)), 0.6) \
                .where(slope.lt(10), 0.1) \
                .updateMask(slope.gt(5))
            return simple.rename('Landslide_Simple')
    
    @staticmethod
    def compute_cyclone_susceptibility(aoi):
        """Coastal cyclone susceptibility - PRESERVED"""
        try:
            dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
            dem = dem_collection.select('DEM').mosaic().clip(aoi)
            
            coastal_risk = dem.lt(10).And(dem.gt(-5)).multiply(1.0) \
                .where(dem.gte(10).And(dem.lt(50)), 0.6) \
                .where(dem.gte(50).And(dem.lt(100)), 0.3) \
                .where(dem.gte(100), 0.1) \
                .unmask(0.1)
            
            slope = ee.Terrain.slope(dem)
            slope_risk = slope.lt(5).multiply(1.0) \
                .where(slope.gte(5).And(slope.lt(15)), 0.5) \
                .where(slope.gte(15), 0.1) \
                .unmask(0.3)
            
            try:
                pop_collection = ee.ImageCollection('WorldPop/GP/100m/pop')
                pop = pop_collection.mosaic().select('population').clip(aoi)
                
                pop_risk = pop.gt(100).multiply(1.0) \
                    .where(pop.gte(50).And(pop.lte(100)), 0.7) \
                    .where(pop.gte(10).And(pop.lt(50)), 0.4) \
                    .where(pop.lt(10), 0.1) \
                    .unmask(0.1)
            except:
                pop_risk = ee.Image.constant(0.3).clip(aoi)
            
            distance_risk = dem.lt(5).multiply(1.0) \
                .where(dem.gte(5).And(dem.lt(20)), 0.7) \
                .where(dem.gte(20), 0.3) \
                .unmask(0.3)
            
            susceptibility = coastal_risk.multiply(0.40) \
                .add(slope_risk.multiply(0.20)) \
                .add(pop_risk.multiply(0.20)) \
                .add(distance_risk.multiply(0.20)) \
                .clamp(0, 1) \
                .updateMask(dem.lt(200))
            
            return susceptibility.rename('Cyclone_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Cyclone Error: {e}")
            try:
                dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
                dem = dem_collection.select('DEM').mosaic().clip(aoi)
            except:
                dem = ee.Image('USGS/SRTMGL1_003').select('elevation').clip(aoi)
            
            simple = dem.lt(20).And(dem.gt(-5)).multiply(1.0) \
                .where(dem.gte(20).And(dem.lt(50)), 0.5) \
                .updateMask(dem.lt(100))
            return simple.rename('Cyclone_Simple')
    
    @staticmethod
    def compute_seismic_susceptibility(aoi):
        """Terrain-based seismic susceptibility - PRESERVED"""
        try:
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem).clip(aoi)
            
            elev_risk = dem.clip(aoi).gt(1500).multiply(1.0) \
                .where(dem.clip(aoi).gte(500).And(dem.clip(aoi).lte(1500)), 0.6) \
                .where(dem.clip(aoi).lt(500), 0.2) \
                .unmask(0.2)
            
            slope_risk = slope.gt(20).multiply(1.0) \
                .where(slope.gte(10).And(slope.lte(20)), 0.6) \
                .where(slope.lt(10), 0.2) \
                .unmask(0.2)
            
            roughness = slope.gt(15).multiply(1.0) \
                .where(slope.gte(5).And(slope.lte(15)), 0.5) \
                .where(slope.lt(5), 0.1) \
                .unmask(0.1)
            
            susceptibility = elev_risk.multiply(0.40) \
                .add(slope_risk.multiply(0.30)) \
                .add(roughness.multiply(0.30)) \
                .clamp(0, 1) \
                .updateMask(elev_risk.gt(0.1))
            
            return susceptibility.rename('Seismic_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Seismic Error: {e}")
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem).clip(aoi)
            simple = dem.clip(aoi).gt(500).And(slope.gt(15)).multiply(1.0) \
                .where(dem.clip(aoi).gt(500).Or(slope.gt(15)), 0.5) \
                .updateMask(dem.clip(aoi).gt(200))
            return simple.rename('Seismic_Simple')
    
    @staticmethod
    def compute_drought_composite(aoi, date_range):
        """Composite drought severity index - PRESERVED"""
        try:
            try:
                s2_collection = ee.ImageCollection('COPERNICUS/S2_SR') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1]) \
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                
                s2_count = s2_collection.size().getInfo()
                
                if s2_count > 0:
                    ndvi = s2_collection.median().normalizedDifference(['B8', 'B4']).clip(aoi)
                else:
                    ndvi = ee.ImageCollection('MODIS/061/MOD13A1') \
                        .filterBounds(aoi) \
                        .filterDate(date_range[0], date_range[1]) \
                        .mean() \
                        .select('NDVI') \
                        .multiply(0.0001) \
                        .clip(aoi)
                
                veg_stress = ndvi.lt(0.3).multiply(1.0) \
                    .where(ndvi.gte(0.3).And(ndvi.lt(0.5)), 0.6) \
                    .where(ndvi.gte(0.5), 0.1) \
                    .unmask(0.3)
            except:
                veg_stress = ee.Image.constant(0.5).clip(aoi)
            
            try:
                soil_collection = ee.ImageCollection('NASA_USDA/HSL/SMAP10KM_soil_moisture') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1])
                
                soil_count = soil_collection.size().getInfo()
                
                if soil_count > 0:
                    soil = soil_collection.mean().select('ssm').clip(aoi)
                    soil_stress = soil.lt(10).multiply(1.0) \
                        .where(soil.gte(10).And(soil.lt(15)), 0.6) \
                        .where(soil.gte(15), 0.1) \
                        .unmask(0.3)
                else:
                    soil_stress = veg_stress.multiply(0.7)
            except:
                soil_stress = veg_stress.multiply(0.7)
            
            try:
                rainfall = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1]) \
                    .sum() \
                    .select('precipitation') \
                    .clip(aoi)
                
                rain_stress = rainfall.lt(50).multiply(1.0) \
                    .where(rainfall.gte(50).And(rainfall.lt(100)), 0.6) \
                    .where(rainfall.gte(100), 0.1) \
                    .unmask(0.3)
            except:
                rain_stress = veg_stress.multiply(0.7)
            
            drought_severity = veg_stress.multiply(0.40) \
                .add(soil_stress.multiply(0.30)) \
                .add(rain_stress.multiply(0.30)) \
                .clamp(0, 1) \
                .updateMask(veg_stress.gt(0.05))
            
            return drought_severity.rename('Drought_Severity')
            
        except Exception as e:
            print(f"❌ Drought Composite Error: {e}")
            return ee.Image.constant(0.5).clip(aoi).rename('Drought_Fallback')


# ============================================================================
# DYNAMIC GEE LAYER VIEW - ENHANCED WITH DESCRIPTIONS
# ============================================================================
# ============================================================================
# DYNAMIC GEE LAYER VIEW - ENHANCED
# ============================================================================

@method_decorator(csrf_exempt, name='dispatch')
class DynamicGEELayerView(View):
    """Enhanced hazard-specific layer generator with semantic search"""
    
    def post(self, request):
        try:
            data = json.loads(request.body)
            message = data.get('message', '')
            
            if not message:
                return JsonResponse({
                    'error': 'No message provided',
                    'suggestion': 'Try: "Show flood susceptibility in Sindh"'
                }, status=400)
            
            dataset_key, dataset_config = GEEDataCatalog.get_dataset(message)
            
            if not dataset_key:
                return JsonResponse({
                    'error': 'Dataset not recognized',
                    'response': f"❌ Couldn't find hazard data for '{message}'.\n\nTry: flood extent, fire susceptibility, urban heat island, sea level rise, etc."
                }, status=400)
            
            location_name, bbox = GEEDataCatalog.get_location(message)
            date_range = GEEDataCatalog.extract_dates(message)
            
            layer_data = self.generate_layer(
                dataset_key, dataset_config, bbox, date_range, location_name
            )
            
            description = dataset_config.get('description', 'No description available.')
            
            hazard_emoji = {
                'hazard_flood': '🌊',
                'hazard_fire': '🔥',
                'hazard_cyclone': '🌀',
                'hazard_drought': '🌾',
                'susceptibility_flood': '⚠️',
                'susceptibility_fire': '⚠️',
                'susceptibility_landslide': '⚠️',
                'susceptibility_cyclone': '⚠️',
                'susceptibility_seismic': '⚠️',
                'environmental': '🌍',
                'terrain': '🏔️',
                'exposure': '👥',
            }
            
            emoji = hazard_emoji.get(dataset_config['type'], '📊')
            response_text = f"{emoji} **{dataset_config['name']}** for **{location_name.replace('_', ' ').title()}**\n\n📊 **What this shows:** {description}"
            
            supports_temporal = dataset_config.get('supports_temporal', False)
            temporal_config = None

            if supports_temporal:
                temporal_config = {
                    'available': True,
                    'enabled': False,
                    'range': dataset_config.get('temporal_range', 'annual'),
                    'start_year': dataset_config.get('temporal_start_year', 2001),
                    'end_year': dataset_config.get('temporal_end_year', 2022),
                    'dataset_key': dataset_key,
                    'collection': dataset_config['collection'],
                    'bbox': bbox,
                    'location_name': location_name
                }
            else:
                temporal_config = {
                    'available': False,
                    'start_year': None,
                    'end_year': None,
                    'dataset_key': dataset_key,
                    'bbox': bbox,
                    'location_name': location_name
                }
            
            return JsonResponse({
                'success': True,
                'layer_id': f'gee-{dataset_key}-{int(datetime.now().timestamp())}',
                'tile_url': layer_data['tile_url'],
                'dataset': dataset_config['name'],
                'dataset_type': dataset_config['type'],
                'location': location_name.replace('_', ' ').title(),
                'date_range': date_range,
                'legend': dataset_config.get('legend', ''),
                'visualization': dataset_config['vis'],
                'response': response_text,
                'description': description,
                'temporal': temporal_config
            })
            
        except Exception as e:
            return JsonResponse({
                'error': str(e),
                'response': f'❌ Error: {str(e)}'
            }, status=500)
    
    def generate_layer(self, dataset_key, dataset_config, bbox, date_range, location_name):
        """Generate layer with AHP support + new compute methods"""
        try:
            aoi = ee.Geometry.Rectangle(bbox)
            compute_func = dataset_config['compute']
            
            # New compute methods
            if compute_func == 'compute_uhii':
                computed_image = EnhancedCompute.compute_uhii(aoi, date_range)
            elif compute_func == 'compute_slr_2050':
                computed_image = EnhancedCompute.compute_slr_2050(aoi)
            elif compute_func == 'compute_slr_2100':
                computed_image = EnhancedCompute.compute_slr_2100(aoi)
            elif compute_func == 'compute_thermal_comfort':
                computed_image = EnhancedCompute.compute_thermal_comfort(aoi, date_range)
            
            # AHP methods
            elif compute_func == 'ahp_flood':
                computed_image = AHPModels.compute_flood_susceptibility(aoi)
            elif compute_func == 'ahp_fire':
                computed_image = AHPModels.compute_fire_susceptibility(aoi, date_range)
            elif compute_func == 'ahp_landslide':
                computed_image = AHPModels.compute_landslide_susceptibility(aoi)
            elif compute_func == 'ahp_cyclone':
                computed_image = AHPModels.compute_cyclone_susceptibility(aoi)
            elif compute_func == 'ahp_seismic':
                computed_image = AHPModels.compute_seismic_susceptibility(aoi)
            elif compute_func == 'composite_drought':
                computed_image = AHPModels.compute_drought_composite(aoi, date_range)
            else:
                # Standard computation
                
                time_filter = dataset_config.get('time_filter', True)
                if time_filter is False:
                    if 'Image' in dataset_config['collection'] or 'DEM' in dataset_config['collection']:
                        image = ee.Image(dataset_config['collection'])
                    else:
                        collection = ee.ImageCollection(dataset_config['collection'])
                        collection = collection.filterBounds(aoi)
                        image = collection.mosaic()
                elif time_filter == 'latest':
                    collection = ee.ImageCollection(dataset_config['collection'])
                    collection = collection.filterBounds(aoi).sort('system:time_start', False).limit(30)

                    if 'COPERNICUS/S2' in dataset_config['collection']:
                        collection = collection.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))

                    if 'S1_GRD' in dataset_config['collection']:
                        image = collection.min()
                    else:
                        image = collection.median()
                else:
                    collection = ee.ImageCollection(dataset_config['collection'])
                    collection = collection.filterBounds(aoi).filterDate(date_range[0], date_range[1])
                    
                    if 'COPERNICUS/S2' in dataset_config['collection']:
                        collection = collection.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                    image = collection.median()
                
                # ✅ NEW: guard against cases where the median image has no bands
                # 🔐 Safety check: avoid "Image has no bands" -> NDVI/NDWI crashes
                band_names = image.bandNames().getInfo()
                if not band_names:
                    logger.warning(
                        f"No bands found for dataset {dataset_key} "
                        f"in date range {date_range} and AOI; collection likely empty."
                    )
                    raise Exception(
                        "No data available for the selected period and location. "
                        "Please try a different year, wider date range, or slightly larger area of interest."
                    )

                computed_image = compute_func(image)
            
            clipped = computed_image.clip(aoi)
            map_id = clipped.getMapId(dataset_config['vis'])

            return {
                'tile_url': map_id['tile_fetcher'].url_format,
                'dataset': dataset_config['name'],
                'location': location_name
            }
            
        except Exception as e:
            raise Exception(f"Layer generation failed: {str(e)}")


# ============================================================================
# TEMPORAL LAYER VIEW - Generate layers for specific years
# ============================================================================
# ============================================================================
# 🔥 OPTIMIZED TEMPORAL LAYER VIEW - BATCH PROCESSING
# ============================================================================

@method_decorator(csrf_exempt, name='dispatch')
class TemporalGEELayerView(View):
    """Optimized temporal layer generation with batch processing"""
    
    def post(self, request):
        try:
            data = json.loads(request.body)
            dataset_key = data.get('dataset_key')
            location_name = data.get('location')
            bbox = data.get('bbox')
            years = data.get('years', [])
            
            if not dataset_key or not location_name or not bbox or not years:
                return JsonResponse({
                    'error': 'Missing required parameters',
                    'required': ['dataset_key', 'location', 'bbox', 'years']
                }, status=400)
            
            dataset_config = GEEDataCatalog.DATASETS.get(dataset_key)
            if not dataset_config:
                return JsonResponse({'error': 'Dataset not found'}, status=404)
            
            if not dataset_config.get('supports_temporal', False):
                return JsonResponse({'error': 'Dataset does not support temporal visualization'}, status=400)
            
            start_year = dataset_config.get('temporal_start_year', 2001)
            end_year = dataset_config.get('temporal_end_year', 2022)
            
            # 🔥 OPTIMIZED: Process all years in single batch
            layers = self.batch_generate_layers(
                dataset_config, bbox, years, start_year, end_year, dataset_key
            )
            
            return JsonResponse({
                'success': True,
                'layers': layers,
                'dataset': dataset_config['name'],
                'location': location_name,
                'visualization': dataset_config['vis'],
                'legend': dataset_config.get('legend', '')
            })
            
        except Exception as e:
            return JsonResponse({
                'error': str(e),
                'message': 'Failed to generate temporal layers'
            }, status=500)
    
        # in views.py, inside TemporalGEELayerView
    def batch_generate_layers(self, dataset_config, bbox, years, start_year, end_year, dataset_key):
        """Batch process multiple years efficiently"""
        try:
            aoi = ee.Geometry.Rectangle(bbox)
            collection = ee.ImageCollection(dataset_config['collection']).filterBounds(aoi)
            compute_func = dataset_config['compute']
            layers = []
            
            for year in years:
                adjusted_year = max(start_year, min(end_year, year))
                
                try:
                    # Create year-specific filter
                    date_range = [f'{adjusted_year}-01-01', f'{adjusted_year}-12-31']
                    
                    # Filter collection for this year
                    year_collection = collection.filterDate(date_range[0], date_range[1])
                    
                    # Check data availability
                    count = year_collection.size().getInfo()
                    
                    if count == 0:
                        # Find nearest available year (simple fallback)
                        for offset in [1, -1, 2, -2]:
                            alt_year = adjusted_year + offset
                            if start_year <= alt_year <= end_year:
                                date_range = [f'{alt_year}-01-01', f'{alt_year}-12-31']
                                year_collection = collection.filterDate(date_range[0], date_range[1])
                                count = year_collection.size().getInfo()
                                if count > 0:
                                    adjusted_year = alt_year
                                    break
                    
                    if count > 0:
                        # Compute image with error handling
                        try:
                            image = year_collection.median()

                            # ✅ NEW: guard against empty images (no bands)
                            band_names = image.bandNames().getInfo()
                            if not band_names or len(band_names) == 0:
                                raise Exception(f"No bands available for {adjusted_year}")
                            
                            computed_image = compute_func(image)

                            # ✅ NEW: generate tile URL for successful years
                            clipped = computed_image.clip(aoi)
                            map_id = clipped.getMapId(dataset_config['vis'])
                            tile_url = map_id['tile_fetcher'].url_format

                            layers.append({
                                'year': adjusted_year,
                                'requested_year': year,
                                'tile_url': tile_url,
                                'available': True,
                                'dataset_key': dataset_key,
                            })
                            continue

                        except Exception as compute_error:
                            print(f"Compute error for {year}: {compute_error}")
                            layers.append({
                                'year': adjusted_year,
                                'requested_year': year,
                                'tile_url': None,
                                'available': False,
                                'error': f'Computation failed: {str(compute_error)}'
                            })
                            continue
                    else:
                        # No data at all (even after fallback)
                        layers.append({
                            'year': adjusted_year,
                            'requested_year': year,
                            'tile_url': None,
                            'available': False,
                            'message': f'No data available for {year}'
                        })
                        
                except Exception as e:
                    print(f"Error generating layer for year {year}: {e}")
                    layers.append({
                        'year': year,
                        'requested_year': year,
                        'tile_url': None,
                        'available': False,
                        'error': str(e)
                    })
            
            return layers
            
        except Exception as e:
            raise Exception(f"Batch generation failed: {str(e)}")


# ============================================================================
# CATALOG VIEW (PRESERVED)
# ============================================================================

class GEECatalogView(View):
    """Return enhanced catalog"""
    
    def get(self, request):
        datasets_by_type = {}
        
        for key, val in GEEDataCatalog.DATASETS.items():
            dataset_type = val.get('type', 'environmental')
            if dataset_type not in datasets_by_type:
                datasets_by_type[dataset_type] = {}
            
            datasets_by_type[dataset_type][key] = {
                'name': val['name'],
                'type': val['type'],
                'priority': val.get('priority', 1),
                'keywords': val['keywords'],
                'description': val.get('description', 'No description available.')
            }
        
        return JsonResponse({
            'datasets_by_type': datasets_by_type,
            'total_datasets': len(GEEDataCatalog.DATASETS),
            'locations': len(GEEDataCatalog.LOCATIONS),
            'project_id': GEE_PROJECT_ID,
            'initialized': GEE_INITIALIZED,
            'features': {
                'ahp_models': True,
                'composite_indices': True,
                'latest_data': True,
                'multi_criteria': True,
                'environmental_monitoring': True,  # NEW
                'climate_scenarios': True  # NEW
            }
        })


# ============================================================================
# LEGEND GENERATOR (PRESERVED)
# ============================================================================

class GenerateLegendView(View):
    """Generate legend images"""
    
    def get(self, request):
        dataset = request.GET.get('dataset', 'Data')
        palette_str = request.GET.get('palette', '00ff00,ffff00,ff0000')
        min_val = request.GET.get('min', '0')
        max_val = request.GET.get('max', '1')
        
        palette = [f'#{color}' for color in palette_str.split(',')]
        
        width, height = 300, 100
        img = Image.new('RGB', (width, height), color='#2a2a2a')
        draw = ImageDraw.Draw(img)
        
        bar_height = 30
        bar_y = 40
        color_width = width // len(palette)
        
        for i, color in enumerate(palette):
            x1 = i * color_width
            x2 = x1 + color_width
            try:
                draw.rectangle([x1, bar_y, x2, bar_y + bar_height], fill=color)
            except:
                draw.rectangle([x1, bar_y, x2, bar_y + bar_height], fill='#cccccc')
        
        draw.rectangle([0, bar_y, width, bar_y + bar_height], outline='white', width=2)
        
        try:
            font_title = ImageFont.truetype("arial.ttf", 14)
            font_values = ImageFont.truetype("arial.ttf", 12)
        except:
            font_title = ImageFont.load_default()
            font_values = ImageFont.load_default()
        
        draw.text((10, 10), dataset, fill='white', font=font_title)
        draw.text((10, bar_y + bar_height + 10), f"Min: {min_val}", fill='white', font=font_values)
        draw.text((width - 70, bar_y + bar_height + 10), f"Max: {max_val}", fill='white', font=font_values)
        
        buffer = io.BytesIO()
        img.save(buffer, format='PNG')
        buffer.seek(0)
        
        return HttpResponse(buffer.getvalue(), content_type='image/png')
#GDELT AND SOCIAL MEDIA VIEWS HERE-----------------------------------------------
# ENHANCED VERSION - Increased Pakistan Focus for Climate, Weather, and Natural Hazards
class RateLimiter:
    """Thread-safe rate limiter for API requests"""
    def __init__(self, max_requests_per_minute=60):
        self.max_requests = max_requests_per_minute
        self.requests = []
        self.lock = threading.Lock()

    def can_make_request(self):
        """Check if we can make a request based on rate limit"""
        with self.lock:
            now = time.time()
            self.requests = [
                req_time for req_time in self.requests if now - req_time < 60
            ]
            if len(self.requests) < self.max_requests:
                self.requests.append(now)
                return True
            return False

    def wait_for_slot(self):
        """Wait until we can make a request"""
        while not self.can_make_request():
            time.sleep(1)


class GDELTClient:
    """Robust GDELT API client with retry logic and SSL error handling"""

    def __init__(self):
        self.base_url = "https://api.gdeltproject.org/api/v2/doc/doc"
        self.session = requests.Session()

        # Configure session with custom headers
        self.session.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Accept-Encoding": "gzip, deflate, br",
                "Accept-Language": "en-US,en;q=0.9",
                "Connection": "keep-alive",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            }
        )

        # Configure retry strategy with version compatibility.
        # NOTE: total=0 (was 3).  The old value meant urllib3 retried 3
        # times BEFORE our own retry loop in fetch_articles() got to
        # decide anything — so every network hiccup ate 1+2+4 = 7 extra
        # seconds inside a SINGLE session.get() call, plus the manual
        # retries on top.  In production this stacked past nginx's
        # 60s proxy_read_timeout → clients saw 504 before Django even
        # returned.  We keep the retry policy in one place now (the
        # manual loop below) and cap the total budget from the caller.
        try:
            retry_strategy = Retry(
                total=0,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["HEAD", "GET", "OPTIONS"],
                backoff_factor=0,
            )
        except TypeError:
            retry_strategy = Retry(
                total=0,
                status_forcelist=[429, 500, 502, 503, 504],
                method_whitelist=["HEAD", "GET", "OPTIONS"],
                backoff_factor=0,
            )

        # Mount adapter with retry strategy
        adapter = HTTPAdapter(max_retries=retry_strategy)
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)

        # Disable SSL verification to handle expired certificates
        # WARNING: This is insecure and should only be used temporarily
        self.session.verify = False

    def fetch_articles(
        self,
        query: str,
        start_date: str,
        end_date: str,
        max_records: int = 200,
        source_country: str = "",
        max_retries: int = 3,
        deadline_seconds: float = 50.0,
    ) -> Dict[str, Any]:
        """
        Fetch articles from GDELT with a hard time budget.

        `deadline_seconds` bounds the TOTAL wall-clock this call may
        consume across all retries and sleeps.  Nginx in production
        proxies with a 60s upstream timeout, so we keep the budget
        strictly under that (default 50s = ~10s safety margin for
        GeoJSON building + serialization + network back to the client).

        Prior versions used 25s which was too aggressive — GDELT's own
        read-timeout could eat a whole attempt, leaving no room for
        even a single retry.  50s comfortably fits 2 attempts at 20s
        each plus the backoff sleep between them.

        The manual retry loop below is the ONLY retry layer now — the
        HTTPAdapter has been configured with total=0.  Between attempts
        we sleep with backoff, but only if the remaining budget
        actually allows another attempt.
        """
        # Query already has OR operators, so wrap in parentheses properly
        final_query = f"({query}) AND sourcelang:english"
        if source_country:
            final_query = f"({query}) AND sourcecountry:{source_country} AND sourcelang:english"

        params = {
            "query": final_query,
            "mode": "artlist",
            "maxrecords": min(max_records, 250),
            "sort": "date",
            "format": "json",
            "startdatetime": start_date,
            "enddatetime": end_date,
        }

        deadline = time.time() + max(1.0, deadline_seconds)
        # Per-attempt HTTP timeout — sized so that at least 2 attempts
        # fit inside the deadline.  Smaller than the old 30s (which
        # allowed only one attempt inside a 60s nginx window) but
        # larger than the too-aggressive 12s we tried earlier.
        per_call_timeout = min(20.0, max(8.0, deadline_seconds / 2.5))

        for attempt in range(max_retries):
            remaining = deadline - time.time()
            if remaining <= 1.0:
                print(f"GDELT: out of time budget after {attempt} attempts, giving up.")
                break
            try:
                print(f"Making GDELT API request (attempt {attempt + 1}/{max_retries}, {remaining:.1f}s left)")

                response = self.session.get(
                    self.base_url,
                    params=params,
                    timeout=min(per_call_timeout, remaining),
                    verify=False,
                    stream=False,
                )

                if response.status_code == 200:
                    try:
                        data = response.json()

                        if isinstance(data, dict) and "articles" in data:
                            articles = data.get("articles", [])
                            print(f"Successfully fetched {len(articles)} articles from GDELT")
                            return data
                        else:
                            print(f"Invalid response structure: {type(data)}")

                    except json.JSONDecodeError as e:
                        print(f"JSON decode error: {e}")

                elif response.status_code == 429:
                    # Cap the 429 backoff HARD — the previous formula
                    # (60 × attempt, cap 300) meant a single 429 could
                    # freeze the request for 5 minutes.  15s cap keeps
                    # the whole retry loop under budget.
                    wait_time = min(5 * (attempt + 1), 15)
                    remaining_now = deadline - time.time()
                    if wait_time >= remaining_now:
                        print(f"GDELT 429: would need {wait_time}s but only {remaining_now:.1f}s left, aborting.")
                        break
                    print(f"GDELT rate limited, waiting {wait_time}s...")
                    time.sleep(wait_time)
                    continue

                elif response.status_code in [500, 502, 503, 504]:
                    print(f"GDELT server error {response.status_code}")

                else:
                    print(f"GDELT HTTP {response.status_code}: {response.text[:200]}")

                # Backoff before the next attempt (short exponential).
                if attempt < max_retries - 1:
                    wait_time = min(1 + attempt, 3)
                    remaining_now = deadline - time.time()
                    if wait_time >= remaining_now:
                        break
                    time.sleep(wait_time)
                    continue

            except requests.exceptions.SSLError as e:
                print(f"SSL Error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                    continue

            except requests.exceptions.ConnectionError as e:
                print(f"Connection error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                    continue

            except requests.exceptions.Timeout as e:
                print(f"Timeout error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                    continue

            except requests.exceptions.RequestException as e:
                print(f"Request error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                    continue

            except Exception as e:
                print(f"Unexpected error on attempt {attempt + 1}: {e}")
                if attempt < max_retries - 1:
                    time.sleep(2**attempt)
                    continue

        print("All retry attempts failed")
        return {"articles": []}

    def test_connection(self):
        """Test the connection to GDELT API"""
        test_params = {
            "query": "earthquake",
            "mode": "artlist",
            "maxrecords": 1,
            "format": "json",
        }

        try:
            print("Testing GDELT API connection...")
            response = self.session.get(
                self.base_url, params=test_params, timeout=10, verify=False
            )
            print(f"Test response status: {response.status_code}")
            print(f"Test response headers: {dict(response.headers)}")
            if response.status_code == 200:
                try:
                    data = response.json()
                    print(
                        f"Test successful - got {len(data.get('articles', []))} articles"
                    )
                    return True
                except json.JSONDecodeError:
                    print("Test failed - invalid JSON response")
                    return False
            else:
                print(f"Test failed - HTTP {response.status_code}")
                return False
        except Exception as e:
            print(f"Test failed - {e}")
            return False


class SocialMediaFetcher:
    """Fetch social media content related to disasters"""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "DisasterNewsAggregator/2.0"})

        # ENHANCED: Pakistan-focused subreddits FIRST, then other regions
        self.disaster_subreddits = [
            # PRIMARY - Pakistan-specific subreddits
            "pakistan",
            "karachi",
            "lahore",
            "islamabad",
            "PakistanWeather",  # If exists
            "Sindh",
            "Punjab",
            "KPK",
            "Balochistan",
            
            # Secondary - Regional South Asia
            "india",
            "afghanistan",
            "iran",
            "bangladesh",
            "nepal",
            
            # General disaster/weather subreddits
            "earthquake",
            "flooding",
            "wildfire",
            "naturaldisasters",
            "weather",
            "climate",
            "ClimateActionPlan",
            "environment",
            
            # Regional subreddits
            "southasia",
            "centralasia",
            "middleeast",
            "news",
            "worldnews",
        ]

        # ENHANCED: Pakistan-specific disaster and climate keywords
        self.disaster_keywords = [
            # Core disaster terms
            "earthquake",
            "flood",
            "flooding",
            "hurricane",
            "tornado",
            "wildfire",
            "tsunami",
            "volcano",
            "landslide",
            "cyclone",
            "storm",
            "disaster",
            "emergency",
            "evacuation",
            "crisis",
            
            # Pakistan-specific terms
            "pakistan",
            "karachi",
            "lahore",
            "islamabad",
            "peshawar",
            "quetta",
            "rawalpindi",
            "faisalabad",
            "multan",
            "gilgit",
            "hunza",
            "chitral",
            "sindh",
            "punjab",
            "balochistan",
            "kpk",
            "khyber pakhtunkhwa",
            "azad kashmir",
            "northern areas",
            
            # Weather and climate terms
            "monsoon",
            "rain",
            "rainfall",
            "heavy rain",
            "downpour",
            "heatwave",
            "heat wave",
            "cold wave",
            "temperature",
            "weather warning",
            "weather alert",
            "met department",
            "pmd",  # Pakistan Meteorological Department
            "ndma",  # National Disaster Management Authority
            "pdma",  # Provincial Disaster Management Authority
            
            # Air quality / Smog (major issue in Pakistan)
            "smog",
            "air quality",
            "pollution",
            "AQI",
            "haze",
            "fog",
            "visibility",
            
            # Climate change
            "climate change",
            "global warming",
            "climate crisis",
            "environmental",
            "drought",
            "water shortage",
            "glacier",
            "glacial lake",
            "GLOF",  # Glacial Lake Outburst Flood
            
            # Natural hazards specific to Pakistan
            "avalanche",
            "rockslide",
            "mudslide",
            "flash flood",
            "urban flooding",
            "riverine flood",
            "indus river",
            "chenab",
            "jhelum",
            "ravi",
            "sutlej",
        ]

    def fetch_reddit_posts(self, limit_per_subreddit=10) -> List[Dict[str, Any]]:
        """Fetch disaster-related posts from Reddit - ENHANCED for Pakistan"""
        reddit_posts = []

        # Increase limit to get more Pakistan content
        for subreddit in self.disaster_subreddits[:15]:  # Increased from 8 to 15
            try:
                url = f"https://www.reddit.com/r/{subreddit}/hot.json"
                params = {'limit': limit_per_subreddit, 't': 'week'}  # Changed to 'week' for more content

                response = self.session.get(url, params=params, timeout=10)
                if response.status_code != 200:
                    continue

                data = response.json()
                posts = []

                for post in data.get("data", {}).get("children", []):
                    post_data = post.get("data", {})
                    title = post_data.get("title", "").lower()
                    selftext = post_data.get("selftext", "").lower()
                    combined_text = title + " " + selftext

                    # Check if post matches any disaster/climate keyword
                    if any(
                        keyword in combined_text
                        for keyword in self.disaster_keywords
                    ):
                        processed_post = {
                            "id": post_data.get("id"),
                            "title": post_data.get("title"),
                            "selftext": post_data.get("selftext", "")[:500],
                            "url": f"https://reddit.com{post_data.get('permalink', '')}",
                            "score": post_data.get("score", 0),
                            "num_comments": post_data.get("num_comments", 0),
                            "created_utc": post_data.get("created_utc", 0),
                            "subreddit": subreddit,
                            "source_type": "reddit",
                        }
                        posts.append(processed_post)

                reddit_posts.extend(posts)
                print(f"Fetched {len(posts)} disaster/climate posts from r/{subreddit}")

            except Exception as e:
                print(f"Error fetching from r/{subreddit}: {e}")
                continue

        return reddit_posts[:50]  # Increased from 20 to 50 for more content

    def fetch_mastodon_posts(self, limit=20) -> List[Dict[str, Any]]:
        """Fetch disaster-related posts from Mastodon public timeline"""
        mastodon_posts = []
        try:
            url = "https://mastodon.social/api/v1/timelines/public"
            params = {"limit": limit, "local": False}
            response = self.session.get(url, params=params, timeout=10)

            if response.status_code == 200:
                posts = response.json()
                for post in posts:
                    content = post.get('content', '').lower()
                    # Remove HTML tags for keyword search
                    content_text = re.sub(r"<[^>]+>", "", content)
                    if any(keyword in content_text for keyword in self.disaster_keywords):
                        processed_post = {
                            'id': post.get('id'),
                            'title': content_text[:100] + '...' if len(content_text) > 100 else content_text,
                            'content': content_text[:500],
                            'url': post.get('url', ''),
                            'created_at': post.get('created_at'),
                            'account': post.get('account', {}).get('display_name', 'Unknown'),
                            'reblogs_count': post.get('reblogs_count', 0),
                            'favourites_count': post.get('favourites_count', 0),
                            'replies_count': post.get('replies_count', 0),
                            'source_type': 'mastodon'
                        }
                        mastodon_posts.append(processed_post)
                print(f"Fetched {len(mastodon_posts)} disaster posts from Mastodon")
            else:
                print(f"Failed to fetch from Mastodon: {response.status_code}")
        except Exception as e:
            print(f"Error fetching from Mastodon: {e}")

        return mastodon_posts


class GdeltNewsEventsApi(View):
    """Enhanced Django view with robust error handling and SSL fixes - PAKISTAN FOCUS ENHANCED"""

    def __init__(self):
        super().__init__()
        self.rate_limiter = RateLimiter(max_requests_per_minute=60)
        self.gdelt_client = GDELTClient()
        self.social_media_fetcher = SocialMediaFetcher()
        self.thread_pool = ThreadPoolExecutor(max_workers=4)

        # ENHANCED: Comprehensive Pakistan coordinate mapping
        self.coordinates = {
            # ========== PAKISTAN - PRIMARY FOCUS (ENHANCED) ==========
            "pakistan": [69.3451, 30.3753],
            
            # Major Cities
            "karachi": [67.0011, 24.8607],
            "lahore": [74.3587, 31.5204],
            "islamabad": [73.0479, 33.6844],
            "rawalpindi": [73.0169, 33.5651],
            "faisalabad": [73.0840, 31.4504],
            "multan": [71.5249, 30.1575],
            "hyderabad": [68.3550, 25.3960],
            "peshawar": [71.5790, 34.0056],
            "quetta": [67.0011, 30.1798],
            "gujranwala": [74.1945, 32.1877],
            "sialkot": [74.5229, 32.4945],
            "bahawalpur": [71.6777, 29.3956],
            "sargodha": [72.6711, 32.0836],
            "sukkur": [68.8571, 27.7052],
            "larkana": [68.2141, 27.5570],
            "sheikhupura": [73.9802, 31.7167],
            "rahim yar khan": [70.3000, 28.4202],
            "jhang": [72.3113, 31.2781],
            "dera ghazi khan": [70.6369, 30.0486],
            "gujrat": [74.0789, 32.5742],
            "sahiwal": [73.1118, 30.6706],
            "wah cantt": [72.7300, 33.7700],
            "mardan": [72.0479, 34.1986],
            "kasur": [74.4500, 31.1167],
            "okara": [73.4504, 30.8081],
            "mingora": [72.3603, 34.7795],
            "nawabshah": [68.4167, 26.2442],
            "chiniot": [72.9781, 31.7167],
            "kotri": [68.3078, 25.3656],
            "kamoke": [74.2236, 31.9756],
            "hafizabad": [73.6861, 32.0689],
            "muridke": [74.2556, 31.8025],
            "sadiqabad": [70.1303, 28.3092],
            "burewala": [72.1500, 30.1667],
            "jacobabad": [68.4389, 28.2769],
            "shikarpur": [68.6383, 27.9556],
            "khuzdar": [66.6667, 27.8000],
            "kohat": [71.4397, 33.5869],
            "hub": [66.9056, 25.0478],
            "daska": [74.3503, 32.3242],
            "charsadda": [71.7406, 34.1453],
            "swabi": [72.4706, 34.1200],
            "abbottabad": [73.2215, 34.1688],
            "mansehra": [73.1975, 34.3300],
            "haripur": [73.1000, 33.9944],
            "bannu": [70.6042, 32.9889],
            "dera ismail khan": [70.9019, 31.8328],
            "nowshera": [71.9747, 34.0153],
            "turbat": [63.0333, 26.0000],
            "gwadar": [62.3311, 25.1264],
            "zhob": [69.4497, 31.3417],
            "pishin": [66.9994, 30.5833],
            "chaman": [66.4597, 30.9206],
            
            # Northern Areas (Climate/Disaster Prone)
            "gilgit": [74.3144, 35.9216],
            "hunza": [74.9227, 36.8527],
            "skardu": [75.5414, 35.2971],
            "chitral": [71.7885, 35.8707],
            "swat": [72.3253, 35.2227],
            "dir": [71.8808, 35.2000],
            "naran": [73.6506, 34.9039],
            "kaghan": [73.6500, 34.9000],
            "murree": [73.3903, 33.9078],
            "nathia gali": [73.3833, 34.0667],
            "ayubia": [73.3833, 34.0500],
            "malam jabba": [72.5667, 34.8000],
            "kalam": [72.5833, 35.4833],
            "bahrain": [72.5500, 35.2167],
            "madyan": [72.5333, 35.1500],
            "attabad lake": [74.8500, 36.3000],
            "passu": [74.8833, 36.4667],
            "khunjerab": [75.4167, 36.8500],
            "fairy meadows": [74.5833, 35.4000],
            "naltar": [74.1833, 36.1500],
            "deosai": [75.4000, 35.0833],
            
            # Coastal Areas (Cyclone/Flood Prone)
            "thatta": [67.9250, 24.7500],
            "badin": [68.8333, 24.6500],
            "tando adam": [68.6500, 25.7667],
            "mirpur khas": [69.0167, 25.5333],
            "tharparkar": [69.7500, 24.9167],
            "umerkot": [69.7333, 25.3667],
            "sanghar": [68.9500, 26.0500],
            "dadu": [67.7833, 26.7333],
            "khairpur": [68.7500, 27.5333],
            
            # Punjab Flood-Prone Areas
            "muzaffargarh": [71.1933, 30.0742],
            "rajanpur": [70.3292, 29.1042],
            "layyah": [70.9375, 30.9639],
            "bhakkar": [71.0667, 31.6333],
            "mianwali": [71.5422, 32.5833],
            "attock": [72.3500, 33.7667],
            "chakwal": [72.8583, 32.9333],
            "jhelum": [73.7306, 32.9425],
            "khanewal": [71.9333, 30.3000],
            "lodhran": [71.6333, 29.5333],
            "vehari": [72.3500, 30.0450],
            "pakpattan": [73.3833, 30.3500],
            "toba tek singh": [72.4833, 30.9667],
            "nankana sahib": [73.7000, 31.4500],
            "narowal": [74.8833, 32.1000],
            "mandi bahauddin": [73.4917, 32.5872],
            
            # Azad Kashmir (Earthquake Prone)
            "muzaffarabad": [73.4722, 34.3697],
            "mirpur": [73.7514, 33.1481],
            "kotli": [73.9183, 33.5156],
            "rawalakot": [73.7603, 33.8583],
            "bhimber": [74.0750, 32.9750],
            "bagh": [73.7833, 33.9833],
            "neelum valley": [74.3333, 34.6000],
            
            # Province Names (for broader matching)
            "sindh": [68.7667, 25.8943],
            "punjab": [72.7569, 31.1704],
            "balochistan": [66.9750, 28.4907],
            "kpk": [71.5249, 34.0151],
            "khyber pakhtunkhwa": [71.5249, 34.0151],
            "gilgit baltistan": [74.6324, 35.8026],
            "azad kashmir": [73.9611, 33.9282],
            "fata": [70.5000, 33.5000],
            
            # Rivers (Flood monitoring)
            "indus river": [68.3683, 24.8500],
            "chenab": [73.0500, 32.0833],
            "jhelum": [73.7306, 32.9425],
            "ravi": [74.0833, 31.5833],
            "sutlej": [74.5000, 31.0833],
            "kabul river": [71.4397, 34.0056],
            
            # OTHER SOUTH ASIAN COUNTRIES
            "iran": [53.6880, 32.4279],
            "india": [78.9629, 20.5937],
            "afghanistan": [67.7090, 33.9391],
            "bangladesh": [90.3563, 23.6850],
            "nepal": [84.1240, 28.3949],
            "sri lanka": [80.7718, 7.8731],
            "myanmar": [95.9560, 21.9162],
            "thailand": [100.9925, 15.8700],
            "vietnam": [108.2772, 14.0583],
            "cambodia": [104.8901, 12.5657],
            "laos": [104.1954, 19.8523],
            "malaysia": [101.9758, 4.2105],
            "singapore": [103.8198, 1.3521],
            "indonesia": [113.9213, -0.7893],
            "philippines": [121.7740, 12.8797],
            
            # INDIA MAJOR CITIES
            "mumbai": [72.8777, 19.0760],
            "delhi": [77.1025, 28.7041],
            "bangalore": [77.5946, 12.9716],
            "kolkata": [88.3639, 22.5726],
            "chennai": [80.2707, 13.0827],
            "pune": [73.8353, 18.5204],
            "ahmedabad": [72.5714, 23.0225],
            "jaipur": [75.7885, 26.9124],
            "lucknow": [80.9462, 26.8467],
            "surat": [72.8311, 21.1702],
            "kochi": [76.2711, 9.9312],
            "goa": [73.8278, 15.4909],
            "srinagar": [75.5941, 34.0837],
            
            # AFGHANISTAN MAJOR CITIES
            "kabul": [69.1761, 34.5553],
            "kandahar": [65.7097, 31.6257],
            "herat": [62.1977, 34.3425],
            "mazar-i-sharif": [67.1167, 36.7197],
            "jalalabad": [70.4580, 34.4247],
            "kunduz": [68.8738, 36.7280],
            "balkh": [67.8292, 36.7601],
            
            # IRAN MAJOR CITIES
            "tehran": [51.3890, 35.6892],
            "isfahan": [51.6644, 32.6546],
            "tabriz": [46.2919, 38.0688],
            "shiraz": [52.5384, 29.5832],
            "mashhad": [59.5671, 36.2605],
            "ahvaz": [48.6753, 31.3183],
            "quom": [50.8764, 34.6413],
            "rasht": [49.5832, 37.2808],
            "karaj": [51.0099, 35.8364],
            "hamadan": [48.5156, 34.7994],
            
            # BANGLADESH MAJOR CITIES
            "dhaka": [90.3563, 23.8103],
            "chittagong": [91.8363, 22.3384],
            "khulna": [89.1667, 22.8456],
            "sylhet": [91.8660, 24.8949],
            
            # NEPAL MAJOR CITIES
            "kathmandu": [85.3206, 27.7172],
            "pokhara": [83.9863, 28.2096],
            "lalitpur": [85.3206, 27.6408],
            
            # SRI LANKA MAJOR CITIES
            "colombo": [79.8612, 6.9271],
            "kandy": [80.6339, 7.2906],
            "galle": [80.2168, 6.0535],
            
            # MYANMAR MAJOR CITIES
            "yangon": [96.1951, 16.8661],
            "naypyidaw": [97.4852, 19.7633],
            "mandalay": [96.0891, 21.9588],
            
            # THAILAND MAJOR CITIES
            "bangkok": [100.5018, 13.7563],
            "chiang mai": [98.9853, 18.7883],
            
            # VIETNAM MAJOR CITIES
            "hanoi": [105.8342, 21.0285],
            "ho chi minh": [106.6296, 10.8231],
            
            # INDONESIA MAJOR CITIES
            "jakarta": [106.8456, -6.2088],
            "surabaya": [112.7508, -7.2575],
            
            # SECONDARY LOCATIONS
            "london": [-0.1276, 51.5074],
            "dubai": [55.2708, 25.2048],
            "istanbul": [28.9784, 41.0082],
            "ankara": [32.8597, 39.9334],
            "cairo": [31.2357, 30.0444],
            "riyadh": [46.6753, 24.7136],
        }

        # ENHANCED: Pakistan news sources (SIGNIFICANTLY EXPANDED)
        self.allowed_domains = {
            # ========== PAKISTAN NEWS SOURCES (COMPREHENSIVE) ==========
            # Major English News
            "dawn.com",
            "geo.tv",
            "thenews.com.pk",
            "arynews.tv",
            "tribune.com.pk",
            "samaa.tv",
            "bolnews.com",
            "dunyanews.tv",
            "expressnews.pk",
            "24newshd.tv",
            "haboronline.com",
            "pakistantoday.com.pk",
            "dailytimes.com.pk",
            "nation.com.pk",
            "brecorder.com",
            "pkr.brecorder.com",
            "thebusinesstoday.com",
            "propertytimes.com.pk",
            
            # Regional Pakistan News
            "karachiherald.com",
            "laaborenews.com",
            "islamabadpost.com.pk",
            "peshawarpost.com",
            "balochistanvoices.com",
            "pashtunistan.com",
            
            # Pakistan Weather/Climate Specific
            "pmd.gov.pk",  # Pakistan Meteorological Department
            "ndma.gov.pk",  # National Disaster Management Authority
            "pakwx.com",  # Pakistan Weather
            "pakmet.com.pk",
            
            # Pakistan Environment/Climate News
            "environment.gov.pk",
            "epa.gov.pk",
            "wwfpak.org",
            
            # Pakistan Wire Services
            "app.com.pk",  # Associated Press of Pakistan
            "ppi.com.pk",  # Pakistan Press International
            "inp.org.pk",  # Independent News Pakistan
            
            # Business/Economic (often cover climate impact)
            "propakistani.pk",
            "profit.pakistantoday.com.pk",
            
            # India News Sources
            "thehindu.com",
            "deccanherald.com",
            "theindiantimes.com",
            "indiatimes.com",
            "theprint.in",
            "firstpost.com",
            "ndtv.com",
            "hindustantimes.com",
            "timesofindia.indiatimes.com",
            "indianexpress.com",
            "scroll.in",
            "thewire.in",
            
            # Afghanistan News Sources
            "tolonews.com",
            "pajhwok.com",
            "khaama.com",
            "ariana.af",
            "1tvnews.af",
            
            # Iran News Sources
            "irna.ir",
            "isna.ir",
            "mehr.com",
            "farsnews.com",
            "presstv.ir",
            "tehrantimes.com",
            
            # Bangladesh News Sources
            "thedailystar.net",
            "newagebd.net",
            "dhakamirror.com",
            "bdnews24.com",
            "prothomalo.com",
            
            # Nepal News Sources
            "nagariknews.com",
            "onlinekhabar.com",
            "thehimalayantimes.com",
            "kathmandupost.com",
            "myrepublica.nagariknetwork.com",
            
            # Sri Lanka News Sources
            "newsfirst.lk",
            "colombopage.com",
            "sundaytimes.lk",
            "dailymirror.lk",
            
            # Regional International Sources
            "aljazeera.com",
            "bbc.co.uk",
            "bbc.com",
            "reuters.com",
            "apnews.com",
            "dw.com",
            "voanews.com",
            "france24.com",
            "rfi.fr",
            "theguardian.com",
            "cnn.com",
            "nytimes.com",
            "washingtonpost.com",
            
            # Climate/Environment Specific International
            "climatechangenews.com",
            "carbonbrief.org",
            "theconversation.com",
            "scidev.net",
            "reliefweb.int",
            "floodlist.com",
            "preventionweb.net",
        }

        # ENHANCED: Event classification keywords with Pakistan-specific terms
        self.event_keywords = {
            "earthquake": [
                "earthquake", "quake", "seismic", "tremor", "aftershock",
                "richter", "magnitude", "epicenter", "fault line"
            ],
            "flood": [
                "flood", "flash flood", "flooding", "inundation", "deluge",
                "riverine flood", "urban flooding", "floodwater", "embankment breach"
            ],
            "landslide": [
                "landslide", "mudslide", "rockslide", "debris flow", "slope failure"
            ],
            "tsunami": ["tsunami", "tidal wave"],
            "cyclone": [
                "hurricane", "cyclone", "typhoon", "tropical storm", "tropical depression"
            ],
            "storm": [
                "storm", "tornado", "thunderstorm", "tempest", "windstorm",
                "dust storm", "sandstorm", "hailstorm"
            ],
            "wildfire": [
                "wildfire", "bushfire", "forest fire", "grass fire", "blaze"
            ],
            "volcano": ["volcano", "volcanic", "eruption", "lava", "ash cloud"],
            "drought": [
                "drought", "water shortage", "water scarcity", "dry spell", "arid"
            ],
            "extreme weather": [
                "heatwave", "heat wave", "cold wave", "lightning", "hailstorm",
                "blizzard", "extreme temperature", "record heat", "record cold"
            ],
            "conflict": ["war", "conflict", "battle", "fighting", "combat"],
            "explosion": ["explosion", "blast", "bomb", "bombing", "detonation"],
            "accident": ["accident", "crash", "collision", "derailment"],
            "attack": ["attack", "terrorism", "shooting", "assault"],
            "fire": ["fire", "blaze", "inferno", "conflagration"],
            "crisis": ["crisis", "humanitarian", "disaster", "emergency", "catastrophe"],
            
            # ===== WEATHER & CLIMATE (ENHANCED) =====
            "weather": [
                "weather", 
                "temperature", 
                "precipitation", 
                "rainfall",
                "snowfall",
                "rainfall warning",
                "weather alert",
                "weather warning",
                "met department",
                "pmd",
                "forecast",
                "weather system",
            ],
            "monsoon": [
                "monsoon",
                "monsoon rain",
                "monsoon season",
                "pre-monsoon",
                "post-monsoon",
                "southwest monsoon",
                "monsoon depression",
                "monsoon flooding",
            ],
            "heatwave": [
                "heatwave",
                "heat wave",
                "extreme heat",
                "record temperature",
                "scorching",
                "temperature surge",
                "heat stroke",
                "heat emergency",
            ],
            "cold_wave": [
                "cold wave",
                "extreme cold",
                "freezing",
                "frost",
                "blizzard",
                "snowstorm",
                "hypothermia",
                "freezing temperature",
            ],
            
            # ===== AIR QUALITY & SMOG (MAJOR PAKISTAN ISSUE) =====
            "air_quality": [
                "air quality",
                "air pollution",
                "AQI",
                "air quality index",
                "pollution alert",
                "air quality warning",
                "toxic air",
                "hazardous air",
            ],
            "smog": [
                "smog",
                "haze",
                "smog alert",
                "smog warning",
                "fog",
                "visibility",
                "air haze",
                "smog season",
                "lahore smog",
                "winter smog",
            ],
            "pollution": [
                "pollution",
                "pollutant",
                "particulate matter",
                "PM2.5",
                "PM10",
                "nitrogen dioxide",
                "ozone",
                "sulfur dioxide",
                "carbon monoxide",
                "industrial pollution",
            ],
            
            # ===== CLIMATE =====
            "climate": [
                "climate",
                "climate change",
                "global warming",
                "climate crisis",
                "climate emergency",
                "climate action",
                "carbon emissions",
            ],
            "climate_change": [
                "climate change",
                "global warming",
                "greenhouse gas",
                "carbon emissions",
                "carbon footprint",
                "climate warming",
                "climate adaptation",
                "climate mitigation",
            ],
            "environmental": [
                "environmental",
                "environmental crisis",
                "environmental disaster",
                "environmental emergency",
                "ecology",
                "ecological",
                "deforestation",
                "biodiversity loss",
            ],
            
            # ===== PAKISTAN-SPECIFIC HAZARDS =====
            "glacier": [
                "glacier",
                "glacial",
                "glacial lake",
                "GLOF",
                "glacial lake outburst",
                "glacier melt",
                "glacier retreat",
                "ice dam",
            ],
            "avalanche": [
                "avalanche",
                "snow avalanche",
                "snowslide",
                "snow disaster",
            ],
        }

    def get(self, request, *args, **kwargs):
        """Main GET endpoint with improved error handling"""
        try:
            # ENHANCED: Default query - simplified to avoid GDELT "query too long" error
            # Using OR operators only, Pakistan focus through coordinate extraction
            search_query = request.GET.get(
                "query",
                "disaster OR earthquake OR flood OR hurricane OR wildfire OR volcano OR weather OR pollution OR smog OR climate OR monsoon OR landslide OR pakistan",
            )
            days_back = min(int(request.GET.get("days", 7)), 30)  # Max 30 days
            max_records = min(int(request.GET.get("max_records", 250)), 250)  # Increased to 250
            source_country = request.GET.get('source_country', '')
            include_social_media = request.GET.get('include_social_media', 'true').lower() == 'true'
            include_reddit = request.GET.get('include_reddit', 'true').lower() == 'true'
            include_mastodon = (
                request.GET.get("include_mastodon", "true").lower() == "true"
            )
            include_only_social_media = request.GET.get('include_only_social_media', 'false').lower() == 'true'

            # Calculate date range
            end_date = datetime.utcnow().replace(hour=23, minute=59, second=59, microsecond=0)
            start_date = end_date - timedelta(days=days_back)
            start_date_str = start_date.strftime("%Y%m%d%H%M%S")
            end_date_str = end_date.strftime("%Y%m%d%H%M%S")

            print("Starting data fetching with ENHANCED PAKISTAN FOCUS...")

            # Cache key covers everything that affects the response — a
            # cache hit means the SAME (query, days, max_records, sources,
            # include-flags) tuple can be served from memory instantly.
            # bucket_10min rounds the current UTC minute down so hits
            # within the same 10-minute window reuse the same key.
            bucket_10min = int(time.time()) // 600
            cache_key = (
                f"gdelt_news|q={hash(search_query)}|d={days_back}|m={max_records}|"
                f"sc={source_country}|ism={include_social_media}|iom={include_only_social_media}|"
                f"ir={include_reddit}|im={include_mastodon}|b={bucket_10min}"
            )
            cached = cache.get(cache_key)
            if cached:
                print("GDELT: serving fresh cached response.")
                return JsonResponse(cached)

            # NOTE: previous code called self.gdelt_client.test_connection()
            # here, which fired an extra network round-trip on every user
            # click.  That test frequently 429'd (Nginx would 504 waiting
            # for the retries) even when the real fetch below would have
            # succeeded — and its result was thrown away.  Skipped.

            # Initialize data containers
            gdelt_data = {'articles': []}
            social_media_data = []

            # Determine what to fetch
            if include_only_social_media:
                print("Fetching ONLY social media data (GDELT disabled)")
                if include_social_media:
                    social_media_data = self._fetch_social_media_data(include_reddit, include_mastodon)
                else:
                    return JsonResponse(
                        {
                            "error": "include_only_social_media is true but include_social_media is false",
                            "status": "error",
                        },
                        status=400,
                    )
            else:
                print("Fetching GDELT data (PAKISTAN ENHANCED) and optionally social media data")

                # Rate limiting
                self.rate_limiter.wait_for_slot()

                # Fetch GDELT data
                gdelt_data = self.gdelt_client.fetch_articles(
                    query=search_query,
                    start_date=start_date_str,
                    end_date=end_date_str,
                    max_records=max_records,
                    source_country=source_country,
                )

                # Check if GDELT failed
                if not gdelt_data or not gdelt_data.get("articles"):
                    print(
                        "GDELT API failed, checking if social media can provide data..."
                    )
                    if not include_social_media:
                        # Stale-fallback: if we have a last-known-good
                        # response for this query tuple, hand it back
                        # as 200 with metadata.stale=true so the client
                        # keeps rendering yesterday's cards instead of
                        # an empty panel + fatal error.
                        try:
                            stable_key = cache_key.rsplit("|b=", 1)[0] + "|lkg"
                            stale = cache.get(stable_key)
                            if stale and stale.get("features"):
                                print("GDELT: upstream failed; serving stale LKG.")
                                stale_meta = dict(stale.get("metadata") or {})
                                stale_meta["stale"] = True
                                stale_meta["stale_reason"] = "GDELT upstream unavailable (likely rate-limited)"
                                return JsonResponse({**stale, "metadata": stale_meta})
                        except Exception:
                            pass
                        # No cache to fall back on — return an EMPTY
                        # valid GeoJSON with an inline warning instead
                        # of 503.  This lets the frontend render a
                        # friendly "News temporarily unavailable" state
                        # via the same code path it uses for normal
                        # responses, and it stops nginx from surfacing
                        # a bare Bad Gateway page in production.
                        return JsonResponse(
                            {
                                "type": "FeatureCollection",
                                "features": [],
                                "metadata": {
                                    "generated_at": datetime.utcnow().isoformat(),
                                    "sources": [],
                                    "total_features": 0,
                                    "stale": False,
                                    "error": True,
                                    "error_reason": (
                                        "GDELT upstream is currently rate-limited "
                                        "or unreachable. Try refreshing in a few minutes."
                                    ),
                                },
                            },
                            status=200,
                        )

                # Fetch social media data if requested
                if include_social_media:
                    social_media_data = self._fetch_social_media_data(
                        include_reddit, include_mastodon
                    )

            # Convert to GeoJSON
            geojson_data = self._convert_to_geojson(gdelt_data, social_media_data)

            # Add metadata
            sources = []
            if not include_only_social_media and gdelt_data.get("articles"):
                sources.append("GDELT 2.0 Doc API")
            if include_social_media or include_only_social_media:
                if include_reddit:
                    sources.append("Reddit")
                if include_mastodon:
                    sources.append("Mastodon")

            geojson_data["metadata"] = {
                "query": search_query,
                "date_range": {
                    "start": start_date.isoformat(),
                    "end": end_date.isoformat(),
                },
                "total_features": len(geojson_data["features"]),
                "gdelt_articles": (
                    len(gdelt_data.get("articles", []))
                    if not include_only_social_media
                    else 0
                ),
                "social_media_posts": len(social_media_data),
                "sources": sources,
                "generated_at": datetime.utcnow().isoformat(),
                "social_media_only": include_only_social_media,
                "geographic_scope": "PAKISTAN ENHANCED - Climate, Weather, Natural Hazards Focus",
                "pakistan_cities_mapped": "100+ cities including all major urban centers, northern areas, coastal regions, flood-prone areas",
                "ssl_warning": (
                    "GDELT API SSL certificate issues detected - using alternative SSL handling"
                    if not include_only_social_media
                    else None
                ),
                "stale": False,
            }

            # Cache the successful response for 10 min AND also keep a
            # "last-known-good" copy under a stable key for the stale-
            # fallback path below.  The bucketed key expires with the
            # bucket; the last-known-good key survives multiple buckets
            # so a failed refresh can still hand back yesterday's news
            # instead of an empty panel.
            if geojson_data.get("features"):
                cache.set(cache_key, geojson_data, 600)
                stable_key = cache_key.rsplit("|b=", 1)[0] + "|lkg"
                cache.set(stable_key, geojson_data, 86400)  # 24 h

            return JsonResponse(geojson_data)

        except ValueError as e:
            return JsonResponse(
                {"error": f"Invalid parameter: {str(e)}", "status": "error"}, status=400
            )
        except Exception as e:
            print(f"Unexpected server error: {e}")
            # Stale-fallback: if we have a last-known-good response for
            # THIS query tuple, serve it with metadata.stale = True so
            # the browser can render the last-good cards and just tag
            # the panel as "showing older data" instead of an empty box.
            try:
                bucket_10min = int(time.time()) // 600
                cache_key_local = (
                    f"gdelt_news|q={hash(search_query)}|d={days_back}|m={max_records}|"
                    f"sc={source_country}|ism={include_social_media}|iom={include_only_social_media}|"
                    f"ir={include_reddit}|im={include_mastodon}|b={bucket_10min}"
                )
                stable_key = cache_key_local.rsplit("|b=", 1)[0] + "|lkg"
                stale = cache.get(stable_key)
                if stale:
                    print("GDELT: upstream failed; serving stale last-known-good response.")
                    meta = stale.get("metadata") or {}
                    meta = {**meta, "stale": True, "stale_reason": str(e)[:200]}
                    stale = {**stale, "metadata": meta}
                    return JsonResponse(stale)
            except Exception:
                pass

            return JsonResponse(
                {
                    "error": "Internal server error",
                    "status": "error",
                    "message": "Please try again later or contact support",
                    "technical_details": (
                        str(e) if hasattr(e, "__str__") else "Unknown error"
                    ),
                },
                status=500,
            )

    def _fetch_social_media_data(
        self, include_reddit=True, include_mastodon=True
    ) -> List[Dict[str, Any]]:
        """Fetch social media data from multiple sources concurrently"""
        social_media_data = []
        futures = []

        with ThreadPoolExecutor(max_workers=2) as executor:
            if include_reddit:
                future_reddit = executor.submit(
                    self.social_media_fetcher.fetch_reddit_posts
                )
                futures.append(("reddit", future_reddit))

            if include_mastodon:
                future_mastodon = executor.submit(
                    self.social_media_fetcher.fetch_mastodon_posts
                )
                futures.append(("mastodon", future_mastodon))

            # Collect results
            for source, future in futures:
                try:
                    result = future.result(timeout=30)
                    social_media_data.extend(result)
                    print(f"Collected {len(result)} posts from {source}")
                except Exception as e:
                    print(f"Error collecting from {source}: {e}")

        return social_media_data

    def _normalize_title(self, title: str) -> str:
        """Normalize title for deduplication"""
        if not title:
            return ""
        normalized = re.sub(r"[^\w\s]", " ", title.lower().strip())
        return " ".join(normalized.split())

    def _deduplicate_articles(
        self, articles: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Remove duplicate articles based on title similarity"""
        seen_titles = set()
        unique_articles = []
        duplicate_count = 0

        # Sort by date (newest first)
        articles_sorted = sorted(
            articles, key=lambda x: x.get("seendate", ""), reverse=True
        )

        for article in articles_sorted:
            normalized_title = self._normalize_title(article.get("title", ""))
            if normalized_title in seen_titles:
                duplicate_count += 1
                continue
            seen_titles.add(normalized_title)
            unique_articles.append(article)

        print(f"Deduplication: Removed {duplicate_count} duplicate articles")
        print(f"Unique articles after deduplication: {len(unique_articles)}")
        return unique_articles

    def _convert_to_geojson(
        self, gdelt_data: Dict[Any, Any], social_media_data: List[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Convert data to GeoJSON format with enhanced processing"""
        geojson = {"type": "FeatureCollection", "features": []}

        if not gdelt_data or 'articles' not in gdelt_data:
            gdelt_data = {"articles": []}
        if social_media_data is None:
            social_media_data = []

        print(
            f"Total articles fetched from GDELT: {len(gdelt_data.get('articles', []))}"
        )
        print(f"Total social media posts fetched: {len(social_media_data)}")

        # Process GDELT articles with deduplication
        gdelt_articles = self._deduplicate_articles(gdelt_data.get("articles", []))

        # Track statistics
        articles_with_coords = 0
        articles_from_allowed_domains = 0
        pakistan_articles = 0
        unknown_domains = set()

        # Process GDELT articles
        for article in gdelt_articles:
            try:
                domain = article.get("domain", "")
                is_allowed_domain = domain in self.allowed_domains

                if not is_allowed_domain:
                    unknown_domains.add(domain)

                coordinates = self._extract_coordinates(article)
                if coordinates:
                    articles_with_coords += 1

                    # Check if this is a Pakistan article
                    title_lower = article.get("title", "").lower()
                    url_lower = article.get("url", "").lower()
                    is_pakistan_article = any(
                        pk_term in title_lower or pk_term in url_lower
                        for pk_term in ["pakistan", "karachi", "lahore", "islamabad", "peshawar", "quetta", "sindh", "punjab", "balochistan", "kpk"]
                    )
                    if is_pakistan_article:
                        pakistan_articles += 1

                    if is_allowed_domain or True:  # Set to True for permissive mode
                        if is_allowed_domain:
                            articles_from_allowed_domains += 1

                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": coordinates},
                            "properties": {
                                "title": article.get("title", "No title"),
                                "url": article.get("url", ""),
                                "domain": domain,
                                "language": article.get("language", ""),
                                "seendate": article.get("seendate", ""),
                                "sourcecountry": article.get("sourcecountry", ""),
                                "socialimage": article.get("socialimage", ""),
                                "tone": article.get("tone"),
                                "event_type": self._classify_event_type(
                                    article.get("title", "")
                                ),
                                "formatted_date": self._format_date(
                                    article.get("seendate", "")
                                ),
                                "summary": self._generate_summary(article),
                                "is_trusted_source": is_allowed_domain,
                                "source_platform": "gdelt",
                                "content_type": "news_article",
                                "is_pakistan_related": is_pakistan_article,
                            },
                        }
                        geojson["features"].append(feature)

            except Exception as e:
                print(f"Error processing GDELT article: {e}")
                continue

        # Process social media posts
        social_media_features = 0
        pakistan_social_posts = 0
        for post in social_media_data:
            try:
                coordinates = self._extract_coordinates_from_social_media(post)
                if coordinates:
                    # Check if Pakistan-related
                    post_text = f"{post.get('title', '')} {post.get('content', '')} {post.get('selftext', '')}".lower()
                    is_pakistan_post = any(
                        pk_term in post_text
                        for pk_term in ["pakistan", "karachi", "lahore", "islamabad", "peshawar", "quetta", "sindh", "punjab", "balochistan", "kpk"]
                    )
                    if is_pakistan_post:
                        pakistan_social_posts += 1

                    if post["source_type"] == "reddit":
                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": coordinates},
                            "properties": {
                                "title": post.get("title", "No title"),
                                "url": post.get("url", ""),
                                "domain": "reddit.com",
                                "language": "en",
                                "seendate": self._format_timestamp(
                                    post.get("created_utc", 0)
                                ),
                                "sourcecountry": "",
                                "socialimage": "",
                                "tone": self._estimate_tone_from_score(
                                    post.get("score", 0)
                                ),
                                "event_type": self._classify_event_type(
                                    post.get("title", "")
                                ),
                                "formatted_date": self._format_timestamp(
                                    post.get("created_utc", 0)
                                ),
                                "summary": f"Reddit post from r/{post.get('subreddit', 'unknown')} - {post.get('title', '')[:100]}",
                                "is_trusted_source": False,
                                "source_platform": "reddit",
                                "content_type": "social_media_post",
                                "reddit_score": post.get("score", 0),
                                "reddit_comments": post.get("num_comments", 0),
                                "reddit_subreddit": post.get("subreddit", ""),
                                "upvote_ratio": post.get("upvote_ratio", 0),
                                "post_content": post.get("selftext", "")[:200],
                                "is_pakistan_related": is_pakistan_post,
                            },
                        }
                    elif post["source_type"] == "mastodon":
                        feature = {
                            "type": "Feature",
                            "geometry": {"type": "Point", "coordinates": coordinates},
                            "properties": {
                                "title": post.get("title", "No title"),
                                "url": post.get("url", ""),
                                "domain": "mastodon.social",
                                "language": "en",
                                "seendate": post.get("created_at", ""),
                                "sourcecountry": "",
                                "socialimage": "",
                                "tone": self._estimate_tone_from_engagement(
                                    post.get("favourites_count", 0),
                                    post.get("reblogs_count", 0),
                                ),
                                "event_type": self._classify_event_type(
                                    post.get("title", "")
                                ),
                                "formatted_date": self._format_mastodon_date(
                                    post.get("created_at", "")
                                ),
                                "summary": f"Mastodon post by {post.get('account', 'unknown')} - {post.get('title', '')[:100]}",
                                "is_trusted_source": False,
                                "source_platform": "mastodon",
                                "content_type": "social_media_post",
                                "mastodon_favourites": post.get("favourites_count", 0),
                                "mastodon_reblogs": post.get("reblogs_count", 0),
                                "mastodon_replies": post.get("replies_count", 0),
                                "mastodon_author": post.get("account", ""),
                                "post_content": post.get("content", "")[:200],
                                "is_pakistan_related": is_pakistan_post,
                            },
                        }

                    geojson["features"].append(feature)
                    social_media_features += 1

            except Exception as e:
                print(f"Error processing social media post: {e}")
                continue

        # Enhanced logging with Pakistan focus metrics
        print(f"Processing Statistics (PAKISTAN ENHANCED):")
        print(f"  Total GDELT articles: {len(gdelt_data.get('articles', []))}")
        print(f"  Unique articles after deduplication: {len(gdelt_articles)}")
        print(f"  Articles with extractable coordinates: {articles_with_coords}")
        print(f"  Articles from allowed domains: {articles_from_allowed_domains}")
        print(f"  PAKISTAN-RELATED ARTICLES: {pakistan_articles}")
        print(f"  Social media posts with coordinates: {social_media_features}")
        print(f"  PAKISTAN-RELATED SOCIAL POSTS: {pakistan_social_posts}")
        print(f"  Final features created: {len(geojson['features'])}")

        if unknown_domains:
            print(
                f"Unknown domains encountered ({len(unknown_domains)}): {sorted(list(unknown_domains)[:10])}"
            )
            if len(unknown_domains) > 10:
                print(f"  ... and {len(unknown_domains) - 10} more")

        return geojson

    def _extract_coordinates(self, article: Dict[str, Any]) -> Optional[List[float]]:
        """Enhanced coordinate extraction from article data - PAKISTAN PRIORITY"""
        # Method 1: Extract from socialimage URL
        social_image = article.get('socialimage', '')
        if social_image and 'lat=' in social_image and 'lon=' in social_image:
            try:
                lat_match = re.search(r'lat=([^&]+)', social_image)
                lon_match = re.search(r'lon=([^&]+)', social_image)
                if lat_match and lon_match:
                    lat, lon = float(lat_match.group(1)), float(lon_match.group(1))
                    if -90 <= lat <= 90 and -180 <= lon <= 180:
                        return [lon, lat]
            except (ValueError, AttributeError):
                pass

        # Method 2: Search text for locations - PAKISTAN PRIORITY
        text_to_search = f"{article.get('title', '').lower()} {article.get('url', '').lower()}"

        # Search coordinates first (cities are more specific)
        # Priority order: Pakistan cities first, then other locations
        pakistan_locations = [k for k in self.coordinates.keys() if k in [
            "pakistan", "karachi", "lahore", "islamabad", "rawalpindi", "faisalabad",
            "multan", "hyderabad", "peshawar", "quetta", "gilgit", "hunza", "skardu",
            "chitral", "swat", "murree", "muzaffarabad", "gwadar", "sindh", "punjab",
            "balochistan", "kpk", "khyber pakhtunkhwa"
        ]]
        
        # Check Pakistan locations first
        for location in pakistan_locations:
            if re.search(r'\b' + re.escape(location) + r'\b', text_to_search):
                return self.coordinates[location]
        
        # Then check all other locations
        for location, coords in self.coordinates.items():
            if re.search(r'\b' + re.escape(location) + r'\b', text_to_search):
                return coords

        # Method 3: Use source country as fallback
        source_country = article.get('sourcecountry', '')
        if source_country in self.coordinates:
            return self.coordinates[source_country]

        return None

    def _extract_coordinates_from_social_media(
        self, post: Dict[str, Any]
    ) -> Optional[List[float]]:
        """Extract coordinates from social media posts - PAKISTAN PRIORITY"""
        # Combine title and content for location search
        text_to_search = f"{post.get('title', '').lower()} {post.get('content', '').lower()} {post.get('selftext', '').lower()}"

        # Priority: Check Pakistan locations first
        pakistan_locations = [k for k in self.coordinates.keys() if k in [
            "pakistan", "karachi", "lahore", "islamabad", "rawalpindi", "faisalabad",
            "multan", "hyderabad", "peshawar", "quetta", "gilgit", "hunza", "skardu",
            "chitral", "swat", "murree", "muzaffarabad", "gwadar", "sindh", "punjab",
            "balochistan", "kpk", "khyber pakhtunkhwa"
        ]]
        
        for location in pakistan_locations:
            if re.search(r"\b" + re.escape(location) + r"\b", text_to_search):
                return self.coordinates[location]

        # Search all coordinates for location names
        for location, coords in self.coordinates.items():
            if re.search(r"\b" + re.escape(location) + r"\b", text_to_search):
                return coords

        return None

    def _classify_event_type(self, title: str) -> str:
        """Classify the type of event based on title keywords"""
        title_lower = title.lower()
        for event_type, keywords in self.event_keywords.items():
            if any(keyword in title_lower for keyword in keywords):
                return event_type
        return 'other'

    def _format_date(self, seendate: str) -> str:
        """Format the date string for display"""
        if not seendate:
            return ""
        try:
            if len(seendate) >= 14:
                dt = datetime.strptime(seendate[:14], '%Y%m%d%H%M%S')
                return dt.strftime('%Y-%m-%d %H:%M UTC')
        except ValueError:
            pass
        return seendate

    def _generate_summary(self, article: Dict[str, Any]) -> str:
        """Generate a summary for the article"""
        title = article.get('title', '')
        domain = article.get('domain', '')
        country = article.get('sourcecountry', '')

        summary_parts = []
        if title:
            summary_parts.append(title[:100] + '...' if len(title) > 100 else title)
        if domain:
            summary_parts.append(f"Source: {domain}")
        if country:
            summary_parts.append(f"Country: {country}")

        return ' | '.join(summary_parts)

    def _format_timestamp(self, timestamp: float) -> str:
        """Format Unix timestamp to readable date"""
        if not timestamp:
            return ""
        try:
            dt = datetime.fromtimestamp(timestamp)
            return dt.strftime("%Y%m%d%H%M%S")
        except:
            return ""

    def _format_mastodon_date(self, date_str: str) -> str:
        """Format Mastodon date string"""
        if not date_str:
            return ""
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d %H:%M UTC")
        except:
            return date_str

    def _estimate_tone_from_score(self, score: int) -> float:
        """Estimate tone from Reddit score"""
        if score >= 100:
            return 5.0
        elif score >= 50:
            return 2.5
        elif score >= 10:
            return 1.0
        elif score >= 0:
            return 0.0
        else:
            return -2.5

    def _estimate_tone_from_engagement(self, favourites: int, reblogs: int) -> float:
        """Estimate tone from Mastodon engagement"""
        total_engagement = favourites + reblogs
        if total_engagement >= 20:
            return 3.0
        elif total_engagement >= 10:
            return 1.5
        elif total_engagement >= 5:
            return 0.5
        else:
            return 0.0

    def __del__(self):
        """Cleanup thread pool on destruction"""
        try:
            if hasattr(self, "thread_pool"):
                self.thread_pool.shutdown(wait=False)
        except:
            pass


class _WopRateLimiter:
    def __init__(self, rate_per_sec=8):
        self.interval = 1.0 / rate_per_sec
        self.lock = threading.Lock()
        self.last = 0.0

    def wait(self):
        with self.lock:
            now = time.time()
            elapsed = now - self.last
            if elapsed < self.interval:
                time.sleep(self.interval - elapsed)
            self.last = time.time()


_wop_limiter = _WopRateLimiter(rate_per_sec=8)


class WindOceanParticleDataApi(LoginRequiredMixin, View):
    """
    GET /api/wind-ocean-particles/?sw_lat=&sw_lng=&ne_lat=&ne_lng=
    Returns:
    {
      "bbox": {...},
      "meta": {...},
      "wind": [{lat,lon,u,v,spd}, ...],
      "ocean": [{lat,lon,u,v,spd}, ...]
    }
    """

    WIND_URL = "https://api.open-meteo.com/v1/forecast"
    MARINE_URL = "https://marine-api.open-meteo.com/v1/marine"

    GRID_ROWS = 6
    GRID_COLS = 10
    CACHE_TTL = 3600
    REQ_TIMEOUT = 10
    MAX_WORKERS = 16

    @staticmethod
    def _normalize_bbox(sw_lat, sw_lng, ne_lat, ne_lng):
        sw_lat = max(float(sw_lat), -85.0)
        ne_lat = min(float(ne_lat), 85.0)
        sw_lng = float(sw_lng)
        ne_lng = float(ne_lng)

        if sw_lat > ne_lat:
            sw_lat, ne_lat = ne_lat, sw_lat

        def norm_lon(lon):
            while lon < -180:
                lon += 360
            while lon > 180:
                lon -= 360
            return lon

        sw_lng = norm_lon(sw_lng)
        ne_lng = norm_lon(ne_lng)

        return sw_lat, sw_lng, ne_lat, ne_lng

    @staticmethod
    def _bbox_span(sw_lat, sw_lng, ne_lat, ne_lng):
        lat_span = max(0.1, abs(ne_lat - sw_lat))
        lon_span = abs(ne_lng - sw_lng)
        if lon_span > 180:
            lon_span = 360 - lon_span
        lon_span = max(0.1, lon_span)
        return lat_span, lon_span

    def _grid_shape(self, sw_lat, sw_lng, ne_lat, ne_lng):
        lat_span, lon_span = self._bbox_span(sw_lat, sw_lng, ne_lat, ne_lng)

        rows = self.GRID_ROWS
        cols = self.GRID_COLS

        if lat_span > 20:
            rows += 1
        if lat_span > 40:
            rows += 1

        if lon_span > 25:
            cols += 2
        if lon_span > 50:
            cols += 2

        rows = min(rows, 8)
        cols = min(cols, 14)
        return rows, cols

    @staticmethod
    def _make_grid(sw_lat, sw_lng, ne_lat, ne_lng, rows, cols):
        if sw_lng <= ne_lng:
            return [
                (
                    round(sw_lat + (ne_lat - sw_lat) * r / max(rows - 1, 1), 3),
                    round(sw_lng + (ne_lng - sw_lng) * c / max(cols - 1, 1), 3),
                )
                for r in range(rows)
                for c in range(cols)
            ]

        west_span = 180 - sw_lng
        east_span = ne_lng + 180
        total_span = west_span + east_span

        pts = []
        for r in range(rows):
            lat = round(sw_lat + (ne_lat - sw_lat) * r / max(rows - 1, 1), 3)
            for c in range(cols):
                frac = c / max(cols - 1, 1)
                offset = frac * total_span
                if offset <= west_span:
                    lon = sw_lng + offset
                else:
                    lon = -180 + (offset - west_span)
                pts.append((lat, round(lon, 3)))
        return pts

    def _fetch_wind(self, lat: float, lon: float) -> Optional[Dict]:
        # Once we know the daily quota is exhausted, don't waste more
        # requests on Open-Meteo — every subsequent call would just get
        # HTTP 429 back and flood the terminal.  The quota resets at UTC
        # midnight; per-instance short-circuit is enough since the same
        # request handler owns the flag for the lifetime of one GET.
        if self._wind_quota_exhausted:
            return None
        _wop_limiter.wait()
        try:
            r = requests.get(
                self.WIND_URL,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "wind_speed_10m,wind_direction_10m",
                    "wind_speed_unit": "ms",
                },
                timeout=self.REQ_TIMEOUT,
            )
            r.raise_for_status()
            d = r.json()

            c = d.get("current", {}) or {}
            spd = c.get("wind_speed_10m")
            dirn = c.get("wind_direction_10m")

            if spd is None or dirn is None:
                h = d.get("hourly", {}) or {}
                spd_arr = h.get("wind_speed_10m") or []
                dir_arr = h.get("wind_direction_10m") or []
                if spd_arr and dir_arr:
                    spd = spd_arr[0]
                    dirn = dir_arr[0]

            if spd is None or dirn is None:
                self._wind_errors.append(f"lat={lat},lon={lon}: no current/hourly wind fields in response")
                return None

            spd = float(spd)
            dirn = float(dirn)
            rad = math.radians(dirn)

            return {
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "u": round(-math.sin(rad) * spd, 4),
                "v": round(-math.cos(rad) * spd, 4),
                "spd": round(spd, 2),
            }
        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            body = ""
            try:
                body = (e.response.text or "")[:200]
            except Exception:
                pass
            # HTTP 429 with "Daily API request limit exceeded" is the
            # ONLY 429 signature Open-Meteo emits when the free-tier
            # quota is done for the day — flip the short-circuit flag
            # so the remaining grid cells don't each get their own
            # rejected request + terminal line.
            if status == 429 and "Daily API request limit exceeded" in body:
                self._wind_quota_exhausted = True
                # Record ONE canonical warning instead of 80 identical
                # rows; the view will hand this to the client as
                # meta.warning so the browser can surface it.
                if not self._wind_errors:
                    self._wind_errors.append(
                        "Open-Meteo daily wind-forecast quota exhausted. "
                        "Wind particles will resume after UTC midnight."
                    )
                return None
            msg = f"HTTP {status} at lat={lat},lon={lon}"
            if body:
                msg += f" body={body!r}"
            self._wind_errors.append(msg)
            print(f"[WOP wind] {msg}")
            return None
        except Exception as e:
            msg = f"lat={lat},lon={lon}: {type(e).__name__}: {e}"
            self._wind_errors.append(msg)
            print(f"[WOP wind] failed {msg}")
            return None

    def _fetch_ocean(self, lat: float, lon: float) -> Optional[Dict]:
        # Same short-circuit pattern as _fetch_wind — once the marine
        # endpoint's daily quota is done, skip the rest of the grid.
        if self._ocean_quota_exhausted:
            return None
        _wop_limiter.wait()
        try:
            r = requests.get(
                self.MARINE_URL,
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "ocean_current_velocity,ocean_current_direction",
                    "hourly": "ocean_current_velocity,ocean_current_direction",
                    "cell_selection": "sea",
                    "length_unit": "metric",
                },
                timeout=self.REQ_TIMEOUT,
            )
            r.raise_for_status()
            d = r.json()

            if d.get("error"):
                return None

            c = d.get("current", {}) or {}
            spd = c.get("ocean_current_velocity")
            dirn = c.get("ocean_current_direction")

            if spd is None or dirn is None:
                h = d.get("hourly", {}) or {}
                spd_arr = h.get("ocean_current_velocity") or []
                dir_arr = h.get("ocean_current_direction") or []
                if spd_arr and dir_arr:
                    spd = spd_arr[0]
                    dirn = dir_arr[0]

            if spd is None or dirn is None:
                return None

            spd = float(spd)
            dirn = float(dirn)

            if not math.isfinite(spd) or not math.isfinite(dirn):
                return None

            rad = math.radians(dirn)

            return {
                "lat": round(lat, 4),
                "lon": round(lon, 4),
                "u": round(math.sin(rad) * spd, 4),
                "v": round(math.cos(rad) * spd, 4),
                "spd": round(spd, 4),
            }
        except requests.exceptions.HTTPError as e:
            status = getattr(e.response, "status_code", None)
            body = ""
            try:
                body = (e.response.text or "")[:200]
            except Exception:
                pass
            if status == 429 and "Daily API request limit exceeded" in body:
                self._ocean_quota_exhausted = True
                if not self._ocean_errors:
                    self._ocean_errors.append(
                        "Open-Meteo daily ocean-currents quota exhausted. "
                        "Ocean particles will resume after UTC midnight."
                    )
                return None
            msg = f"HTTP {status} at lat={lat},lon={lon}"
            if body:
                msg += f" body={body!r}"
            self._ocean_errors.append(msg)
            print(f"[WOP ocean] {msg}")
            return None
        except Exception as e:
            msg = f"lat={lat},lon={lon}: {type(e).__name__}: {e}"
            self._ocean_errors.append(msg)
            print(f"[WOP ocean] failed {msg}")
            return None

    def get(self, request, *args, **kwargs):
        try:
            sw_lat, sw_lng, ne_lat, ne_lng = self._normalize_bbox(
                request.GET["sw_lat"],
                request.GET["sw_lng"],
                request.GET["ne_lat"],
                request.GET["ne_lng"],
            )
        except (KeyError, TypeError, ValueError):
            return JsonResponse({"error": "Invalid bbox params"}, status=400)

        rows, cols = self._grid_shape(sw_lat, sw_lng, ne_lat, ne_lng)

        ck = (
            f"wop|{round(sw_lat, 2)}|{round(sw_lng, 2)}|"
            f"{round(ne_lat, 2)}|{round(ne_lng, 2)}|{rows}|{cols}"
        )

        cached = cache.get(ck)
        if cached:
            return JsonResponse(cached)

        grid = self._make_grid(sw_lat, sw_lng, ne_lat, ne_lng, rows, cols)

        wind_pts: List[Dict] = []
        ocean_pts: List[Dict] = []
        # Diagnostic collectors — each _fetch_* appends when it returns
        # None so the response's `meta.wind_errors` block surfaces WHY
        # a request failed instead of forcing us to check Django's stdout.
        self._wind_errors: List[str] = []
        self._ocean_errors: List[str] = []
        # Quota short-circuit flags — once flipped, remaining grid cells
        # skip the network call entirely so we don't hammer Open-Meteo
        # with 80+ requests that will all return HTTP 429.
        self._wind_quota_exhausted = False
        self._ocean_quota_exhausted = False

        with ThreadPoolExecutor(max_workers=self.MAX_WORKERS) as ex:
            wind_futs = [ex.submit(self._fetch_wind, lat, lon) for lat, lon in grid]
            ocean_futs = [ex.submit(self._fetch_ocean, lat, lon) for lat, lon in grid]

            for fut in as_completed(wind_futs):
                try:
                    res = fut.result()
                    if res is not None:
                        wind_pts.append(res)
                except Exception as e:
                    print(f"[WOP wind future] {e}")

            for fut in as_completed(ocean_futs):
                try:
                    res = fut.result()
                    if res is not None:
                        ocean_pts.append(res)
                except Exception as e:
                    print(f"[WOP ocean future] {e}")

        # Compose a single, user-facing `warning` string when EITHER
        # provider is out of daily quota — the frontend uses this to
        # surface a toast + auto-toggle the button off instead of
        # leaving it visually "on" while nothing renders.
        warning = None
        if self._wind_quota_exhausted and self._ocean_quota_exhausted:
            warning = ("Wind and ocean data unavailable — Open-Meteo's daily "
                       "quota is exhausted. Both feeds resume after UTC midnight.")
        elif self._wind_quota_exhausted:
            warning = ("Wind data unavailable — Open-Meteo's daily quota is "
                       "exhausted. Wind animation resumes after UTC midnight.")
        elif self._ocean_quota_exhausted:
            warning = ("Ocean currents unavailable — Open-Meteo's daily quota is "
                       "exhausted. Ocean animation resumes after UTC midnight.")

        # Emit ONE terminal summary line instead of ~80 identical 429 rows.
        if self._wind_quota_exhausted or self._ocean_quota_exhausted:
            print(f"[WOP] quota exhausted — wind:{self._wind_quota_exhausted} "
                  f"ocean:{self._ocean_quota_exhausted} — served "
                  f"{len(wind_pts)} wind / {len(ocean_pts)} ocean pts from partial fetch")

        payload = {
            "bbox": {"s": sw_lat, "w": sw_lng, "n": ne_lat, "e": ne_lng},
            "meta": {
                "rows": rows,
                "cols": cols,
                "grid_count": len(grid),
                "wind_count": len(wind_pts),
                "ocean_count": len(ocean_pts),
                "empty": (len(wind_pts) == 0 and len(ocean_pts) == 0),
                # First few failure reasons — bounded so the payload
                # stays small even if every grid cell errored.  Client
                # code ignores meta; this is purely for browser DevTools.
                "wind_errors":  self._wind_errors[:5],
                "ocean_errors": self._ocean_errors[:5],
                # Quota flags + user-facing message.
                "wind_quota_exhausted":  self._wind_quota_exhausted,
                "ocean_quota_exhausted": self._ocean_quota_exhausted,
                "warning": warning,
            },
            "wind": wind_pts,
            "ocean": ocean_pts,
        }

        if wind_pts or ocean_pts:
            cache.set(ck, payload, self.CACHE_TTL)

        return JsonResponse(payload)


# ==================== UTILITY FUNCTIONS & TESTING ====================

def test_gdelt_connection():
    """Test GDELT API connection with SSL bypass"""
    print("Testing GDELT API connection...")
    client = GDELTClient()
    return client.test_connection()


def test_social_media_integration():
    """Test function to verify social media integration works"""
    print("Testing Social Media Integration...")

    fetcher = SocialMediaFetcher()

    print("\nTesting Reddit integration (PAKISTAN ENHANCED)...")
    reddit_posts = fetcher.fetch_reddit_posts(limit_per_subreddit=10)
    print(f"Reddit test completed: {len(reddit_posts)} posts fetched")

    print("\nTesting Mastodon integration...")
    mastodon_posts = fetcher.fetch_mastodon_posts(limit=10)
    print(f"Mastodon test completed: {len(mastodon_posts)} posts fetched")

    return reddit_posts + mastodon_posts


class PerformanceMonitor:
    """Monitor API performance and provide metrics"""
    def __init__(self):
        self.metrics = {
            "total_requests": 0,
            "gdelt_fetch_time": [],
            "social_media_fetch_time": [],
            "processing_time": [],
            "error_count": 0,
            "ssl_errors": 0,
        }

    def log_request(
        self,
        gdelt_time: float,
        social_time: float,
        processing_time: float,
        error: bool = False,
        ssl_error: bool = False,
    ):
        """Log performance metrics for a request"""
        self.metrics['total_requests'] += 1
        self.metrics['gdelt_fetch_time'].append(gdelt_time)
        self.metrics['social_media_fetch_time'].append(social_time)
        self.metrics['processing_time'].append(processing_time)
        if error:
            self.metrics['error_count'] += 1
        if ssl_error:
            self.metrics["ssl_errors"] += 1

    def get_stats(self) -> Dict[str, Any]:
        """Get performance statistics"""
        if not self.metrics['gdelt_fetch_time']:
            return {"message": "No requests processed yet"}

        return {
            "total_requests": self.metrics["total_requests"],
            "error_rate": self.metrics["error_count"]
            / self.metrics["total_requests"]
            * 100,
            "ssl_error_rate": self.metrics["ssl_errors"]
            / self.metrics["total_requests"]
            * 100,
            "avg_gdelt_fetch_time": sum(self.metrics["gdelt_fetch_time"])
            / len(self.metrics["gdelt_fetch_time"]),
            "avg_social_media_fetch_time": sum(self.metrics["social_media_fetch_time"])
            / len(self.metrics["social_media_fetch_time"]),
            "avg_processing_time": sum(self.metrics["processing_time"])
            / len(self.metrics["processing_time"]),
        }


def diagnose_ssl_issues():
    """Diagnose SSL issues with GDELT API"""
    import ssl
    import socket

    print("Diagnosing SSL issues with GDELT API...")

    try:
        # Test basic connection
        context = ssl.create_default_context()
        with socket.create_connection(
            ("api.gdeltproject.org", 443), timeout=10
        ) as sock:
            with context.wrap_socket(
                sock, server_hostname="api.gdeltproject.org"
            ) as ssock:
                print(f"SSL connection successful")
                print(f"SSL version: {ssock.version()}")
                print(f"Cipher: {ssock.cipher()}")
                cert = ssock.getpeercert()
                print(f"Certificate subject: {cert.get('subject', 'N/A')}")
                print(f"Certificate issuer: {cert.get('issuer', 'N/A')}")
                print(f"Certificate expires: {cert.get('notAfter', 'N/A')}")

    except ssl.SSLError as e:
        print(f"SSL Error: {e}")
        print("This confirms the SSL certificate issue.")

    except Exception as e:
        print(f"Connection Error: {e}")


def configure_for_production():
    """Configure settings for production environment"""
    print(
        """
    PRODUCTION CONFIGURATION NOTES (PAKISTAN ENHANCED VERSION):
    
    1. SSL Certificate Issue:
       - The GDELT API SSL certificate has expired
       - Current code bypasses SSL verification (INSECURE!)
       - For production, either:
         a) Wait for GDELT to fix their certificate
         b) Use a custom certificate bundle
         c) Implement proper certificate pinning
    
    2. Security Recommendations:
       - Remove 'verify=False' from requests
       - Add proper certificate validation
       - Implement request signing if available
       - Add rate limiting per IP
       - Add authentication if required
    
    3. Monitoring:
       - Enable logging to files
       - Add health check endpoints
       - Monitor SSL certificate expiration
       - Track API response times
    
    4. Error Handling:
       - Implement circuit breaker pattern
       - Add proper retry strategies
       - Cache responses when appropriate
       - Implement graceful degradation
    
    5. PAKISTAN ENHANCED Geographic Scope:
       - 100+ Pakistan cities mapped
       - All major urban centers covered
       - Northern areas (climate-sensitive)
       - Coastal regions (cyclone-prone)
       - Flood-prone areas
       - Earthquake zones (Azad Kashmir)
       - 40+ Pakistan news sources
       - Pakistan-specific subreddits
       - Climate/Weather/Hazard keywords
    """
    )


if __name__ == "__main__":
    # Run diagnostics
    print("=== GDELT API Diagnostics (PAKISTAN ENHANCED) ===")
    diagnose_ssl_issues()

    print("\n=== Connection Test ===")
    test_gdelt_connection()

    print("\n=== Social Media Test (PAKISTAN ENHANCED) ===")
    test_social_media_integration()

    print("\n=== Production Notes ===")
    configure_for_production()


# ==================================================================
#  IPC / Food Security proxy — resolves the latest analysis for a
#  country against IPC Info's public API and returns the GeoJSON.
#  Additive — new class, new URL route, does not touch any existing
#  view or dispatcher.
#
#  Why this needs a backend at all: the "latest analysis" resolve
#  requires a two-step chain (GET /analyses → sort → GET /areas/<id>/P)
#  that Mapbox's built-in GeoJSON source can't do on its own.  Doing
#  it server-side also fixes the country-code bug documented in the
#  GCOP integration notes: IPC's /analyses endpoint expects ISO 3166
#  alpha-2 codes, not the alpha-3 codes GCOP was originally sending,
#  which silently forced every ipc_* layer to fall back to a stale
#  hardcoded snapshot instead of the true latest.
#
#  The response is cached per-country for 6 hours (IPC publishes
#  analysis cycles quarterly, so hourly cache invalidation would be
#  wasteful).  Failure returns an empty FeatureCollection so the
#  frontend just renders nothing instead of an error state.
# ==================================================================
class IpcFoodSecurityAPIView(View):
    IPC_KEY  = "ec20f488-0457-448e-b9f0-c32900af975c"
    ANALYSES = "https://api.ipcinfo.org/analyses"
    AREAS    = "https://api.ipcinfo.org/areas"
    CACHE_TTL = 6 * 3600  # 6 hours

    # ISO 3166 alpha-2 codes — verified live against /analyses on
    # 2026-07-27.  Scoped to the South-Asia trio that's directly
    # relevant to NCOP's operational area; every one of these returns
    # at least one non-empty polygon analysis.  Countries IPC does NOT
    # currently classify (India, Iran, Sri Lanka, Nepal, Bhutan,
    # Myanmar) would return empty lists — see integration notes.
    COUNTRY_CODES = {
        "pakistan":    "PK",
        "afghanistan": "AF",
        "bangladesh":  "BD",
    }

    # Max analyses we'll walk before giving up.  IPC's newest published
    # analysis is often a "projection" or table without polygon geometry
    # (Somalia's newest ID currently returns 0 features), so we fall
    # through to the next-newest until one returns features > 0.  Six
    # is plenty — polygon publication happens on every real cycle.
    MAX_ANALYSIS_WALK = 6

    def get(self, request, country):
        country = (country or "").lower()
        if country not in self.COUNTRY_CODES:
            return JsonResponse(
                {"type": "FeatureCollection", "features": [],
                 "meta": {"error": f"unsupported country '{country}'"}},
                status=404,
            )

        cache_key = f"ipc_fc|{country}"
        cached = cache.get(cache_key)
        if cached:
            return JsonResponse(cached)

        code = self.COUNTRY_CODES[country]
        # Ordered list of candidate analysis IDs, newest first.  We walk
        # this list (fetching /areas/<id>/P per attempt) until one
        # returns non-empty features — see MAX_ANALYSIS_WALK note.
        candidates = self._resolve_analysis_candidates(code)
        if not candidates:
            empty = {"type": "FeatureCollection", "features": [],
                     "meta": {"error": "no analysis available", "country": country}}
            return JsonResponse(empty, status=200)

        last_error = None
        for ana_id in candidates:
            try:
                r = requests.get(
                    f"{self.AREAS}/{ana_id}/P",
                    params={"format": "geojson", "key": self.IPC_KEY},
                    timeout=15,
                )
                r.raise_for_status()
                data = r.json()
            except Exception as e:
                last_error = str(e)
                print(f"[IPC] /areas fetch failed for {country} (id={ana_id}): {e}")
                continue

            feats = (data or {}).get("features") or [] if isinstance(data, dict) else []
            if not feats:
                # Common case — the newest analysis is a projection
                # without polygon geometry; fall through to older ones.
                print(f"[IPC] {country} analysis {ana_id} has 0 features, trying next.")
                continue

            # Success — stamp meta so the frontend can show which
            # analysis cycle is on screen and cache for 6 h.
            data.setdefault("meta", {})
            data["meta"]["analysis_id"] = ana_id
            data["meta"]["country"] = country
            data["meta"]["feature_count"] = len(feats)
            cache.set(cache_key, data, self.CACHE_TTL)
            return JsonResponse(data)

        # Walked every candidate without finding one with polygons.
        return JsonResponse(
            {"type": "FeatureCollection", "features": [],
             "meta": {"error": f"no analysis with polygon data available (last: {last_error})",
                      "country": country, "tried_ids": candidates}},
            status=200,
        )

    def _resolve_analysis_candidates(self, alpha2_code):
        """Return analysis ids newest-first (sorted by year, then created)."""
        try:
            r = requests.get(
                self.ANALYSES,
                params={
                    "format": "json",
                    "type": "A",
                    "country": alpha2_code,
                    "key": self.IPC_KEY,
                },
                timeout=10,
            )
            r.raise_for_status()
            payload = r.json()
        except Exception as e:
            print(f"[IPC] /analyses failed for {alpha2_code}: {e}")
            return []
        if not isinstance(payload, list) or not payload:
            return []
        # Sort by (year, created) desc — the original code sorted by
        # `from_date` which doesn't exist on any IPC response, so the
        # sort was effectively a no-op and depended on IPC's own
        # response order.  These two fields are always present.
        payload.sort(
            key=lambda a: (a.get("year") or 0, a.get("created") or ""),
            reverse=True,
        )
        return [str(a.get("id") or "") for a in payload[: self.MAX_ANALYSIS_WALK] if a.get("id")]


# ==================================================================
#  IPC PTT (Population Tracking Tool) proxy — yearly historical
#  analyses for a country.
#
#  IPC's PTT is a public dashboard on top of a public JSON endpoint at
#  gsu-prod.ipc.codes.  We hit /api/ptt/data-with-meta which returns
#  every published analysis for the requested country across the year
#  range, each with `totals.current` / `totals.projected-1` blocks
#  containing the phase-1..5 populations + percentages the modal's
#  history tab needs.  Not scraping — this is the same JSON endpoint
#  IPC's own dashboard consumes.
#
#  Normalized so the frontend gets one flat row per analysis, sorted
#  oldest → newest for chart X-axis chronology.  Cached 24 h — IPC
#  publishes on a quarterly cycle, so per-hour invalidation would be
#  overkill.  Failure returns an empty timeline (200 with
#  meta.error) rather than an HTTP error so the modal can render a
#  friendly empty-state.
# ==================================================================
class IpcHistoryAPIView(View):
    PTT_URL = "https://gsu-prod.ipc.codes/api/ptt/data-with-meta/2017,2027"
    CACHE_TTL = 24 * 3600

    COUNTRY_CODES = IpcFoodSecurityAPIView.COUNTRY_CODES  # reuse alpha-2 map

    def get(self, request, country):
        country = (country or "").lower()
        if country not in self.COUNTRY_CODES:
            return JsonResponse(
                {"analyses": [], "meta": {"error": f"unsupported country '{country}'"}},
                status=404,
            )

        cache_key = f"ipc_ptt|{country}"
        cached = cache.get(cache_key)
        if cached:
            return JsonResponse(cached)

        code = self.COUNTRY_CODES[country]
        try:
            r = requests.get(
                self.PTT_URL,
                params={"country": code, "limit": 100},
                headers={"User-Agent": "NCOP/1.0", "Accept": "application/json"},
                timeout=20,
            )
            r.raise_for_status()
            payload = r.json()
        except Exception as e:
            print(f"[IPC PTT] fetch failed for {country}: {e}")
            return JsonResponse(
                {"analyses": [], "meta": {"error": str(e)[:200], "country": country}},
                status=200,
            )

        raw = payload.get("data") or []
        normalized = []
        for it in raw:
            if not isinstance(it, dict):
                continue
            totals = it.get("totals") or {}
            # Prefer "current" period totals; fall back to first
            # projected block if the analysis is projection-only.
            period_key = None
            block = None
            for k in ("current", "projected-1", "projected-2"):
                if isinstance(totals.get(k), dict) and totals[k]:
                    period_key = k
                    block = totals[k]
                    break
            if not block:
                continue

            date_str = it.get("analysis_date") or it.get("fanalysis_date") or ""
            normalized.append({
                "anl_id":            str(it.get("anl_id") or ""),
                "title":             it.get("title") or "",
                "date":              date_str[:10] if isinstance(date_str, str) else "",
                "period":            period_key,
                "analyzed_pop":      block.get("analyzedPopulation") or 0,
                "phase1_pop":        block.get("phase1Population") or 0,
                "phase2_pop":        block.get("phase2Population") or 0,
                "phase3_pop":        block.get("phase3Population") or 0,
                "phase4_pop":        block.get("phase4Population") or 0,
                "phase5_pop":        block.get("phase5Population") or 0,
                "phase3plus_pop":    block.get("phase3PlusPopulation") or 0,
                "phase1_pct":        block.get("phase1Percentage") or 0,
                "phase2_pct":        block.get("phase2Percentage") or 0,
                "phase3_pct":        block.get("phase3Percentage") or 0,
                "phase4_pct":        block.get("phase4Percentage") or 0,
                "phase5_pct":        block.get("phase5Percentage") or 0,
                "phase3plus_pct":    block.get("phase3PlusPercentage") or 0,
                "country_population": it.get("country_population") or 0,
            })

        # Oldest first — chart X-axis reads left-to-right by convention.
        normalized.sort(key=lambda a: a.get("date") or "")

        result = {
            "analyses": normalized,
            "meta": {
                "country":   country,
                "count":     len(normalized),
                "source":    "gsu-prod.ipc.codes / IPC PTT public API",
                "cached_ttl_seconds": self.CACHE_TTL,
            },
        }
        cache.set(cache_key, result, self.CACHE_TTL)
        return JsonResponse(result)


# ==================================================================
#  Pakistan Crop Data proxy — na.data.gov.pk/Crops/*
#  ----------------------------------------------------------------
#  The upstream site (Pakistan Bureau of Statistics' National
#  Account Dashboard for crops) publishes a stable public JSON API
#  under /Crops/Get*.  We proxy it so:
#    * the frontend can consume it with same-origin cookies (some
#      browsers block third-party form-POST responses),
#    * we get a 24-hour Django cache in front of an origin that
#      typically responds in 1-3 s,
#    * one code path can normalize error responses to
#      { data: [] } instead of an HTML error page.
#
#  Endpoints (frontend base = /api/crops/):
#    GET  list/                        → 121 crops [{id, name}]
#    GET  years/                       → fiscal-year dropdown values
#    GET  summary/?crop&year&level&area  → single-cell current-year card
#    GET  yearly/?crop&level&area      → full ~44-year time series
#    GET  map/?crop&year&level         → per-region values (province/division/district)
#
#  All are cached per (endpoint + query string).  Failure returns
#  { data: [] } with HTTP 200 so the modal renders empty state.
#  No HTML scraping — every endpoint is JSON.
# ==================================================================
class _CropsBaseView(View):
    BASE_URL  = "https://na.data.gov.pk/Crops"
    CACHE_TTL = 24 * 3600
    TIMEOUT   = 20

    def _fetch(self, path, method="GET", data=None, cache_key_extra=""):
        cache_key = f"crops|{method}|{path}|{cache_key_extra}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
        url = f"{self.BASE_URL}{path}"
        try:
            if method == "GET":
                r = requests.get(url, timeout=self.TIMEOUT,
                                 headers={"User-Agent": "NCOP/1.0",
                                          "Accept": "application/json"})
            else:
                r = requests.post(url, data=(data or {}), timeout=self.TIMEOUT,
                                  headers={"User-Agent": "NCOP/1.0",
                                           "Accept": "application/json"})
            r.raise_for_status()
            payload = r.json()
        except Exception as e:
            print(f"[crops] {method} {path} failed: {e}")
            return {"data": [], "meta": {"error": str(e)[:200]}}
        cache.set(cache_key, payload, self.CACHE_TTL)
        return payload


class CropListAPIView(_CropsBaseView):
    def get(self, request):
        return JsonResponse(self._fetch("/GetCrops"))


class CropYearsAPIView(_CropsBaseView):
    def get(self, request):
        return JsonResponse(self._fetch("/GetSelectList/?item=year",
                                        cache_key_extra="year"))


class CropSummaryAPIView(_CropsBaseView):
    def get(self, request):
        params = {
            "level": request.GET.get("level", "11"),
            "area":  request.GET.get("area",  "0"),
            "year":  request.GET.get("year",  "2021-22"),
            "crop":  request.GET.get("crop",  "4"),
        }
        key = f"{params['level']}|{params['area']}|{params['year']}|{params['crop']}"
        return JsonResponse(
            self._fetch("/GetSimpleCard", method="POST", data=params,
                        cache_key_extra=key)
        )


class CropYearlyAPIView(_CropsBaseView):
    def get(self, request):
        # Full historical time series — ~44 fiscal years for the classic crops.
        params = {
            "level": request.GET.get("level", "11"),
            "area":  request.GET.get("area",  "0"),
            "crop":  request.GET.get("crop",  "4"),
        }
        key = f"{params['level']}|{params['area']}|{params['crop']}"
        return JsonResponse(
            self._fetch("/GetYearly", method="POST", data=params,
                        cache_key_extra=key)
        )


class CropMapAPIView(_CropsBaseView):
    def get(self, request):
        # Per-region breakdown.  level: 11=Province, 12=Division, 13=District.
        params = {
            "level": request.GET.get("level", "11"),
            "year":  request.GET.get("year",  "2021-22"),
            "crop":  request.GET.get("crop",  "4"),
        }
        key = f"{params['level']}|{params['year']}|{params['crop']}"
        return JsonResponse(
            self._fetch("/GetMap", method="POST", data=params,
                        cache_key_extra=key)
        )


# ==================================================================
#  Crop choropleth GeoJSON endpoint — joins polygons + values
#  ----------------------------------------------------------------
#  na.data.gov.pk publishes two independent JSON feeds:
#    * /Scripts/polygons/Provinces.json      → an ARRAY of
#         { code, name, boundary: <MultiPolygon> }
#    * /Crops/GetMap                          → per-region values
#         { data: [{ id, name, production, area, yield }] }
#  The `code` on the polygon file matches the `id` on the map feed
#  1-for-1, so we join them here server-side and hand the frontend a
#  standards-compliant FeatureCollection Mapbox's geojson source can
#  consume directly.  This keeps the map layer registration in
#  map-layers.js identical in shape to every other vector layer NCOP
#  ships — no client-side stitching required.
#
#  Cached 24 h per (crop, year, level).  Failure returns an empty
#  FeatureCollection with meta.error so the sidebar toggle renders
#  gracefully instead of exposing an HTTP error.
# ==================================================================
class CropGeoJSONAPIView(_CropsBaseView):
    POLY_URL = "https://na.data.gov.pk/Scripts/polygons"

    # Which polygon file to fetch per level.  Divisions.json /
    # Districts.json share the same {code, name, boundary} shape.
    LEVEL_FILE = {
        "11": "Provinces.json",
        "12": "Divisions.json",
        "13": "Districts.json",
    }

    def get(self, request):
        crop  = request.GET.get("crop",  "4")
        year  = request.GET.get("year",  "2021-22")
        level = request.GET.get("level", "11")

        cache_key = f"crops_geojson|{crop}|{year}|{level}"
        cached = cache.get(cache_key)
        if cached is not None:
            return JsonResponse(cached)

        # 1. Polygons — 1 cheap request; the geometry file is static
        #    across crop/year selections so we cache it independently
        #    with a longer TTL.  Uses a nested `_fetch_raw` because the
        #    upstream serves a plain JSON array (not { data: [] }).
        poly_file = self.LEVEL_FILE.get(level, "Provinces.json")
        poly_cache_key = f"crops_poly|{level}"
        polygons = cache.get(poly_cache_key)
        if polygons is None:
            try:
                r = requests.get(
                    f"{self.POLY_URL}/{poly_file}",
                    timeout=self.TIMEOUT,
                    headers={"User-Agent": "NCOP/1.0", "Accept": "application/json"},
                )
                r.raise_for_status()
                polygons = r.json()
                # 7-day cache — the polygon file changes almost never.
                cache.set(poly_cache_key, polygons, 7 * 24 * 3600)
            except Exception as e:
                print(f"[crops geojson] polygon fetch failed ({poly_file}): {e}")
                return JsonResponse({
                    "type": "FeatureCollection", "features": [],
                    "meta": {"error": f"polygon fetch failed: {e}"},
                }, status=200)

        # 2. Crop values — reuse the same cached path GetMap already
        #    goes through in CropMapAPIView (identical params).
        map_payload = self._fetch(
            "/GetMap", method="POST",
            data={"level": level, "year": year, "crop": crop},
            cache_key_extra=f"{level}|{year}|{crop}",
        )
        rows = (map_payload or {}).get("data") or []
        # Build TWO lookups so we can match districts (whose codes on
        # the polygon feed are ints and on the map feed are zero-padded
        # strings — e.g. polygon.code=5 vs map.id="005") AND provinces
        # (which line up cleanly on int id).  Name-normalized lookup
        # is a belt-and-braces fallback for edge cases.
        def _to_int(v):
            try:
                return int(str(v).strip().lstrip("0") or "0")
            except Exception:
                return None
        def _norm_name(n):
            n = str(n or "").upper().strip()
            # Drop the trailing " DISTRICT" / " DIVISION" suffix if
            # present, then squeeze to alphanumerics for tolerant match.
            for suffix in (" DISTRICT", " DIVISION"):
                if n.endswith(suffix):
                    n = n[: -len(suffix)]
            return "".join(c for c in n if c.isalnum())

        by_int_id  = {}
        by_name    = {}
        for r in rows:
            rid = _to_int(r.get("id"))
            entry = {
                "production": float(r.get("production") or 0),
                "area":       float(r.get("area")       or 0),
                "yield":      float(r.get("yield")      or 0),
                "name":       str(r.get("name") or "").strip(),
            }
            if rid is not None:
                by_int_id[rid] = entry
            nm = _norm_name(r.get("name"))
            if nm:
                by_name.setdefault(nm, entry)

        # 3. Assemble the FeatureCollection.  Every polygon becomes a
        #    feature — polygons without matching crop data get zero
        #    values but stay in the file so the region still renders
        #    (as a light-grey "no data" cell in the choropleth ramp).
        features = []
        for p in polygons or []:
            code_raw = p.get("code")
            geom = p.get("boundary")
            if not geom or code_raw is None:
                continue
            code_int = _to_int(code_raw)
            values = None
            if code_int is not None and code_int in by_int_id:
                values = by_int_id[code_int]
            else:
                nm = _norm_name(p.get("name"))
                if nm and nm in by_name:
                    values = by_name[nm]
            has_data = values is not None
            if not has_data:
                values = {"production": 0, "area": 0, "yield": 0,
                          "name": (p.get("name") or "").strip()}
            features.append({
                "type": "Feature",
                "geometry": geom,
                "properties": {
                    "code":       str(code_raw),
                    "name":       values["name"] or (p.get("name") or "").strip(),
                    "production": values["production"],
                    "area":       values["area"],
                    "yield":      values["yield"],
                    "crop_id":    int(crop) if str(crop).isdigit() else crop,
                    "year":       year,
                    "level":      int(level) if str(level).isdigit() else level,
                    "has_data":   has_data,
                },
            })

        # Compute min/max production for client-side ramp fallback.
        prods = [f["properties"]["production"] for f in features if f["properties"]["has_data"]]
        result = {
            "type": "FeatureCollection",
            "features": features,
            "meta": {
                "crop":  crop, "year":  year, "level": level,
                "polygon_count": len(polygons or []),
                "data_count":    len(rows),
                "matched":       len([f for f in features if f["properties"]["has_data"]]),
                "min_production": min(prods) if prods else 0,
                "max_production": max(prods) if prods else 0,
            },
        }
        cache.set(cache_key, result, self.CACHE_TTL)
        return JsonResponse(result)


# ==================================================================
#  PMD Monitor — authenticated proxy for WRFPRS precipitation
#  forecast GeoTIFFs → colorized PNGs for the temporal-slider system
#  ----------------------------------------------------------------
#  Fetches raw single-band precipitation-accumulation GeoTIFFs from
#  the PMD Monitor portal (Chinese-vendor NWP system at a private IP),
#  reprojects them to EPSG:3857, and colorizes them server-side via
#  GDAL's color-relief mode using the vendor's own mm→RGB legend
#  stops.  Frontend (map-layers.js + time-functions.js) consumes the
#  returned per-step {url, coordinates} list as Mapbox `image`
#  sources — one texture per forecast hour, opacity-scrubbed by the
#  standard #temp-slider1 controller.
#
#  Auth: the vendor issues both a bearer JWT (in the login response's
#  `token` field, valid ~30 days server-side) and an `ews_jwt` cookie
#  gating page routes.  Only the bearer is needed for /api/* JSON
#  and the /static/*.tif file range we scrape; the cookie is captured
#  incidentally by the session jar and comes along for the ride.
#
#  Two caching layers, deliberately different TTLs:
#    * model-run lookup (30 min) — cheap to refresh, want to notice new cycles
#    * frame list per run (3 h)  — file list for a given run doesn't change
#    * converted PNGs (unbounded, on-disk under MEDIA_ROOT/pmd_predictions/)
#      — a given (element, run, forecast-hour) render never changes
# ==================================================================
_MON_BASE    = getattr(settings, "PMD_MONITOR_URL",  "https://115.186.56.181:12304").rstrip("/")
_MON_USER    = getattr(settings, "PMD_MONITOR_USER", "")
_MON_PASS    = getattr(settings, "PMD_MONITOR_PASS", "")
_MON_TIMEOUT = 15
_MON_HDRS = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":          "application/json, text/html, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         _MON_BASE + "/",
}


class _MonSSLAdapter(requests.adapters.HTTPAdapter):
    """Legacy-TLS + no-cert adapter — the vendor host uses a self-signed
    cert and a cipher/TLS-version policy that Python 3.10+ rejects by
    default.  Confirmed live during discovery: plain `verify=False` alone
    was not sufficient; we need SECLEVEL=0 and minimum_version=TLSv1."""
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try: ctx.set_ciphers("DEFAULT:@SECLEVEL=0")
        except Exception: pass
        try: ctx.minimum_version = ssl.TLSVersion.TLSv1
        except Exception: pass
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


def _mon_make_bare_session():
    s = requests.Session()
    s.mount("https://", _MonSSLAdapter())
    s.headers.update(_MON_HDRS)
    return s


def _mon_extract_jwt(resp_json):
    """Robust to slight upstream shape drift — walks the common token-
    field names at both the top level and under `data`."""
    if not isinstance(resp_json, dict):
        return None
    for key in ("token", "access_token", "jwt", "jwtToken", "accessToken", "id_token"):
        val = resp_json.get(key)
        if val and isinstance(val, str) and len(val) > 20:
            return val
    data = resp_json.get("data")
    if isinstance(data, dict):
        for key in ("token", "access_token", "jwt"):
            val = data.get(key)
            if val and isinstance(val, str) and len(val) > 20:
                return val
    return None


def _mon_do_login(sess):
    """POST creds, extract bearer JWT, attach to session default headers."""
    if not (_MON_USER and _MON_PASS):
        print("[pmd_monitor] credentials missing — set PMD_MONITOR_USER/PASS")
        return False
    creds = {"username": _MON_USER, "password": _MON_PASS}
    for ep in ("/user/login", "/user/login/", "/api/user/login"):
        try:
            r = sess.post(f"{_MON_BASE}{ep}", json=creds, timeout=_MON_TIMEOUT,
                          verify=False, allow_redirects=False)
            if r.status_code not in (200, 201):
                continue
            body = r.json()
            tok = _mon_extract_jwt(body)
            if tok:
                sess.headers["Authorization"] = f"Bearer {tok}"
                return True
            if body.get("success") in (True, "true") or body.get("code") in (0, "0", 200):
                # Login succeeded but no bearer in body — cookies alone may
                # be enough for some endpoints.  Kept for shape-drift safety.
                return True
        except Exception as e:
            print(f"[pmd_monitor] login attempt {ep!r} failed: {e}")
            continue
    return False


_mon_session         = None
_mon_session_expiry  = 0.0
_mon_session_lock    = threading.Lock()
_MON_SESSION_TTL     = 3600  # 1 hour — refresh proactively, force-refresh on 401/403


def _mon_sess():
    """Return a logged-in requests.Session, one per Django worker process.
    Rebuilds on TTL expiry or after a forced invalidation."""
    global _mon_session, _mon_session_expiry
    now = time.monotonic()
    if _mon_session is not None and now < _mon_session_expiry:
        return _mon_session
    with _mon_session_lock:
        if _mon_session is not None and now < _mon_session_expiry:
            return _mon_session
        sess = _mon_make_bare_session()
        _mon_do_login(sess)
        _mon_session = sess
        _mon_session_expiry = now + _MON_SESSION_TTL
    return _mon_session


def _mon_invalidate_session():
    global _mon_session, _mon_session_expiry
    with _mon_session_lock:
        _mon_session = None
        _mon_session_expiry = 0.0


def _mon_get(path, params=None, timeout=_MON_TIMEOUT):
    """Authenticated GET → parsed JSON.  Retries once after re-login on 401/403."""
    for attempt in range(2):
        r = _mon_sess().get(f"{_MON_BASE}/{path.lstrip('/')}", params=params,
                            timeout=timeout, verify=False)
        if r.status_code in (401, 403) and attempt == 0:
            _mon_invalidate_session()
            continue
        r.raise_for_status()
        return r.json()
    raise requests.HTTPError(f"Auth failed for GET {path}")


def _mon_get_bytes(path, params=None, timeout=_MON_TIMEOUT):
    """Same as _mon_get but returns raw bytes — for the .tif files, which
    _mon_get would text/JSON-parse and thereby corrupt."""
    for attempt in range(2):
        r = _mon_sess().get(f"{_MON_BASE}/{path.lstrip('/')}", params=params,
                            timeout=timeout, verify=False)
        if r.status_code in (401, 403) and attempt == 0:
            _mon_invalidate_session()
            continue
        r.raise_for_status()
        return r.content
    raise requests.HTTPError(f"Auth failed for GET {path} (bytes)")


# ---- Element registry ---------------------------------------------------
# Each entry: element_key → { data_type, element, label, unit, stops }.
# `data_type` and `element` are the vendor's own internal codes (discovered
# by dumping the SPA's shipped JS chunks).  `stops` is [(value, (r,g,b))]
# — a FIXED per-physical-quantity ramp (mm / °C / %), NOT auto-stretched,
# so identical values render as identical colors across every frame.  The
# ramp writer treats `stops[0][0] > 0` as "additive quantity" (precip,
# snowfall) and emits an extra `0 → transparent` line so the no-signal
# background stays clear of the map; for state quantities that can be 0
# (cloud cover, humidity, temp) stops start at 0 or below and that
# synthetic transparent line is skipped.  Precipitation stops verified
# against the vendor legendList; temperature/humidity/cloud stops are
# standard-meteorology defaults chosen where the vendor exposed no per-
# element legend (nothing legend-shaped was findable in the SPA chunks).
_MON_PRED_ELEMENTS = {
    # ---- Precipitation (accumulation windows) --------------------------
    "hourtpe":   {"data_type": "WRFPRS", "element": "HOURTPE",   "label": "3h Precipitation",  "unit": "mm",
                  "stops": [(0.1, (185, 244, 171)), (2.5, (111, 218, 111)), (5, (56, 188, 57)),
                            (10, (37, 144, 38)),    (25, (98, 184, 255)),  (50, (0, 0, 252)),
                            (100, (250, 0, 250))]},
    "sixtpe":    {"data_type": "WRFPRS", "element": "SIXTPE",    "label": "6h Precipitation",  "unit": "mm",
                  "stops": [(0.01, (166, 242, 143)), (2.5, (111, 218, 111)), (5, (56, 188, 57)),
                            (10, (37, 144, 38)),     (25, (98, 184, 255)),   (50, (0, 0, 252)),
                            (100, (250, 0, 250))]},
    "twelvetpe": {"data_type": "WRFPRS", "element": "TWELVETPE", "label": "12h Precipitation", "unit": "mm",
                  "stops": [(0.1, (166, 242, 143)), (5, (61, 186, 61)),  (15, (97, 184, 255)),
                            (30, (0, 0, 255)),       (70, (250, 0, 250)), (140, (128, 0, 64))]},
    "daytpe":    {"data_type": "WRFPRS", "element": "DAYTPE",    "label": "24h Precipitation", "unit": "mm",
                  "stops": [(0.1, (166, 242, 143)), (10, (61, 186, 61)),  (25, (97, 184, 255)),
                            (50, (0, 0, 255)),       (100, (250, 0, 250)), (250, (128, 0, 64))]},

    # ---- Temperature / humidity / cloud (state quantities) -------------
    # 2m Temperature — WRFPRS is the Pakistan-tuned model, first choice
    # over GDFS.  Ramp: purple → blue → cyan → green → yellow → red across
    # -30..+45 °C, freezing at cyan (0 °C).
    "temp2m":       {"data_type": "WRFPRS", "element": "TEM",  "label": "2m Temperature",   "unit": "°C",
                     "stops": [(-30, (128, 0, 128)), (-15, (0, 0, 255)),   (0, (0, 255, 255)),
                               (10,  (0, 255, 0)),    (20,  (255, 255, 0)), (30, (255, 128, 0)),
                               (40,  (255, 0, 0)),    (45,  (128, 0, 0))]},

    # Total Cloud Cover — WRFPRS/TCC currently publishes 0 frames upstream
    # (all recent runs empty); GDFS/TCC has 80 frames and is the working
    # cloud-cover feed.  Ramp: light grey → dark grey; user can adjust
    # opacity via the slider's blend control for a see-through view.
    # bbox: GDFS is a GLOBAL grid — without clipping the resulting Mapbox
    # texture is 2847×2846 (~32 MB per frame × 48 frames = 1.5 GB of GPU
    # texture per layer, unusable in a browser).  Clipping to a generous
    # South-Asia box (55E-80E, 20N-40N) covers Pakistan + neighbours and
    # brings the texture down to <1 MB per frame.
    "cloud_cover":  {"data_type": "GDFS",   "element": "TCC",  "label": "Total Cloud Cover", "unit": "%",
                     "bbox": (55, 20, 80, 40),
                     "stops": [(0, (220, 220, 220)), (25, (180, 180, 180)), (50, (140, 140, 140)),
                               (75, (100, 100, 100)), (100, (60, 60, 60))]},

    # Relative Humidity — GDFS/RHU (WRFPRS publishes SHU/specific humidity
    # instead, less operator-friendly).  Brown (dry) → tan → cream → blue
    # → deep blue (saturated) — standard met visualisation.  Same bbox
    # clipping rationale as cloud_cover — global GDFS grid.
    "rel_humidity": {"data_type": "GDFS",   "element": "RHU",  "label": "Relative Humidity", "unit": "%",
                     "bbox": (55, 20, 80, 40),
                     "stops": [(0, (140, 100, 60)), (20, (200, 170, 120)), (40, (240, 220, 180)),
                               (60, (200, 230, 250)), (80, (100, 150, 220)), (100, (0, 50, 180))]},

    # ---- 24-hour Extreme aggregates (from PMD Monitor's /warning page) --
    # These are daily-max / daily-min / daily-max-wind fields; scientific
    # equivalents of the operator-facing "24 hour Extreme *" toggles in the
    # vendor's warning panel.  All three are global grids upstream so they
    # inherit the same 55E-80E, 20N-40N bbox clip used by cloud_cover /
    # rel_humidity above — dropping a global 4-8 MB TIFF to a Pakistan-
    # region tile keeps GPU-texture memory sane.
    # Data-type picks: TMAX2M / TMIN2M live in GDFS (80 frames — WRFPRS
    # does not publish these); VMAX10M lives in ICON (42 frames — no other
    # published model exposes it).
    "ext_high_temp": {"data_type": "GDFS", "element": "TMAX2M",  "label": "24h Extreme High Temperature", "unit": "°C",
                      "bbox": (55, 20, 80, 40),
                      # Extended range for heat extremes over Pakistan
                      # summer (up to 55 °C observed in Sindh).
                      "stops": [(0,   (0, 0, 255)),    (15, (0, 200, 255)),  (25, (0, 200, 100)),
                                (35, (200, 220, 0)),  (40, (255, 165, 0)),  (45, (255, 0, 0)),
                                (50, (180, 0, 60)),   (55, (100, 0, 0))]},

    "ext_low_temp":  {"data_type": "GDFS", "element": "TMIN2M",  "label": "24h Extreme Low Temperature",  "unit": "°C",
                      "bbox": (55, 20, 80, 40),
                      # Winter extremes over the northern belt reach -30 °C.
                      "stops": [(-40, (80, 0, 128)),   (-20, (0, 0, 200)),    (-10, (0, 130, 255)),
                                (0,   (0, 200, 255)),  (10,  (0, 200, 100)),  (20,  (200, 220, 0)),
                                (30,  (255, 165, 0)),  (40,  (255, 0, 0))]},

    # NOT INTEGRATED: 24h Extreme Wind (VMAX10M).  Only ICON publishes it
    # and the source rasters are 561×1 (a 1-D vector disguised as a
    # raster), which segfaults gdal.Warp under the thread-pool.  Do NOT
    # add this element back without switching to a different upstream —
    # WRFPRS / GDFS / GRAPES / ECMWF do not publish this field.
}


_PRED_MEDIA_SUBDIR = "pmd_predictions"
_PRED_RAMP_SUBDIR  = os.path.join(_PRED_MEDIA_SUBDIR, "_ramps")

# GDAL / PROJ are NOT thread-safe for concurrent gdal.Warp calls that share
# a PROJ context (documented gotcha; the default proj_context is per-process).
# The endpoint runs a ThreadPoolExecutor(5) over convert steps so the auth
# fetches overlap, but concurrent Warp calls silently produced empty rasters
# on Linux prod (all-NoData output, 2894-byte "empty" PNGs after color-relief).
# Fix: serialise only the GDAL calls (Warp + DEMProcessing) with this lock;
# the network fetch stays parallel because that's where the real time is.
_MON_PRED_GDAL_LOCK = threading.Lock()

# Enable GDAL Python exceptions ONCE at module load (idempotent).  Doing this
# per-call was racy under the thread pool — one thread could flip the mode
# mid-warp on another.  Silences GDAL 4.0's FutureWarning too.
try:
    from osgeo import gdal as _gdal_bootstrap
    _gdal_bootstrap.UseExceptions()
    del _gdal_bootstrap
except Exception:
    pass


def _mon_pred_ramp_file(element_key):
    """Build (once) a GDAL color-relief text ramp for this element_key.
    Keyed by element_key (not the vendor's ELEMENT code) so two entries
    that share a vendor code across different data_types can never collide
    on disk.  The synthetic `0 → transparent` line is only emitted for
    additive quantities (precipitation, snow — stops start > 0); for state
    quantities that can legitimately be 0 (cloud cover, humidity) or
    negative (temperature) it's skipped so the ramp's own first stop
    controls the low-end colour."""
    cfg = _MON_PRED_ELEMENTS[element_key]
    stops = cfg["stops"]
    ramp_dir = os.path.join(settings.MEDIA_ROOT, _PRED_RAMP_SUBDIR)
    os.makedirs(ramp_dir, exist_ok=True)
    path = os.path.join(ramp_dir, f"{element_key}.txt")
    if os.path.exists(path):
        return path
    lines = ["nv 0 0 0 0"]                              # nodata → transparent
    if stops[0][0] > 0:                                 # additive quantity
        r, g, b = stops[0][1]
        lines.append(f"0 {r} {g} {b} 0")                # 0 mm → transparent
    for value, (r, g, b) in stops:
        lines.append(f"{value} {r} {g} {b} 255")
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


_PRED_DENSE_HOURS       = 48   # keep every hour through this point
_PRED_SPARSE_STEP_HOURS = 6    # then thin to every N hours


def _mon_pred_select_steps(ds_list):
    """Thin the 76-hour frame list — Mapbox image sources are live GPU
    textures, so registering every one for every layer would balloon
    memory quickly.  Keep hourly for the first 48 h (the tactically
    useful window), then 6-hourly for the long tail."""
    def _p(s):
        try: return datetime.fromisoformat(s)
        except Exception: return None
    if not ds_list:
        return []
    run_dt = _p((ds_list[0] or {}).get("data_time") or "")
    kept = []
    for item in ds_list:
        fc = _p((item or {}).get("forecast_time") or "")
        if not run_dt or not fc:
            kept.append(item); continue
        hours_out = (fc - run_dt).total_seconds() / 3600.0
        if hours_out <= _PRED_DENSE_HOURS or int(round(hours_out)) % _PRED_SPARSE_STEP_HOURS == 0:
            kept.append(item)
    return kept


def _mon_pred_convert_step(element_key, item):
    """Fetch one raw .tif, warp to EPSG:3857, colorize via GDAL DEM
    processing, cache result to disk.  Returns the frontend-ready
    {date, url, coordinates, bounds} dict or None on failure — one bad
    step shouldn't take down the whole layer.

    Media-key convention: `{element_key}_{run}_{fh}.png` (+ `.json`
    metadata sidecar) so repeat requests hit the disk-cache branch
    instantly.  Keying by element_key (not vendor's ELEMENT code) means
    e.g. WRFPRS/TEM and a hypothetical GDFS/TEM entry live on disk as
    distinct files rather than clobbering each other."""
    from osgeo import gdal
    import re, math, json

    # gdal.UseExceptions() is set once at module-load (see top of this
    # section) so we don't race with parallel workers flipping the mode.

    # Suppress GDAL's persistent auxiliary metadata (.png.aux.xml) sidecar.
    # It's harmless and Mapbox never requests it, but writing it doubles
    # the per-step disk-IO cost.
    gdal.SetConfigOption("GDAL_PAM_ENABLED", "NO")

    # ---- Rich-error scaffolding ---------------------------------------
    # `_diag` accumulates per-step observations that get printed together
    # if anything fails; keeps journalctl focused (one multi-line entry
    # per failure) instead of scattered prints per convert stage.  On
    # success `_diag` is discarded silently.
    _diag = [f"convert {element_key}/{item.get('data_time','?')}/{item.get('forecast_time','?')}"]
    def _log_fail(msg):
        print("[pmd_monitor] " + " | ".join(_diag + [msg]))

    run = (item.get("data_time")     or "").replace("-", "").replace(":", "").replace("T", "")
    fh  = (item.get("forecast_time") or "").replace("-", "").replace(":", "").replace("T", "")
    safe = re.sub(r"[^A-Za-z0-9_]+", "_", f"{element_key}_{run}_{fh}")
    out_dir  = os.path.join(settings.MEDIA_ROOT, _PRED_MEDIA_SUBDIR)
    png_path  = os.path.join(out_dir, f"{safe}.png")
    meta_path = os.path.join(out_dir, f"{safe}.json")

    # Disk-cache short-circuit — return the memoised JSON if the PNG is
    # present + non-truncated.  Fresh writes are validated by variance +
    # size below, so a paired (PNG, JSON) on disk was already known-good
    # at write time; only guard here against 0-byte / truncated files
    # from a system crash mid-write.  Threshold matches the write path.
    if os.path.exists(png_path) and os.path.exists(meta_path) \
       and os.path.getsize(png_path) >= 512:
        try:
            with open(meta_path) as f:
                return json.load(f)
        except Exception:
            pass  # corrupt sidecar — fall through and re-render

    os.makedirs(out_dir, exist_ok=True)
    src_path    = os.path.join(out_dir, f"{safe}_src.tif")
    warped_path = os.path.join(out_dir, f"{safe}_3857.tif")
    try:
        tif_bytes = _mon_get_bytes(item["file_path"])
        _diag.append(f"fetched {len(tif_bytes)}B")
        # Verify fetched bytes are actually a TIFF and not an HTML error
        # page / gzipped surprise.  TIFF magic: II*\x00 (little-endian) or
        # MM\x00* (big-endian).  BigTIFF: II\x2b\x00 or MM\x00\x2b.
        _magic = tif_bytes[:4]
        _looks_tif = _magic in (b"II*\x00", b"MM\x00*", b"II\x2b\x00", b"MM\x00\x2b")
        if not _looks_tif:
            _preview = tif_bytes[:80].decode("latin1", errors="replace")
            raise ValueError(f"fetched bytes not a TIFF (magic={_magic!r}, preview={_preview!r})")
        with open(src_path, "wb") as f:
            f.write(tif_bytes)

        src_ds = gdal.Open(src_path)
        if src_ds is None:
            raise ValueError("could not open fetched GeoTIFF")
        _diag.append(
            f"src {src_ds.RasterXSize}x{src_ds.RasterYSize} b={src_ds.RasterCount} "
            f"gt={src_ds.GetGeoTransform()} proj={(src_ds.GetProjection() or '')[:60]!r}"
        )
        # Defensive shape check — some vendor feeds ship 1-D vector data
        # dressed up as a 1-pixel-tall raster (observed: ICON/VMAX10M is
        # 561×1).  gdal.Warp under the ThreadPoolExecutor can segfault
        # trying to reproject such degenerate rasters — a C-level crash
        # Python can't catch, which brings down the whole waitress
        # process.  Reject anything with fewer than 4 rows or 4 columns
        # of source data; a real 2D forecast raster is never that flat.
        if src_ds.RasterXSize < 4 or src_ds.RasterYSize < 4:
            raise ValueError(
                f"source raster too flat ({src_ds.RasterXSize}x{src_ds.RasterYSize}) "
                f"— likely 1-D vector data, skipping to avoid GDAL crash"
            )
        try:
            _srcband = src_ds.GetRasterBand(1)
            _s_mn, _s_mx, _, _ = _srcband.GetStatistics(False, True)
            _diag.append(f"src_b1 min={_s_mn} max={_s_mx} nodata={_srcband.GetNoDataValue()}")
        except Exception as _e:
            _diag.append(f"src_b1 stats-fail={_e}")

        # Optional per-element clip (lat/lon bbox from the registry).  For
        # global-grid feeds like GDFS this collapses the output texture
        # from ~2847×2846 (global mercator) to ~800×640 (Pakistan region),
        # ~50× smaller PNG and dramatically less GPU memory in the browser.
        # WRFPRS layers omit `bbox` because they're already Pakistan-native.
        _bbox = _MON_PRED_ELEMENTS.get(element_key, {}).get("bbox")
        _warp_kwargs = dict(
            dstSRS="EPSG:3857", format="GTiff", resampleAlg="bilinear",
        )
        if _bbox:
            # outputBounds passed in the src CRS (EPSG:4326 lat/lon here)
            # via `outputBoundsSRS`; GDAL reprojects both bounds and pixels
            # into dstSRS in a single pass.
            _warp_kwargs["outputBounds"]    = _bbox
            _warp_kwargs["outputBoundsSRS"] = "EPSG:4326"
        # GDAL / PROJ thread-safety: serialise the Warp call.  This is the
        # actual root cause of the "prod PNGs are all 2894-byte empty" bug
        # observed on Linux prod but not on Windows dev/staging — under a
        # ThreadPoolExecutor concurrent Warps silently corrupt the output
        # because they compete for the same proj_context.  The lock scope
        # is intentionally as tight as possible so the auth fetch above
        # (which is I/O-bound) keeps running in parallel across workers.
        try:
            with _MON_PRED_GDAL_LOCK:
                warped_ds = gdal.Warp(warped_path, src_ds, options=gdal.WarpOptions(**_warp_kwargs))
        except Exception as _we:
            raise ValueError(f"gdal.Warp raised: {_we}")
        src_ds = None
        if warped_ds is None:
            raise ValueError("reprojection failed (Warp returned None)")
        _diag.append(f"warped {warped_ds.RasterXSize}x{warped_ds.RasterYSize} b={warped_ds.RasterCount}")
        try:
            _wband = warped_ds.GetRasterBand(1)
            _w_mn, _w_mx, _, _ = _wband.GetStatistics(False, True)
            _diag.append(f"warped_b1 min={_w_mn} max={_w_mx} nodata={_wband.GetNoDataValue()}")
        except Exception as _e:
            _diag.append(f"warped_b1 stats-fail={_e}")

        # Corner-based WGS84 bounds — 4-corner math handles any rotation
        # the warp introduces; 2-corner min/max shortcut would miss it.
        gt = warped_ds.GetGeoTransform()
        w, h = warped_ds.RasterXSize, warped_ds.RasterYSize
        _MERC_MAX = 20037508.3427892
        cx = [gt[0], gt[0]+gt[1]*w, gt[0]+gt[2]*h, gt[0]+gt[1]*w+gt[2]*h]
        cy = [gt[3], gt[3]+gt[4]*w, gt[3]+gt[5]*h, gt[3]+gt[4]*w+gt[5]*h]
        minx_m, maxx_m = max(min(cx), -_MERC_MAX), min(max(cx), _MERC_MAX)
        miny_m, maxy_m = max(min(cy), -_MERC_MAX), min(max(cy), _MERC_MAX)

        def _lon(x): return (x / _MERC_MAX) * 180.0
        def _lat(y): return math.degrees(2.0*math.atan(math.exp(y / 6378137.0)) - math.pi/2.0)
        minx, maxx = round(_lon(minx_m), 6), round(_lon(maxx_m), 6)
        miny, maxy = round(_lat(miny_m), 6), round(_lat(maxy_m), 6)

        ramp = _mon_pred_ramp_file(element_key)
        # Same thread-safety concern as gdal.Warp above — DEMProcessing
        # touches the shared PROJ/GDAL state too.  Serialise for safety.
        with _MON_PRED_GDAL_LOCK:
            colored_ds = gdal.DEMProcessing(
                png_path, warped_path, "color-relief",
                colorFilename=ramp, format="PNG", addAlpha=True,
            )
        warped_ds = None
        if colored_ds is None:
            raise ValueError("color-relief render failed")
        colored_ds = None

        # Post-write PNG validation.  GDAL can produce an entirely-empty
        # colorized PNG when the upstream warp silently landed on NoData
        # pixels (has happened on Linux prod when PROJ_LIB was misconfigured
        # — Warp returned a Dataset object rather than None, so the earlier
        # "reprojection failed" check let it through; DEMProcessing then
        # wrote a technically-valid, 100%-transparent PNG that Nginx serves
        # with HTTP 200 and Mapbox loads without a console error).
        #
        # Two-stage guard:
        #   1. size floor — filters truly-broken (0-byte / a-few-hundred-
        #      bytes) writes only.  Some legitimate layers (e.g. ICON's
        #      coarse-grid VMAX10M clipped to Pakistan) produce a real
        #      valid ~3 KB PNG, so the primary validity signal is (2).
        #   2. content variance — opens the PNG and confirms at least one
        #      band has min != max (i.e. actual pixel diversity).  This
        #      catches every all-transparent / all-uniform "empty" PNG
        #      regardless of size (including the 2894-byte case that hit
        #      prod when PROJ_LIB was misconfigured).
        # Any failure deletes the broken file and raises — the surrounding
        # try/except returns None, the endpoint drops the step from the
        # response, and no broken URL propagates to the browser.
        if not os.path.isfile(png_path) or os.path.getsize(png_path) < 512:
            try: os.remove(png_path)
            except Exception: pass
            raise ValueError(
                f"colorized PNG missing or truncated ({element_key}/{run}/{fh}) "
                f"— check PROJ_LIB / GDAL_DATA at startup log."
            )
        try:
            _check_ds = gdal.Open(png_path)
            if _check_ds is None or _check_ds.RasterCount < 1:
                raise ValueError("cannot re-open written PNG")
            _has_variance = False
            for _bi in range(1, _check_ds.RasterCount + 1):
                try:
                    _mn, _mx, _, _ = _check_ds.GetRasterBand(_bi).GetStatistics(False, True)
                    if _mx > _mn:
                        _has_variance = True
                        break
                except Exception:
                    pass
            _check_ds = None
            if not _has_variance:
                raise ValueError("all bands uniform — warp produced empty raster")
        except Exception as _e:
            try: os.remove(png_path)
            except Exception: pass
            raise ValueError(f"colorized PNG failed validation: {_e}")

        payload = {
            "date":        item.get("forecast_time"),
            "url":         f"{settings.MEDIA_URL}{_PRED_MEDIA_SUBDIR}/{safe}.png",
            "bounds":      [minx, miny, maxx, maxy],
            # Mapbox ImageSource coord order: TL, TR, BR, BL.
            "coordinates": [[minx, maxy], [maxx, maxy], [maxx, miny], [minx, miny]],
        }
        with open(meta_path, "w") as f:
            json.dump(payload, f)
        return payload
    except Exception as e:
        _log_fail(f"FAIL: {e}")
        return None
    finally:
        for p in (src_path, warped_path):
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass


def _mon_cached(key, ttl, fetch_fn, fallback_key=None):
    """Cache-with-stale-fallback wrapper — same pattern used across NCOP
    for humanitarian upstreams so a transient PMD Monitor outage degrades
    to slightly-stale data instead of a 502."""
    hit = cache.get(key)
    if hit is not None:
        return hit
    try:
        data = fetch_fn()
        cache.set(key, data, ttl)
        if fallback_key:
            cache.set(fallback_key, data, ttl * 6)
        return data
    except Exception as exc:
        if fallback_key:
            stale = cache.get(fallback_key)
            if stale is not None:
                return stale
        raise exc


class PmdMonitorPredictionsAPIView(APIView):
    """GET /api/pmd/monitor/predictions/<element_key>/  →  {element, label,
    unit, run, steps: [{date, url, coordinates, bounds}, …]}

    The frontend loader in time-functions.js maps each step to a Mapbox
    `image` source under a `raster` layer (source-type is "image", layer-
    type stays "raster" — Mapbox's raster layer renders both raster-tile
    sources and image sources) and hands the whole array to the standard
    #temp-slider1 controller via updateTempSliderAsync."""

    def get(self, request, element_key):
        cfg = _MON_PRED_ELEMENTS.get(element_key)
        if not cfg:
            return JsonResponse(
                {"error": f"Unknown element_key {element_key!r}",
                 "valid": sorted(_MON_PRED_ELEMENTS.keys())},
                status=404,
            )

        try:
            from osgeo import gdal  # noqa — availability probe before any work
        except Exception as e:
            return JsonResponse({"error": f"GDAL is required: {e}"}, status=500)

        data_type, element = cfg["data_type"], cfg["element"]

        def _latest_run():
            resp = _mon_get("/api/modelTimeList",
                            {"data_type": data_type, "element": element})
            times = (resp or {}).get("data") or []
            if not times:
                raise ValueError("no model runs available")
            return times[0]["data_time"]

        try:
            run = _mon_cached(f"pmd_pred_run_{element_key}", 1800,
                              _latest_run, f"pmd_pred_run_{element_key}_last")
        except Exception:
            return JsonResponse({"error": "predictions unavailable"}, status=502)

        def _frames():
            resp = _mon_get("/api/model",
                            {"data_type": data_type, "element": element, "date_time": run})
            return (resp or {}).get("ds") or []

        try:
            frame_list = _mon_cached(
                f"pmd_pred_frames_{element_key}_{run}", 10800,
                _frames, f"pmd_pred_frames_{element_key}_{run}_last",
            )
        except Exception:
            return JsonResponse({"error": "predictions unavailable"}, status=502)

        # Per-step convert is I/O-heavy (one auth HTTP fetch + one GDAL
        # warp + one color-relief pass per frame).  Serial for 20-30 steps
        # cold = ~8-17s; a small ThreadPoolExecutor drops that ~3× because
        # the network wait for each .tif overlaps other threads' GDAL work.
        # Concurrency is bounded (5 workers): the auth session is shared +
        # requests.Session is thread-safe, but the vendor host is a
        # private-IP machine that we should not hammer with 30 concurrent
        # downloads.  Order is preserved by dispatching in-order and
        # collecting via the same iteration index.
        selected = _mon_pred_select_steps(frame_list)
        results  = [None] * len(selected)
        if selected:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            with ThreadPoolExecutor(max_workers=5, thread_name_prefix="pmd_pred") as pool:
                futures = {pool.submit(_mon_pred_convert_step, element_key, it): i
                           for i, it in enumerate(selected)}
                for fut in as_completed(futures):
                    idx = futures[fut]
                    try:
                        results[idx] = fut.result()
                    except Exception as e:
                        print(f"[pmd_monitor] worker {idx} raised: {e}")
        steps = [r for r in results if r]

        return JsonResponse({
            "element": element_key,
            "label":   cfg["label"],
            "unit":    cfg.get("unit", ""),
            "run":     run,
            "steps":   steps,
        })


# ==================================================================
#  PMD Provincial Daily Forecast — proxy for pmd.gov.pk
#  ----------------------------------------------------------------
#  Upstream: https://pmd.gov.pk/phpapi/daily-forecastpro.php
#  Public, no auth; but proxied here so the browser bundle never
#  contains the upstream host (matches the security posture of every
#  other integration in NCOP) AND so we can cache the response.
#
#  Response shape (upstream): a single-item list whose lone element
#  has keys `bal_eng`, `gb_eng`, `isb_eng`, `kashmir_eng`, `kpk_eng`,
#  `punjab_eng`, `sindh_eng` (HTML fragments) + `id`.  Roughly 3 KB
#  total; PMD refreshes ~twice daily.  We normalize to a friendlier
#  {provinces: [{id, code, title, text}]} shape the frontend can
#  render straight into tabs without upstream-specific renames.
#
#  Cache: 30 min primary + 3 h stale fallback (same pattern as the
#  PMD Monitor endpoints above).  If upstream is down we serve last-
#  known-good with `_stale: true` so the UI can badge it.
# ==================================================================
class PmdDailyForecastProAPIView(APIView):
    UPSTREAM   = "https://pmd.gov.pk/phpapi/daily-forecastpro.php"
    CACHE_KEY  = "pmd_daily_forecast_pro"
    STALE_KEY  = "pmd_daily_forecast_pro_stale"
    PRIMARY_TTL = 30 * 60          # 30 min
    STALE_TTL   = 6 * 60 * 60      # 6 h
    TIMEOUT     = 15

    # File-name → operator-friendly identifier + PMD province code (both
    # extracted live from the vendor SPA at CityForecastRight-*.js).
    _PROVINCES = [
        ("bal_eng",     "Balochistan", "5"),
        ("gb_eng",      "GB",          "7"),
        ("isb_eng",     "Islamabad",   "6"),
        ("kashmir_eng", "Kashmir",     "9"),
        ("kpk_eng",     "KPk",         "1"),
        ("punjab_eng",  "Punjab",      "3"),
        ("sindh_eng",   "Sindh",       "4"),
    ]

    def _normalize(self, upstream):
        row = (upstream[0] if isinstance(upstream, list) and upstream else {}) or {}
        provinces = []
        for file_name, title, code in self._PROVINCES:
            text = (row.get(file_name) or "").strip()
            provinces.append({
                "id":    title,
                "code":  code,
                "title": title,
                "text":  text,           # raw HTML fragment — frontend sanitises
                "empty": not text,
            })
        return {
            "id":           row.get("id"),
            "provinces":    provinces,
            "generated_at": int(time.time()),
            "upstream":     "pmd.gov.pk/phpapi/daily-forecastpro.php",
        }

    def get(self, request):
        # Honour cache-buster query param — the frontend passes _=<epoch>
        # so a re-toggle of the Story panel triggers a fresh proxy fetch
        # once the 30-min TTL expires.
        hit = cache.get(self.CACHE_KEY)
        if hit is not None:
            return JsonResponse(hit)
        try:
            r = requests.get(
                self.UPSTREAM,
                timeout=self.TIMEOUT,
                headers={"User-Agent": "NCOP/1.0",
                         "Accept": "application/json"},
            )
            r.raise_for_status()
            payload = self._normalize(r.json())
            cache.set(self.CACHE_KEY, payload, self.PRIMARY_TTL)
            cache.set(self.STALE_KEY, payload, self.STALE_TTL)
            return JsonResponse(payload)
        except Exception as e:
            stale = cache.get(self.STALE_KEY)
            if stale is not None:
                return JsonResponse({**stale, "_stale": True,
                                     "_error": str(e)[:200]})
            return JsonResponse(
                {"error": f"provincial forecast unavailable: {str(e)[:200]}"},
                status=502,
            )
