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


def _safe_get_json(url, params=None, timeout=15):
    try:
        r = requests.get(url, params=params, timeout=timeout)
        if r.ok:
            return r.json()
    except requests.RequestException as e:
        print("GDACS JSON error:", url, e)
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
    
    

#----------------------GOOGLE EARTH ENGINE VIEWS HERE------------------------------
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
# ENHANCED GEE DATA CATALOG - HAZARD-SPECIFIC WITH AHP MODELS
# ============================================================================

class GEEDataCatalog:
    """Advanced hazard management system with multi-criteria analysis"""
    
    PAKISTAN_BOUNDS = [60.872, 23.634, 77.837, 37.097]
    
    # EXPANDED PAKISTAN LOCATIONS (55+)
    LOCATIONS = {
        'pakistan': [60.872, 23.634, 77.837, 37.097],
        'punjab': [69.5, 27.5, 75.5, 34.5],
        'sindh': [66.5, 23.5, 71.0, 28.5],
        'kpk': [69.0, 31.5, 74.5, 36.5],
        'khyber_pakhtunkhwa': [69.0, 31.5, 74.5, 36.5],
        'balochistan': [60.8, 24.5, 70.5, 31.5],
        'gilgit_baltistan': [72.5, 34.5, 77.8, 37.1],
        'azad_kashmir': [73.5, 33.5, 74.5, 34.5],
        'lahore': [74.1, 31.3, 74.6, 31.7],
        'faisalabad': [73.0, 31.3, 73.2, 31.5],
        'rawalpindi': [73.0, 33.5, 73.2, 33.7],
        'multan': [71.4, 30.1, 71.6, 30.3],
        'gujranwala': [74.1, 32.1, 74.3, 32.3],
        'sialkot': [74.4, 32.4, 74.6, 32.6],
        'bahawalpur': [71.6, 29.3, 71.8, 29.5],
        'sargodha': [72.6, 32.0, 72.8, 32.2],
        'karachi': [66.9, 24.7, 67.3, 25.1],
        'hyderabad': [68.3, 25.3, 68.5, 25.5],
        'sukkur': [68.8, 27.6, 69.0, 27.8],
        'larkana': [68.1, 27.4, 68.3, 27.6],
        'peshawar': [71.4, 33.9, 71.7, 34.1],
        'mardan': [72.0, 34.1, 72.2, 34.3],
        'abbottabad': [73.1, 34.1, 73.3, 34.3],
        'swat': [72.0, 34.7, 72.8, 35.5],
        'quetta': [66.9, 30.1, 67.2, 30.3],
        'gwadar': [62.3, 25.0, 62.5, 25.2],
        'turbat': [63.0, 25.9, 63.2, 26.1],
        'gilgit': [74.3, 35.8, 74.5, 36.0],
        'skardu': [75.6, 35.2, 75.8, 35.4],
        'hunza': [74.5, 36.0, 74.9, 36.5],
        'islamabad': [72.9, 33.5, 73.2, 33.8],
        'indus_river': [67.0, 24.0, 73.0, 35.0],
        'chenab_river': [71.5, 29.5, 74.5, 33.0],
    }
    
    # ========================================================================
    # COMPREHENSIVE HAZARD-SPECIFIC DATASETS WITH PRIORITY
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
            'priority': 10,  # Highest priority for flood queries
            'keywords': ['flood extent', 'flooding', 'inundation', 'flood mapping', 'flooded area', 'water extent', 'flood detection'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Flood+Extent+(SAR)&palette=ffffff,0000ff&min=0&max=1'
        },
        'flood_occurrence': {
            'name': 'Flood Frequency (JRC)',
            'collection': 'JRC/GSW1_4/GlobalSurfaceWater',
            'compute': lambda img: img.select('occurrence').rename('Flood_Frequency'),
            'vis': {'min': 0, 'max': 100, 'palette': ['ffffff', 'ffffcc', 'c7e9b4', '7fcdbb', '41b6c4', '1d91c0', '225ea8', '0c2c84']},
            'type': 'hazard_flood',
            'priority': 9,
            'keywords': ['flood occurrence', 'flood frequency', 'historical flooding', 'flood history', 'recurring flood', 'permanent water'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Frequency+%25&palette=ffffff,7fcdbb,225ea8,0c2c84&min=0&max=100'
        },
        'flood_susceptibility_ahp': {
            'name': 'Flood Susceptibility (AHP Multi-Criteria)',
            'collection': 'COMPOSITE',  # Special marker for composite analysis
            'compute': 'ahp_flood',  # Special marker for AHP computation
            'vis': {'min': 0, 'max': 1, 'palette': ['00ff00', '7fff00', 'ffff00', 'ff7f00', 'ff0000', '8b0000']},
            'type': 'susceptibility_flood',
            'priority': 8,
            'keywords': ['flood susceptibility', 'flood risk', 'flood prone', 'flood hazard', 'floodplain', 'flood vulnerability'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Susceptibility+(AHP)&palette=00ff00,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'elevation': 0.30,      # Low elevation = higher risk
                'slope': 0.25,          # Flat areas = higher risk
                'rainfall': 0.20,       # High rainfall = higher risk
                'distance_water': 0.15, # Near water = higher risk
                'soil_moisture': 0.10   # Saturated soil = higher risk
            }
        },
        'flood_depth_proxy': {
            'name': 'Potential Flood Depth (Elevation-based)',
            'collection': 'COPERNICUS/DEM/GLO30',
            'compute': lambda img: ee.Image(50).subtract(img.select('DEM')).clamp(0, 50).rename('Flood_Depth'),
            'vis': {'min': 0, 'max': 20, 'palette': ['ffffff', 'c7e9b4', '7fcdbb', '41b6c4', '1d91c0', '225ea8', '0c2c84']},
            'type': 'susceptibility_flood',
            'priority': 7,
            'keywords': ['flood depth', 'inundation depth', 'flood level', 'water depth'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Flood+Depth+(m)&palette=ffffff,7fcdbb,225ea8,0c2c84&min=0&max=20'
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
            'keywords': ['active fire', 'fire detection', 'burning', 'flames', 'fire hotspot', 'thermal anomaly', 'wildfire'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Active+Fires+(VIIRS)&palette=ffff00,ff0000,8b0000&min=0&max=1'
        },
        'fire_radiative_power': {
            'name': 'Fire Radiative Power (MODIS)',
            'collection': 'MODIS/061/MOD14A1',
            'compute': lambda img: img.select('MaxFRP').rename('Fire_Power'),
            'vis': {'min': 0, 'max': 500, 'palette': ['000000', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'hazard_fire',
            'priority': 9,
            'keywords': ['fire intensity', 'fire power', 'fire energy', 'frp', 'fire strength'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Fire+Power+(MW)&palette=000000,ff8c00,8b0000&min=0&max=500'
        },
        'fire_susceptibility_ahp': {
            'name': 'Fire Susceptibility (AHP Multi-Criteria)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_fire',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_fire',
            'priority': 8,
            'keywords': ['fire susceptibility', 'fire risk', 'fire hazard', 'fire prone', 'wildfire risk', 'burn probability'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Fire+Susceptibility+(AHP)&palette=006400,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'vegetation_dryness': 0.35,  # NDVI-based
                'temperature': 0.25,         # LST
                'slope': 0.20,               # Terrain
                'wind_exposure': 0.15,       # Aspect
                'distance_settlement': 0.05  # Human factor
            }
        },
        'burned_area': {
            'name': 'Burned Area (MODIS)',
            'collection': 'MODIS/061/MCD64A1',
            'compute': lambda img: img.select('BurnDate').gt(0).selfMask().rename('Burned'),
            'vis': {'min': 0, 'max': 366, 'palette': ['000000', '8b4513', 'ff8c00', 'ff0000']},
            'type': 'hazard_fire',
            'priority': 7,
            'keywords': ['burned area', 'fire scar', 'post fire', 'burn extent'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Burned+Area&palette=000000,ff8c00,ff0000&min=0&max=366'
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
            'keywords': ['landslide susceptibility', 'landslide risk', 'landslip', 'mass movement', 'slope failure', 'hillside hazard'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Landslide+Susceptibility+(AHP)&palette=006400,ffff00,ff0000,8b0000&min=0&max=1',
            'ahp_weights': {
                'slope': 0.35,           # Steepness
                'aspect': 0.15,          # Sun exposure
                'elevation': 0.15,       # Altitude
                'soil_moisture': 0.20,   # Saturation
                'rainfall': 0.15         # Trigger
            }
        },
        'slope_angle': {
            'name': 'Slope Angle (Degrees)',
            'collection': 'USGS/SRTMGL1_003',
            'compute': lambda img: ee.Terrain.slope(img.select('elevation')).rename('Slope'),
            'vis': {'min': 0, 'max': 45, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'terrain',
            'priority': 6,
            'keywords': ['slope', 'steepness', 'grade', 'incline'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Slope+(degrees)&palette=006400,ffff00,ff0000&min=0&max=45'
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
            'keywords': ['wind speed', 'wind', 'cyclone', 'storm', 'tropical storm', 'gale'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Wind+Speed+(m/s)&palette=ffffff,6baed6,08519c&min=0&max=20'
        },
        'cyclone_susceptibility_ahp': {
            'name': 'Cyclone Susceptibility (Coastal AHP)',
            'collection': 'COMPOSITE',
            'compute': 'ahp_cyclone',
            'vis': {'min': 0, 'max': 1, 'palette': ['006400', '7fff00', 'ffff00', 'ff8c00', 'ff0000', '8b0000']},
            'type': 'susceptibility_cyclone',
            'priority': 9,
            'keywords': ['cyclone susceptibility', 'cyclone risk', 'storm surge', 'coastal hazard', 'tropical cyclone risk'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Cyclone+Susceptibility&palette=006400,ffff00,ff0000&min=0&max=1',
            'ahp_weights': {
                'coastal_elevation': 0.40,  # Storm surge risk
                'distance_coast': 0.30,     # Proximity to coast
                'population': 0.20,         # Exposure
                'wind_exposure': 0.10       # Topographic shelter
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
            'keywords': ['earthquake', 'seismic', 'tectonic', 'fault', 'earthquake risk', 'seismic hazard'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Seismic+Susceptibility&palette=006400,ffff00,ff0000&min=0&max=1',
            'ahp_weights': {
                'elevation': 0.30,      # Mountainous areas
                'slope': 0.30,          # Steep terrain
                'geology_proxy': 0.25,  # Terrain roughness
                'population': 0.15      # Exposure
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
            'keywords': ['drought', 'drought severity', 'dry conditions', 'water stress', 'arid', 'dryness'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Drought+Severity&palette=006400,ffff00,ff0000&min=0&max=1',
            'weights': {
                'vegetation_health': 0.40,  # NDVI
                'soil_moisture': 0.30,      # SMAP
                'precipitation_deficit': 0.30  # CHIRPS
            }
        },
        
        # ====================================================================
        # ENVIRONMENTAL INDICES (Supporting Data)
        # ====================================================================
        'ndvi': {
            'name': 'Vegetation (NDVI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B8', 'B4']).rename('NDVI'),
            'vis': {'min': 0, 'max': 0.8, 'palette': ['8b4513', 'f4a460', 'adff2f', '228b22', '006400']},
            'type': 'environmental',
            'priority': 3,
            'keywords': ['vegetation', 'ndvi', 'green cover', 'crops'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Vegetation+(NDVI)&palette=8b4513,adff2f,006400&min=0&max=0.8'
        },
        'ndsi': {
            'name': 'Snow Cover (NDSI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B3', 'B11']).rename('NDSI'),
            'vis': {'min': -0.5, 'max': 0.8, 'palette': ['0d47a1', '42a5f5', 'ffffff', 'e3f2fd']},
            'type': 'environmental',
            'priority': 8,  # High priority for snow queries
            'keywords': ['snow', 'snow cover', 'ice', 'glacier', 'ndsi', 'winter', 'avalanche'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Snow+Cover+(NDSI)&palette=0d47a1,42a5f5,ffffff,e3f2fd&min=-0.5&max=0.8'
        },
        'ndbi': {
            'name': 'Urban Areas (NDBI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B11', 'B8']).rename('NDBI'),
            'vis': {'min': -0.5, 'max': 0.5, 'palette': ['2e7d32', 'ffeb3b', 'ff6f00', 'd32f2f']},
            'type': 'environmental',
            'priority': 6,
            'keywords': ['urban', 'urban areas', 'built', 'city', 'development', 'ndbi', 'building', 'infrastructure'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Urban+Areas+(NDBI)&palette=2e7d32,ffeb3b,ff6f00,d32f2f&min=-0.5&max=0.5'
        },
        'ndwi': {
            'name': 'Water Bodies (NDWI)',
            'collection': 'COPERNICUS/S2_SR',
            'compute': lambda img: img.normalizedDifference(['B3', 'B8']).rename('NDWI'),
            'vis': {'min': -0.5, 'max': 0.5, 'palette': ['d7ccc8', '81d4fa', '039be5', '01579b']},
            'type': 'environmental',
            'priority': 5,  # Lower than flood datasets
            'keywords': ['ndwi', 'water index', 'water bodies index'],  # Removed generic "water" to avoid conflicts
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Water+Bodies+(NDWI)&palette=d7ccc8,81d4fa,039be5,01579b&min=-0.5&max=0.5'
        },
        'nightlights': {
            'name': 'Nighttime Lights',
            'collection': 'NOAA/DMSP-OLS/NIGHTTIME_LIGHTS',
            'compute': lambda img: img.select('stable_lights').rename('Nightlights'),
            'vis': {'min': 0, 'max': 63, 'palette': ['000000', '0d0887', '7e03a8', 'cc4778', 'f89540', 'f0f921']},
            'type': 'socioeconomic',
            'keywords': ['nightlights', 'lights', 'economic', 'activity', 'development', 'urbanization'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Nighttime+Lights&palette=000000,0d0887,7e03a8,cc4778,f89540,f0f921&min=0&max=63'
        },
        'air_quality': {
            'name': 'Air Quality (AOD)',
            'collection': 'MODIS/061/MCD19A2_GRANULES',
            'compute': lambda img: img.select('Optical_Depth_047').multiply(0.001).rename('AOD'),
            'vis': {'min': 0, 'max': 1, 'palette': ['00ff00', 'ffff00', 'ff7e00', 'ff0000', '8f3f97', '7e0023']},
            'type': 'environmental',
            'keywords': ['air quality', 'pollution', 'smog', 'aerosol', 'aod', 'environment'],
            'legend': '/api/gee/legend/?dataset=Air+Quality+(AOD)&palette=00ff00,ffff00,ff7e00,ff0000,8f3f97,7e0023&min=0&max=1'
        },
        'temperature': {
            'name': 'Land Surface Temperature',
            'collection': 'MODIS/061/MOD11A1',
            'compute': lambda img: img.select('LST_Day_1km').multiply(0.02).subtract(273.15).rename('Temperature'),
            'vis': {'min': 0, 'max': 50, 'palette': ['313695', '4575b4', 'abd9e9', 'ffffbf', 'fdae61', 'f46d43', 'd73027', 'a50026']},
            'type': 'environmental',
            'priority': 3,
            'keywords': ['temperature', 'heat', 'thermal', 'lst'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Temperature+(Celsius)&palette=313695,ffffbf,a50026&min=0&max=50'
        },
        'precipitation': {
            'name': 'Rainfall Data',
            'collection': 'UCSB-CHG/CHIRPS/DAILY',
            'compute': lambda img: img.select('precipitation').rename('Precipitation'),
            'vis': {'min': 0, 'max': 50, 'palette': ['ffffff', 'c6dbef', '9ecae1', '6baed6', '3182bd', '08519c']},
            'type': 'environmental',
            'priority': 3,
            'keywords': ['rainfall', 'precipitation', 'rain'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Rainfall+(mm)&palette=ffffff,6baed6,08519c&min=0&max=50'
        },
        'soil_moisture': {
            'name': 'Soil Moisture',
            'collection': 'NASA_USDA/HSL/SMAP10KM_soil_moisture',
            'compute': lambda img: img.select('ssm').rename('Soil_Moisture'),
            'vis': {'min': 0, 'max': 28, 'palette': ['d73027', 'fc8d59', 'fee08b', 'd9ef8b', '91cf60', '1a9850']},
            'type': 'environmental',
            'priority': 3,
            'keywords': ['soil moisture', 'soil water'],
            'time_filter': 'latest',
            'legend': '/api/gee/legend/?dataset=Soil+Moisture&palette=d73027,fee08b,1a9850&min=0&max=28'
        },
        'population': {
            'name': 'Population Density',
            'collection': 'WorldPop/GP/100m/pop',
            'compute': lambda img: img.select('population').rename('Population'),
            'vis': {'min': 0, 'max': 200, 'palette': ['fff5f0', 'fee0d2', 'fcbba1', 'fc9272', 'fb6a4a', 'ef3b2c', 'cb181d', '99000d']},
            'type': 'exposure',
            'priority': 2,
            'keywords': ['population', 'people', 'density'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Population+Density&palette=fff5f0,fc9272,99000d&min=0&max=200'
        },
        'elevation': {
            'name': 'Elevation (DEM)',
            'collection': 'USGS/SRTMGL1_003',
            'compute': lambda img: img.select('elevation').rename('Elevation'),
            'vis': {'min': 0, 'max': 5000, 'palette': ['006400', '228b22', 'adff2f', 'ffff00', 'ff8c00', 'ff4500', '8b4513', 'ffffff']},
            'type': 'terrain',
            'priority': 2,
            'keywords': ['elevation', 'altitude', 'dem', 'height'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Elevation+(m)&palette=006400,ffff00,ffffff&min=0&max=5000'
        },
        'multi_hazard_exposure': {
            'name': 'Multi-Hazard Exposure',
            'collection': 'WorldPop/GP/100m/pop',
            'compute': lambda img: img.select('population').gt(50).selfMask().rename('Exposure'),
            'vis': {'min': 0, 'max': 1, 'palette': ['ffeda0', 'feb24c', 'fd8d3c', 'fc4e2a', 'e31a1c', 'b10026']},
            'type': 'susceptibility',
            'keywords': ['multi hazard', 'exposure', 'vulnerability', 'risk', 'population risk', 'composite risk'],
            'time_filter': False,
            'legend': '/api/gee/legend/?dataset=Multi-Hazard+Exposure&palette=ffeda0,fd8d3c,e31a1c,b10026&min=0&max=1'
        },
    }
    
    @classmethod
    def get_dataset(cls, query):
        """Enhanced keyword matching with priority scoring"""
        query_lower = query.lower()
        
        # Score each dataset
        scores = {}
        for key, dataset in cls.DATASETS.items():
            score = 0
            priority = dataset.get('priority', 1)
            
            # Exact phrase matching (highest weight)
            for keyword in dataset['keywords']:
                if keyword in query_lower:
                    # Multi-word exact match gets bonus
                    if len(keyword.split()) > 1:
                        score += 5
                    else:
                        score += 2
            
            # Type-specific bonus
            if 'susceptibility' in query_lower and 'susceptibility' in dataset['type']:
                score += 3
            if 'hazard' in query_lower and 'hazard' in dataset['type']:
                score += 3
            
            # Apply priority multiplier
            scores[key] = score * priority
        
        if not scores:
            return None, None
        
        # Return highest scoring dataset
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
        
        # For real-time hazards, use last 7 days
        if any(word in message.lower() for word in ['active', 'current', 'latest', 'recent', 'now']):
            start = (today - timedelta(days=7)).strftime('%Y-%m-%d')
            return [start, today.strftime('%Y-%m-%d')]
        
        # Default: last 30 days for most queries
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
# AHP COMPUTATION FUNCTIONS
# ============================================================================

# ============================================================================
# AHP COMPUTATION FUNCTIONS - FULLY FIXED WITH PROPER MASKING
# ============================================================================

class AHPModels:
    """Analytical Hierarchy Process for multi-criteria susceptibility - BULLETPROOF"""
    
    @staticmethod
    def compute_flood_susceptibility(aoi):
        """Multi-criteria flood susceptibility using AHP"""
        try:
            # Criterion 1: Low elevation (30% weight)
            dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
            dem = dem_collection.select('DEM').mosaic().clip(aoi)
            
            # Normalize elevation risk (0-1 scale)
            elevation_risk = dem.lt(100).multiply(1.0) \
                .where(dem.gte(100).And(dem.lt(500)), 0.5) \
                .where(dem.gte(500), 0.1) \
                .unmask(0.1)  # Fill masked areas with low risk
            
            # Criterion 2: Flat slope (25% weight)
            slope = ee.Terrain.slope(dem)
            slope_risk = slope.lt(5).multiply(1.0) \
                .where(slope.gte(5).And(slope.lt(15)), 0.5) \
                .where(slope.gte(15), 0.1) \
                .unmask(0.1)
            
            # Criterion 3: High rainfall (20% weight)
            today = datetime.now()
            start_date = (today - timedelta(days=90)).strftime('%Y-%m-%d')  # Increased to 90 days
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
                # Fallback: use constant moderate risk
                rainfall_risk = ee.Image.constant(0.5).clip(aoi)
            
            # Criterion 4: Near water bodies (15% weight)
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
            
            # Criterion 5: High soil moisture (10% weight)
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
            
            # AHP weighted combination - properly masked
            susceptibility = elevation_risk.multiply(0.30) \
                .add(slope_risk.multiply(0.25)) \
                .add(rainfall_risk.multiply(0.20)) \
                .add(water_risk.multiply(0.15)) \
                .add(soil_risk.multiply(0.10)) \
                .clamp(0, 1)  # Ensure 0-1 range
            
            # Apply threshold mask to show only risk areas
            susceptibility = susceptibility.updateMask(susceptibility.gt(0.05))
            
            return susceptibility.rename('Flood_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Flood Error: {e}")
            # Fallback to simple elevation-based
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
            # Criterion 1: Dry vegetation (35% weight)
            try:
                s2_collection = ee.ImageCollection('COPERNICUS/S2_SR') \
                    .filterBounds(aoi) \
                    .filterDate(date_range[0], date_range[1]) \
                    .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                
                s2_count = s2_collection.size().getInfo()
                
                if s2_count > 0:
                    ndvi = s2_collection.median().normalizedDifference(['B8', 'B4']).clip(aoi)
                else:
                    # Fallback to MODIS NDVI
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
            
            # Criterion 2: High temperature (25% weight)
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
            
            # Criterion 3: Slope (20% weight)
            dem_srtm = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem_srtm).clip(aoi)
            slope_risk = slope.gte(10).And(slope.lte(30)).multiply(1.0) \
                .where(slope.lt(10), 0.3) \
                .where(slope.gt(30), 0.5) \
                .unmask(0.3)
            
            # AHP weighted combination
            susceptibility = veg_risk.multiply(0.35) \
                .add(temp_risk.multiply(0.25)) \
                .add(slope_risk.multiply(0.20)) \
                .clamp(0, 1) \
                .updateMask(veg_risk.gt(0.05))
            
            return susceptibility.rename('Fire_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Fire Error: {e}")
            # Fallback
            return ee.Image.constant(0.5).clip(aoi).rename('Fire_Risk_Fallback')
    
    @staticmethod
    def compute_landslide_susceptibility(aoi):
        """Multi-criteria landslide susceptibility - FIXED RAINFALL"""
        try:
            # Use SRTM (most reliable)
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            
            # Criterion 1: Steep slope (35% weight)
            slope = ee.Terrain.slope(dem).clip(aoi)
            slope_risk = slope.gt(25).multiply(1.0) \
                .where(slope.gte(15).And(slope.lte(25)), 0.7) \
                .where(slope.gte(10).And(slope.lt(15)), 0.4) \
                .where(slope.lt(10), 0.1) \
                .unmask(0.1)
            
            # Criterion 2: High elevation (15% weight)
            elev_risk = dem.clip(aoi).gt(1500).multiply(1.0) \
                .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(1500)), 0.7) \
                .where(dem.clip(aoi).gte(500).And(dem.clip(aoi).lt(1000)), 0.4) \
                .where(dem.clip(aoi).lt(500), 0.2) \
                .unmask(0.2)
            
            # Criterion 3: Aspect (north-facing slopes) (15% weight)
            aspect = ee.Terrain.aspect(dem).clip(aoi)
            # North-facing (315-45 degrees) are more susceptible
            aspect_risk = aspect.gte(315).Or(aspect.lte(45)).multiply(1.0) \
                .where(aspect.gt(45).And(aspect.lt(315)), 0.3) \
                .unmask(0.5)
            
            # Criterion 4: Soil moisture (20% weight) - with robust fallback
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
                    # Fallback: use elevation as proxy (higher = potentially wetter)
                    soil_risk = dem.clip(aoi).gt(2000).multiply(0.8) \
                        .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(2000)), 0.6) \
                        .where(dem.clip(aoi).lt(1000), 0.3) \
                        .unmask(0.4)
            except:
                # Use slope as proxy for moisture accumulation
                soil_risk = slope.gt(20).multiply(0.7) \
                    .where(slope.gte(10).And(slope.lte(20)), 0.5) \
                    .where(slope.lt(10), 0.3) \
                    .unmask(0.4)
            
            # Criterion 5: Rainfall trigger (15% weight) - FIXED WITH ROBUST ERROR HANDLING
            rain_start = (today - timedelta(days=90)).strftime('%Y-%m-%d')  # Extended to 90 days
            
            try:
                rainfall_collection = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY') \
                    .filterBounds(aoi) \
                    .filterDate(rain_start, soil_end)
                
                # Check if collection has data
                rain_count = rainfall_collection.size().getInfo()
                
                if rain_count > 0:
                    rainfall = rainfall_collection.sum().select('precipitation').clip(aoi)
                    rain_risk = rainfall.gt(300).multiply(1.0) \
                        .where(rainfall.gte(150).And(rainfall.lte(300)), 0.7) \
                        .where(rainfall.gte(50).And(rainfall.lt(150)), 0.4) \
                        .where(rainfall.lt(50), 0.2) \
                        .unmask(0.5)
                else:
                    # No rainfall data - use elevation as proxy (mountainous = more rain)
                    print("⚠️ No CHIRPS data - using elevation proxy for rainfall")
                    rain_risk = dem.clip(aoi).gt(2000).multiply(0.8) \
                        .where(dem.clip(aoi).gte(1000).And(dem.clip(aoi).lte(2000)), 0.6) \
                        .where(dem.clip(aoi).lt(1000), 0.3) \
                        .unmask(0.5)
            except Exception as rain_error:
                print(f"⚠️ Rainfall error: {rain_error} - using slope proxy")
                # Ultimate fallback: steep slopes accumulate water
                rain_risk = slope.gt(20).multiply(0.7) \
                    .where(slope.gte(10).And(slope.lte(20)), 0.5) \
                    .where(slope.lt(10), 0.3) \
                    .unmask(0.5)
            
            # AHP combination with proper masking
            susceptibility = slope_risk.multiply(0.35) \
                .add(elev_risk.multiply(0.15)) \
                .add(aspect_risk.multiply(0.15)) \
                .add(soil_risk.multiply(0.20)) \
                .add(rain_risk.multiply(0.15)) \
                .clamp(0, 1)
            
            # Mask low-risk areas for better visualization
            susceptibility = susceptibility.updateMask(susceptibility.gt(0.1))
            
            return susceptibility.rename('Landslide_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Landslide Error: {e}")
            # Fallback: simple slope-based
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem).clip(aoi)
            simple = slope.gt(15).multiply(1.0) \
                .where(slope.gte(10).And(slope.lte(15)), 0.6) \
                .where(slope.lt(10), 0.1) \
                .updateMask(slope.gt(5))
            return simple.rename('Landslide_Simple')
    
    @staticmethod
    def compute_cyclone_susceptibility(aoi):
        """Coastal cyclone susceptibility"""
        try:
            # Use COPERNICUS DEM properly
            dem_collection = ee.ImageCollection('COPERNICUS/DEM/GLO30')
            dem = dem_collection.select('DEM').mosaic().clip(aoi)
            
            # Criterion 1: Low coastal elevation (40% weight)
            coastal_risk = dem.lt(10).And(dem.gt(-5)).multiply(1.0) \
                .where(dem.gte(10).And(dem.lt(50)), 0.6) \
                .where(dem.gte(50).And(dem.lt(100)), 0.3) \
                .where(dem.gte(100), 0.1) \
                .unmask(0.1)
            
            # Criterion 2: Slope (flat coastal plains) (20% weight)
            slope = ee.Terrain.slope(dem)
            slope_risk = slope.lt(5).multiply(1.0) \
                .where(slope.gte(5).And(slope.lt(15)), 0.5) \
                .where(slope.gte(15), 0.1) \
                .unmask(0.3)
            
            # Criterion 3: Population exposure (20% weight)
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
            
            # Criterion 4: Distance to coast (20% weight)
            distance_risk = dem.lt(5).multiply(1.0) \
                .where(dem.gte(5).And(dem.lt(20)), 0.7) \
                .where(dem.gte(20), 0.3) \
                .unmask(0.3)
            
            # AHP combination
            susceptibility = coastal_risk.multiply(0.40) \
                .add(slope_risk.multiply(0.20)) \
                .add(pop_risk.multiply(0.20)) \
                .add(distance_risk.multiply(0.20)) \
                .clamp(0, 1) \
                .updateMask(dem.lt(200))  # Only show coastal areas
            
            return susceptibility.rename('Cyclone_Susceptibility_AHP')
            
        except Exception as e:
            print(f"❌ AHP Cyclone Error: {e}")
            # Fallback
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
        """Terrain-based seismic susceptibility"""
        try:
            dem = ee.Image('USGS/SRTMGL1_003').select('elevation')
            slope = ee.Terrain.slope(dem).clip(aoi)
            
            # Criterion 1: Mountainous terrain (40% weight)
            elev_risk = dem.clip(aoi).gt(1500).multiply(1.0) \
                .where(dem.clip(aoi).gte(500).And(dem.clip(aoi).lte(1500)), 0.6) \
                .where(dem.clip(aoi).lt(500), 0.2) \
                .unmask(0.2)
            
            # Criterion 2: Steep slopes (30% weight)
            slope_risk = slope.gt(20).multiply(1.0) \
                .where(slope.gte(10).And(slope.lte(20)), 0.6) \
                .where(slope.lt(10), 0.2) \
                .unmask(0.2)
            
            # Criterion 3: Terrain roughness (30% weight)
            roughness = slope.gt(15).multiply(1.0) \
                .where(slope.gte(5).And(slope.lte(15)), 0.5) \
                .where(slope.lt(5), 0.1) \
                .unmask(0.1)
            
            # Combination
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
        """Composite drought severity index"""
        try:
            # Component 1: NDVI (40% weight)
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
            
            # Component 2: Soil moisture (30% weight)
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
            
            # Component 3: Precipitation deficit (30% weight)
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
            
            # Composite
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
# DYNAMIC GEE LAYER VIEW - ENHANCED WITH AHP
# ============================================================================

@method_decorator(csrf_exempt, name='dispatch')
class DynamicGEELayerView(View):
    """Enhanced hazard-specific layer generator with AHP models"""
    
    def post(self, request):
        try:
            data = json.loads(request.body)
            message = data.get('message', '')
            
            if not message:
                return JsonResponse({
                    'error': 'No message provided',
                    'suggestion': 'Try: "Show flood susceptibility in Sindh"'
                }, status=400)
            
            # Get dataset with priority matching
            dataset_key, dataset_config = GEEDataCatalog.get_dataset(message)
            
            if not dataset_key:
                return JsonResponse({
                    'error': 'Dataset not recognized',
                    'response': f"❌ Couldn't find hazard data for '{message}'.\n\nTry: flood extent, fire susceptibility, landslide risk, etc."
                }, status=400)
            
            location_name, bbox = GEEDataCatalog.get_location(message)
            date_range = GEEDataCatalog.extract_dates(message)
            
            # Generate layer
            layer_data = self.generate_layer(
                dataset_key, dataset_config, bbox, date_range, location_name
            )
            
            # Response with hazard type
            hazard_emoji = {
                'hazard_flood': '🌊',
                'hazard_fire': '🔥',
                'hazard_cyclone': '🌀',
                'hazard_drought': '🌾',
                'susceptibility_flood': '⚠️ Flood Risk',
                'susceptibility_fire': '⚠️ Fire Risk',
                'susceptibility_landslide': '⚠️ Landslide Risk',
                'susceptibility_cyclone': '⚠️ Cyclone Risk',
                'susceptibility_seismic': '⚠️ Earthquake Risk',
            }
            
            emoji = hazard_emoji.get(dataset_config['type'], '📊')
            
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
                'response': f"{emoji} **{dataset_config['name']}** for **{location_name.replace('_', ' ').title()}**"
            })
            
        except Exception as e:
            return JsonResponse({
                'error': str(e),
                'response': f'❌ Error: {str(e)}'
            }, status=500)
    
    def generate_layer(self, dataset_key, dataset_config, bbox, date_range, location_name):
        """Generate layer with AHP support"""
        try:
            aoi = ee.Geometry.Rectangle(bbox)
            
            # Check for AHP/Composite computation
            compute_func = dataset_config['compute']
            
            if compute_func == 'ahp_flood':
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
                    # Static data
                    if 'Image' in dataset_config['collection'] or 'DEM' in dataset_config['collection']:
                        image = ee.Image(dataset_config['collection'])
                    else:
                        collection = ee.ImageCollection(dataset_config['collection'])
                        image = collection.filterBounds(aoi).mosaic()
                elif time_filter == 'latest':
                    # Always get latest available data
                    collection = ee.ImageCollection(dataset_config['collection'])
                    collection = collection.filterBounds(aoi).sort('system:time_start', False).limit(30)
                    
                    if 'COPERNICUS/S2' in dataset_config['collection']:
                        collection = collection.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                    
                    if 'S1_GRD' in dataset_config['collection']:
                        image = collection.min()  # SAR flood detection
                    else:
                        image = collection.median()
                else:
                    # Time-series
                    collection = ee.ImageCollection(dataset_config['collection'])
                    collection = collection.filterBounds(aoi).filterDate(date_range[0], date_range[1])
                    
                    if 'COPERNICUS/S2' in dataset_config['collection']:
                        collection = collection.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
                    
                    image = collection.median()
                
                computed_image = compute_func(image)
            
            # Clip and get tile URL
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
# CATALOG VIEW
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
                'keywords': val['keywords']
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
                'multi_criteria': True
            }
        })


# ============================================================================
# LEGEND GENERATOR
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

        # Configure retry strategy with version compatibility
        try:
            # Try new parameter name first (urllib3 >= 1.26.0)
            retry_strategy = Retry(
                total=3,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=["HEAD", "GET", "OPTIONS"],
                backoff_factor=1,
            )
        except TypeError:
            # Fallback to old parameter name (urllib3 < 1.26.0)
            retry_strategy = Retry(
                total=3,
                status_forcelist=[429, 500, 502, 503, 504],
                method_whitelist=["HEAD", "GET", "OPTIONS"],
                backoff_factor=1,
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
    ) -> Dict[str, Any]:
        """
        Fetch articles from GDELT with robust error handling and SSL bypass
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

        for attempt in range(max_retries):
            try:
                print(f"Making GDELT API request (attempt {attempt + 1}/{max_retries})")
                print(f"URL: {self.base_url}")
                print(f"Params: {params}")

                response = self.session.get(
                    self.base_url,
                    params=params,
                    timeout=30,
                    verify=False,
                    stream=False,
                )

                print(f"GDELT API Response Status: {response.status_code}")
                print(f"Response Headers: {dict(response.headers)}")

                if response.status_code == 200:
                    try:
                        data = response.json()

                        if isinstance(data, dict) and "articles" in data:
                            articles = data.get("articles", [])
                            print(f"Successfully fetched {len(articles)} articles from GDELT")
                            return data
                        else:
                            print(f"Invalid response structure: {type(data)}")
                            print(f"Response keys: {data.keys() if isinstance(data, dict) else 'Not a dict'}")

                    except json.JSONDecodeError as e:
                        print(f"JSON decode error: {e}")
                        print(f"Response content (first 500 chars): {response.text[:500]}")

                elif response.status_code == 429:
                    wait_time = min(60 * (attempt + 1), 300)
                    print(f"Rate limited, waiting {wait_time} seconds...")
                    time.sleep(wait_time)
                    continue

                elif response.status_code in [500, 502, 503, 504]:
                    print(f"Server error: {response.status_code}")
                    if attempt < max_retries - 1:
                        wait_time = 2**attempt
                        print(f"Waiting {wait_time} seconds before retry...")
                        time.sleep(wait_time)
                        continue

                else:
                    print(f"HTTP error: {response.status_code}")
                    print(f"Response content: {response.text[:200]}")

                if attempt < max_retries - 1:
                    wait_time = 2**attempt
                    print(f"Request failed, waiting {wait_time} seconds before retry...")
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

            # Test GDELT connection first
            if not include_only_social_media:
                connection_test = self.gdelt_client.test_connection()
                if not connection_test:
                    print("GDELT connection test failed, will try to proceed anyway...")

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
                        return JsonResponse(
                            {
                                "error": "GDELT API is currently unavailable due to SSL certificate issues. Please try enabling social media sources or contact support.",
                                "status": "error",
                                "technical_details": "SSL certificate verification failed",
                                "suggestion": "Add ?include_social_media=true to your request to get data from alternative sources",
                                "retry_after": "Please try again later or use social media sources",
                            },
                            status=503,
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
            }

            return JsonResponse(geojson_data)

        except ValueError as e:
            return JsonResponse(
                {"error": f"Invalid parameter: {str(e)}", "status": "error"}, status=400
            )
        except Exception as e:
            print(f"Unexpected server error: {e}")
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