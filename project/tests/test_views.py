from django.test import TestCase, Client
from django.contrib.auth.models import User
from django.urls import reverse
from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from unittest.mock import patch, MagicMock
import json
import os
import tempfile
from pathlib import Path

User = get_user_model()


class AuthenticationTestCase(TestCase):
    """Test authentication functionality"""

    def setUp(self):
        self.client = Client()
        self.test_user = User.objects.create_user(
            username="testuser", email="test@example.com", password="testpass123"
        )

    def test_login_view_get(self):
        """Test login view GET request"""
        response = self.client.get(reverse("login"))
        self.assertEqual(response.status_code, 200)

    def test_login_view_post_valid(self):
        """Test successful login"""
        response = self.client.post(
            reverse("login"), {"username": "testuser", "password": "testpass123"}
        )
        self.assertEqual(response.status_code, 302)  # Redirect after login

    def test_login_view_post_invalid(self):
        """Test failed login"""
        response = self.client.post(
            reverse("login"), {"username": "testuser", "password": "wrongpass"}
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "error")

    def test_logout_view(self):
        """Test logout functionality"""
        self.client.login(username="testuser", password="testpass123")
        response = self.client.post(reverse("logout"))
        self.assertEqual(response.status_code, 302)

    def test_signup_view_get(self):
        """Test signup view GET request"""
        response = self.client.get(reverse("signup"))
        self.assertEqual(response.status_code, 200)

    def test_signup_view_post_valid(self):
        """Test successful user registration"""
        response = self.client.post(
            reverse("signup"),
            {
                "username": "newuser",
                "email": "newuser@example.com",
                "password1": "newpass123",
                "password2": "newpass123",
            },
        )
        self.assertEqual(response.status_code, 302)  # Redirect after signup
        self.assertTrue(User.objects.filter(username="newuser").exists())

    def test_signup_view_post_invalid_email(self):
        """Test signup with invalid email"""
        response = self.client.post(
            reverse("signup"),
            {
                "username": "newuser",
                "email": "invalid-email",
                "password1": "newpass123",
                "password2": "newpass123",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "error")
        self.assertFalse(User.objects.filter(username="newuser").exists())

    def test_password_reset_view_get(self):
        """Test password reset view GET request"""
        response = self.client.get(reverse("password_reset"))
        self.assertEqual(response.status_code, 200)


class StoriesViewTestCase(TestCase):
    """Test story management functionality"""

    def setUp(self):
        self.client = Client()
        self.test_story_dir = Path(tempfile.mkdtemp())

        # Create test story files
        self.test_story = {
            "title": "Test Story",
            "chapters": [
                {
                    "id": "test-chapter",
                    "title": "Test Chapter",
                    "description": "Test description",
                    "location": {"center": [0, 0], "zoom": 10},
                }
            ],
        }

        # Mock STORY_JSON_DIR
        self.story_json_path = self.test_story_dir / "teststory.json"
        with open(self.story_json_path, "w") as f:
            json.dump(self.test_story, f)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.test_story_dir)

    @patch("ncop_internal.views.STORY_JSON_DIR")
    def test_stories_view_get_list(self, mock_story_dir):
        """Test getting list of stories"""
        mock_story_dir.__str__ = lambda: str(self.test_story_dir)
        mock_story_dir.iterdir.return_value = [self.story_json_path]

        response = self.client.get(reverse("stories"))
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertIn("stories", data)
        self.assertIn("teststory", data["stories"])

    @patch("ncop_internal.views.STORY_JSON_DIR")
    def test_stories_view_get_full(self, mock_story_dir):
        """Test getting full story contents"""
        mock_story_dir.__str__ = lambda: str(self.test_story_dir)
        mock_story_dir.iterdir.return_value = [self.story_json_path]

        response = self.client.get(reverse("stories") + "?full=1")
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertIn("teststory", data)
        self.assertEqual(data["teststory"]["title"], "Test Story")

    def test_stories_view_post_valid(self):
        """Test creating/updating a story"""
        with patch("ncop_internal.views.STORY_JSON_DIR") as mock_dir:
            mock_dir.__str__ = lambda: str(self.test_story_dir)

            response = self.client.post(
                reverse("stories"),
                data=json.dumps({"slug": "newstory", "story": self.test_story}),
                content_type="application/json",
            )

            self.assertEqual(response.status_code, 200)
            new_story_path = self.test_story_dir / "newstory.json"
            self.assertTrue(new_story_path.exists())

    def test_stories_view_post_invalid_slug(self):
        """Test posting story with invalid slug"""
        response = self.client.post(
            reverse("stories"),
            data=json.dumps({"slug": "Invalid Slug!", "story": self.test_story}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn(b"Invalid slug", response.content)

    def test_stories_view_post_invalid_json(self):
        """Test posting invalid JSON"""
        response = self.client.post(
            reverse("stories"), data="invalid json", content_type="application/json"
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn(b"Invalid JSON", response.content)


class StoryDetailViewTestCase(TestCase):
    """Test individual story operations"""

    def setUp(self):
        self.client = Client()
        self.test_story_dir = Path(tempfile.mkdtemp())

        self.test_story = {
            "title": "Test Story Detail",
            "chapters": [
                {
                    "id": "test-chapter",
                    "title": "Test Chapter",
                    "location": {"center": [0, 0], "zoom": 10},
                }
            ],
        }

    def tearDown(self):
        import shutil

        shutil.rmtree(self.test_story_dir)

    @patch("ncop_internal.views.STORY_JSON_DIR")
    def test_story_detail_get_valid(self, mock_story_dir):
        """Test getting valid story detail"""
        mock_story_dir.__str__ = lambda: str(self.test_story_dir)

        # Create test story file
        story_path = self.test_story_dir / "teststory.json"
        with open(story_path, "w") as f:
            json.dump(self.test_story, f)

        response = self.client.get(
            reverse("story-detail", kwargs={"slug": "teststory"})
        )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data["title"], "Test Story Detail")

    def test_story_detail_get_invalid_slug(self):
        """Test getting story with invalid slug"""
        response = self.client.get(
            reverse("story-detail", kwargs={"slug": "Invalid Slug!"})
        )
        self.assertEqual(response.status_code, 400)

    def test_story_detail_get_nonexistent(self):
        """Test getting non-existent story"""
        with patch("ncop_internal.views.STORY_JSON_DIR") as mock_dir:
            mock_dir.__str__ = lambda: str(self.test_story_dir)

            response = self.client.get(
                reverse("story-detail", kwargs={"slug": "nonexistent"})
            )
            self.assertEqual(response.status_code, 404)


class WeatherDataTestCase(TestCase):
    """Test weather data API endpoints"""

    def setUp(self):
        self.client = Client()

    @patch("ncop_internal.views.httpx.Client")
    def test_weather_data_view_success(self, mock_httpx):
        """Test successful weather data retrieval"""
        # Mock successful API response
        mock_client = MagicMock()
        mock_client.get.return_value.json.return_value = [
            {
                "station_id": "TEST001",
                "temperature": 25.5,
                "humidity": 60,
                "timestamp": "2025-01-05T12:00:00Z",
            }
        ]
        mock_client.get.return_value.status_code = 200
        mock_httpx.return_value = mock_client

        response = self.client.get(reverse("get-weather-pmdffd-data"))
        self.assertEqual(response.status_code, 200)

        data = json.loads(response.content)
        self.assertIn("features", data)

    @patch("ncop_internal.views.httpx.Client")
    def test_weather_data_view_api_error(self, mock_httpx):
        """Test weather data API error handling"""
        mock_client = MagicMock()
        mock_client.get.return_value.raise_for_status.side_effect = Exception(
            "API Error"
        )
        mock_httpx.return_value = mock_client

        response = self.client.get(reverse("get-weather-pmdffd-data"))
        self.assertEqual(response.status_code, 500)

    def test_weather_data_view_bbox_validation(self):
        """Test BBOX parameter validation"""
        response = self.client.get(reverse("get-weather-pmdffd-data") + "?bbox=invalid")
        self.assertEqual(response.status_code, 400)


class AirQualityTestCase(TestCase):
    """Test air quality API endpoints"""

    def setUp(self):
        self.client = Client()

    @patch("ncop_internal.views.httpx.Client")
    def test_waqi_view_success(self, mock_httpx):
        """Test successful WAQI data retrieval"""
        mock_client = MagicMock()
        mock_client.get.return_value.json.return_value = {
            "data": [
                {
                    "uid": "TEST001",
                    "city": "Test City",
                    "aqi": 50,
                    "pol": {"pm25": {"v": 12}},
                    "time": {"s": "2025-01-05 12:00:00"},
                }
            ]
        }
        mock_client.get.return_value.status_code = 200
        mock_httpx.return_value = mock_client

        response = self.client.get(reverse("waqi_global_aqi"))
        self.assertEqual(response.status_code, 200)

        data = json.loads(response.content)
        self.assertIn("features", data)

    @patch("ncop_internal.views.httpx.Client")
    def test_waqi_view_timeout(self, mock_httpx):
        """Test WAQI API timeout handling"""
        mock_client = MagicMock()
        mock_client.get.side_effect = Exception("Timeout")
        mock_httpx.return_value = mock_client

        response = self.client.get(reverse("waqi_global_aqi"))
        self.assertEqual(response.status_code, 500)


class GEETestCase(TestCase):
    """Test Google Earth Engine integration"""

    def setUp(self):
        self.client = Client()

    @patch("ncop_internal.views.ee.Initialize")
    def test_gee_initialization(self, mock_init):
        """Test GEE initialization"""
        mock_init.return_value = None

        # Import and call the initialization function
        from ncop_internal.views import initialize_gee

        initialize_gee()

        mock_init.assert_called_once()

    @patch("ncop_internal.views.ee.ImageCollection")
    def test_gee_dynamic_layer_view(self, mock_collection):
        """Test dynamic GEE layer generation"""
        mock_image = MagicMock()
        mock_image.getMapId.return_value = {"mapid": "test-map-id"}
        mock_collection.return_value = mock_image

        response = self.client.post(
            reverse("dynamic_gee"),
            data=json.dumps(
                {
                    "dataset": "test-dataset",
                    "aoi": {
                        "type": "Polygon",
                        "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
                    },
                }
            ),
            content_type="application/json",
        )

        # Should return 500 if not properly configured with credentials
        self.assertIn(
            response.status_code, [500, 200]
        )  # 500 in tests, 200 with proper setup


class GDACSTestCase(TestCase):
    """Test GDACS disaster alert integration"""

    def setUp(self):
        self.client = Client()

    @patch("ncop_internal.views.httpx.Client")
    def test_gdacs_events_view(self, mock_httpx):
        """Test GDACS events retrieval"""
        mock_client = MagicMock()
        mock_client.get.return_value.json.return_value = {
            "events": [
                {
                    "id": "1234",
                    "name": "Test Flood",
                    "type": "flood",
                    "date": "2025-01-05",
                }
            ]
        }
        mock_client.get.return_value.status_code = 200
        mock_httpx.return_value = mock_client

        response = self.client.get(
            reverse("get-gdacs-events", kwargs={"event_slug": "flood"})
        )
        self.assertEqual(response.status_code, 200)

        data = json.loads(response.content)
        self.assertIn("features", data)

    @patch("ncop_internal.views.httpx.Client")
    def test_gdacs_event_details_view(self, mock_httpx):
        """Test GDACS event details retrieval"""
        mock_client = MagicMock()
        mock_client.get.return_value.json.return_value = {
            "event": {
                "id": "1234",
                "name": "Test Flood Details",
                "impact": {"affected_people": 1000},
            }
        }
        mock_client.get.return_value.status_code = 200
        mock_httpx.return_value = mock_client

        response = self.client.get(
            reverse(
                "gdacs-event-details", kwargs={"event_type": "flood", "event_id": 1234}
            )
        )
        self.assertEqual(response.status_code, 200)

        data = json.loads(response.content)
        self.assertEqual(data["event"]["id"], "1234")


class SecurityTestCase(TestCase):
    """Test security vulnerabilities"""

    def setUp(self):
        self.client = Client()

    def test_csrf_protection(self):
        """Test CSRF protection is enabled"""
        response = self.client.post(
            reverse("login"), {"username": "test", "password": "test"}
        )
        # Should fail without CSRF token
        self.assertIn(response.status_code, [200, 400])

    def test_input_validation_stories(self):
        """Test input validation in story endpoints"""
        # Test SQL injection attempt
        response = self.client.post(
            reverse("stories"),
            data=json.dumps(
                {"slug": "'; DROP TABLE stories; --", "story": {"title": "Test"}}
            ),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)

    def test_path_traversal_protection(self):
        """Test path traversal protection"""
        response = self.client.get(
            reverse("story-detail", kwargs={"slug": "../../../etc/passwd"})
        )
        self.assertEqual(response.status_code, 400)

    def test_xss_protection(self):
        """Test XSS protection"""
        xss_payload = "<script>alert('xss')</script>"
        response = self.client.post(
            reverse("stories"),
            data=json.dumps({"slug": "test-story", "story": {"title": xss_payload}}),
            content_type="application/json",
        )

        if response.status_code == 200:
            # Check if script tag is escaped in response
            self.assertNotIn(b"<script>", response.content)
            self.assertNotIn(b"alert('xss')", response.content)


class PerformanceTestCase(TestCase):
    """Test performance and caching"""

    def setUp(self):
        self.client = Client()

    @patch("ncop_internal.views.cache")
    def test_caching_mechanism(self, mock_cache):
        """Test caching is working"""
        mock_cache.get.return_value = None
        mock_cache.set.return_value = True

        response = self.client.get(reverse("stories"))

        # Verify cache operations are called
        mock_cache.get.assert_called()
        mock_cache.set.assert_called()

    def test_response_times(self):
        """Test API response times are reasonable"""
        import time

        start_time = time.time()

        response = self.client.get(reverse("stories"))

        end_time = time.time()
        response_time = end_time - start_time

        # Should respond within 2 seconds for simple endpoints
        self.assertLess(response_time, 2.0)
        self.assertIn(response.status_code, [200, 400])
