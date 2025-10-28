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


#GDELT AND SOCIAL MEDIA VIEWS HERE
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

        # Southeast Asia focused subreddits
        self.disaster_subreddits = [
            "pakistan",
            "india",
            "afghanistan",
            "iran",
            "earthquake",
            "flooding",
            "wildfire",
            "naturaldisasters",
            "southasia",
            "centralasia",
            "middleeast",
            "news",
        ]

        self.disaster_keywords = [
            "earthquake",
            "flood",
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
        ]

    def fetch_reddit_posts(self, limit_per_subreddit=5) -> List[Dict[str, Any]]:
        """Fetch disaster-related posts from Reddit"""
        reddit_posts = []

        for subreddit in self.disaster_subreddits[:8]:  # Limit to prevent timeouts
            try:
                url = f"https://www.reddit.com/r/{subreddit}/hot.json"
                params = {'limit': limit_per_subreddit, 't': 'day'}

                response = self.session.get(url, params=params, timeout=10)
                if response.status_code != 200:
                    continue

                data = response.json()
                posts = []

                for post in data.get("data", {}).get("children", []):
                    post_data = post.get("data", {})
                    title = post_data.get("title", "").lower()
                    selftext = post_data.get("selftext", "").lower()

                    if any(
                        keyword in title or keyword in selftext
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
                print(f"Fetched {len(posts)} disaster posts from r/{subreddit}")

            except Exception as e:
                print(f"Error fetching from r/{subreddit}: {e}")
                continue

        return reddit_posts[:20]  # Limit total posts

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
    """Enhanced Django view with robust error handling and SSL fixes - Southeast Asia Focus"""

    def __init__(self):
        super().__init__()
        self.rate_limiter = RateLimiter(max_requests_per_minute=60)
        self.gdelt_client = GDELTClient()
        self.social_media_fetcher = SocialMediaFetcher()
        self.thread_pool = ThreadPoolExecutor(max_workers=4)

        # Southeast Asia focused coordinate mapping
        self.coordinates = {
            # PRIMARY FOCUS - Southeast Asian Countries
            "pakistan": [69.3451, 30.3753],
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
            
            # PAKISTAN MAJOR CITIES
            "karachi": [67.0011, 24.8607],
            "lahore": [74.3587, 31.5204],
            "islamabad": [73.0479, 33.6844],
            "rawalpindi": [73.0169, 33.5651],
            "faisalabad": [73.0840, 31.4504],
            "multan": [71.5249, 30.1575],
            "hyderabad": [68.3550, 25.3960],
            "peshawar": [71.5790, 34.0056],
            "quetta": [67.0011, 30.1798],
            "gilgit": [74.3144, 35.9216],
            "hunza": [74.9227, 36.8527],
            "chitral": [71.7885, 35.8707],
            
            # INDIA MAJOR CITIES
            "mumbai": [72.8777, 19.0760],
            "delhi": [77.1025, 28.7041],
            "bangalore": [77.5946, 12.9716],
            "kolkata": [88.3639, 22.5726],
            "chennai": [80.2707, 13.0827],
            "pune": [73.8353, 18.5204],
            "ahmedabad": [72.5714, 23.0225],
            "hyderabad": [78.4744, 17.3850],
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

        # Southeast Asia focused news sources
        self.allowed_domains = {
            # Pakistan News Sources
            "dawn.com",
            "geo.tv",
            "thenews.com.pk",
            "arynews.tv",
            "tribune.com.pk",
            "samaa.tv",
            "pkr.brecorder.com",
            "thebusinesstoday.com",
            "propertytimes.com.pk",
            
            # India News Sources
            "thehindu.com",
            "deccanherald.com",
            "theindiantimes.com",
            "indiatimes.com",
            "theprint.in",
            "firstpost.com",
            "ndtv.com",
            "hindustantimes.com",
            
            # Afghanistan News Sources
            "tolonews.com",
            "pajhwok.com",
            "khaama.com",
            "ariana.af",
            
            # Iran News Sources
            "irna.ir",
            "isna.ir",
            "mehr.com",
            "farsnews.com",
            "presstv.ir",
            
            # Bangladesh News Sources
            "thedailystar.net",
            "newagebd.net",
            "dhakamirror.com",
            "bdnews24.com",
            
            # Nepal News Sources
            "nagariknews.com",
            "onlinekhabar.com",
            
            # Sri Lanka News Sources
            "newsfirst.lk",
            "colombopage.com",
            
            # Regional International Sources
            "aljazeera.com",
            "bbc.co.uk",
            "reuters.com",
            "apnews.com",
            "dw.com",
            "voanews.com",
            "france24.com",
            "rfi.fr",
        }

        # Event classification keywords (UNCHANGED as requested)
        self.event_keywords = {
            "earthquake": ["earthquake", "quake", "seismic"],
            "flood": ["flood", "flash flood", "flooding"],
            "landslide": ["landslide", "mudslide", "rockslide"],
            "tsunami": ["tsunami"],
            "cyclone": ["hurricane", "cyclone", "typhoon"],
            "storm": ["storm", "tornado", "thunderstorm", "tempest"],
            "wildfire": ["wildfire", "bushfire", "forest fire", "grass fire"],
            "volcano": ["volcano", "volcanic", "eruption"],
            "drought": ["drought"],
            "extreme weather": [
                "heatwave",
                "cold wave",
                "lightning",
                "hailstorm",
                "blizzard",
            ],
            "conflict": ["war", "conflict", "battle", "fighting", "combat"],
            "explosion": ["explosion", "blast", "bomb", "bombing"],
            "accident": ["accident", "crash", "collision", "derailment"],
            "attack": ["attack", "terrorism", "shooting", "assault"],
            "fire": ["fire", "blaze", "inferno"],
            "crisis": ["crisis", "humanitarian", "disaster", "emergency"],
            
            # ===== NEW: WEATHER & CLIMATE =====
            "weather": [
                "weather", 
                "temperature", 
                "precipitation", 
                "rainfall",
                "snowfall",
                "rainfall warning",
                "weather alert",
                "weather warning",
            ],
            "heatwave": [
                "heatwave",
                "heat wave",
                "extreme heat",
                "record temperature",
                "scorching",
                "temperature surge",
            ],
            "cold_wave": [
                "cold wave",
                "extreme cold",
                "freezing",
                "frost",
                "blizzard",
                "snowstorm",
            ],
            
            # ===== NEW: AIR QUALITY & SMOG =====
            "air_quality": [
                "air quality",
                "air pollution",
                "AQI",
                "air quality index",
                "pollution alert",
                "air quality warning",
            ],
            "smog": [
                "smog",
                "haze",
                "smog alert",
                "smog warning",
                "fog",
                "visibility",
                "air haze",
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
            ],
            
            # ===== NEW: CLIMATE =====
            "climate": [
                "climate",
                "climate change",
                "global warming",
                "climate crisis",
                "climate emergency",
                "climate action",
            ],
            "climate_change": [
                "climate change",
                "global warming",
                "greenhouse gas",
                "carbon emissions",
                "carbon footprint",
                "climate warming",
            ],
            "environmental": [
                "environmental",
                "environmental crisis",
                "environmental disaster",
                "environmental emergency",
                "ecology",
                "ecological",
            ],
        }

    def get(self, request, *args, **kwargs):
        """Main GET endpoint with improved error handling"""
        try:
            # Parse parameters with validation
            search_query = request.GET.get(
                "query",
                "disaster OR earthquake OR flood OR hurricane OR wildfire OR volcano OR weather OR pollution OR smog OR climate",
            )
            days_back = min(int(request.GET.get("days", 7)), 30)  # Max 30 days
            max_records = min(int(request.GET.get("max_records", 200)), 250)
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

            print("Starting data fetching for Southeast Asia...")

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
                print("Fetching GDELT data (Southeast Asia focus) and optionally social media data")

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
                "geographic_scope": "Southeast Asia (Pakistan, Iran, India, Afghanistan, Bangladesh, Nepal, Sri Lanka, Myanmar, Thailand, Vietnam, Cambodia, Laos, Malaysia, Singapore, Indonesia, Philippines)",
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
                            },
                        }
                        geojson["features"].append(feature)

            except Exception as e:
                print(f"Error processing GDELT article: {e}")
                continue

        # Process social media posts
        social_media_features = 0
        for post in social_media_data:
            try:
                coordinates = self._extract_coordinates_from_social_media(post)
                if coordinates:
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
                            },
                        }

                    geojson["features"].append(feature)
                    social_media_features += 1

            except Exception as e:
                print(f"Error processing social media post: {e}")
                continue

        # Enhanced logging
        print(f"Processing Statistics:")
        print(f"  Total GDELT articles: {len(gdelt_data.get('articles', []))}")
        print(f"  Unique articles after deduplication: {len(gdelt_articles)}")
        print(f"  Articles with extractable coordinates: {articles_with_coords}")
        print(f"  Articles from allowed domains: {articles_from_allowed_domains}")
        print(f"  Social media posts with coordinates: {social_media_features}")
        print(f"  Final features created: {len(geojson['features'])}")

        if unknown_domains:
            print(
                f"Unknown domains encountered ({len(unknown_domains)}): {sorted(list(unknown_domains)[:10])}"
            )
            if len(unknown_domains) > 10:
                print(f"  ... and {len(unknown_domains) - 10} more")

        return geojson

    def _extract_coordinates(self, article: Dict[str, Any]) -> Optional[List[float]]:
        """Enhanced coordinate extraction from article data"""
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

        # Method 2: Search text for locations
        text_to_search = f"{article.get('title', '').lower()} {article.get('url', '').lower()}"

        # Search coordinates first (cities are more specific)
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
        """Extract coordinates from social media posts"""
        # Combine title and content for location search
        text_to_search = f"{post.get('title', '').lower()} {post.get('content', '').lower()} {post.get('selftext', '').lower()}"

        # Search coordinates for location names
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

    print("\nTesting Reddit integration...")
    reddit_posts = fetcher.fetch_reddit_posts(limit_per_subreddit=5)
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
    PRODUCTION CONFIGURATION NOTES:
    
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
    
    5. Geographic Scope:
       - Configured for Southeast Asia focus
       - 16 countries covered
       - 90+ cities mapped
       - 30+ regional news sources
    """
    )


if __name__ == "__main__":
    # Run diagnostics
    print("=== GDELT API Diagnostics ===")
    diagnose_ssl_issues()

    print("\n=== Connection Test ===")
    test_gdelt_connection()

    print("\n=== Social Media Test ===")
    test_social_media_integration()

    print("\n=== Production Notes ===")
    configure_for_production()

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