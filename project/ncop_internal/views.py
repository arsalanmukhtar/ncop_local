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
from django.http import JsonResponse, Http404
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
from requests.adapters import HTTPAdapter
from functools import lru_cache
# from ncop.models import (
#     DistrictBoundary, MajorDamsLevel, LayerInfo, Incident,
#     IncidentFeatures, IncidentsMedia, NcopHazardAlert,
#     NcopHazardAlertFeatures, GlobalHazardCalendar,
# )
# from .serializers import IncidentsMediaSerializer
from ncop_project.settings.base import (
    MAPBOX_ACCESS_TOKEN,
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

User = get_user_model()


@login_required(login_url="login")
def dashboard_view(request):
    return render(request, "dashboard.html", {
        "mapbox_token": settings.MAPBOX_ACCESS_TOKEN
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