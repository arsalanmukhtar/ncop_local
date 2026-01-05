from django.db import models
from django.contrib.auth.models import User
from django.contrib.gis.db import models as gis_models
from django.utils import timezone
import uuid


class UserProfile(models.Model):
    """Extended user profile for NCOP platform"""

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="profile")
    user_id = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    organization = models.CharField(max_length=200, blank=True, null=True)
    role = models.CharField(
        max_length=20,
        choices=[
            ("viewer", "Viewer"),
            ("analyst", "Analyst"),
            ("manager", "Manager"),
            ("admin", "Administrator"),
        ],
        default="viewer",
    )
    default_theme = models.CharField(
        max_length=10,
        choices=[("day", "Day"), ("night", "Night"), ("auto", "Auto")],
        default="auto",
    )
    preferred_projection = models.CharField(
        max_length=20,
        choices=[
            ("mercator", "Mercator"),
            ("globe", "Globe"),
            ("albers", "Albers Equal Area"),
        ],
        default="mercator",
    )
    auto_refresh_enabled = models.BooleanField(default=False)
    refresh_interval = models.IntegerField(default=30000)  # 30 seconds
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ncop_user_profile"
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["role"]),
        ]


class MapSettings(models.Model):
    """User-specific map settings"""

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="map_settings"
    )
    name = models.CharField(max_length=100)
    center_latitude = models.FloatField()
    center_longitude = models.FloatField()
    zoom_level = models.IntegerField(default=10)
    bearing = models.FloatField(default=0)
    pitch = models.FloatField(default=0)
    projection = models.CharField(
        max_length=20,
        choices=[
            ("mercator", "Mercator"),
            ("globe", "Globe"),
            ("albers", "Albers Equal Area"),
        ],
        default="mercator",
    )
    terrain_enabled = models.BooleanField(default=False)
    labels_enabled = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ncop_map_settings"
        unique_together = [["user", "name"]]
        indexes = [
            models.Index(fields=["user"]),
        ]


class LayerInfo(models.Model):
    """Information about available layers"""

    name = models.CharField(max_length=200, unique=True)
    display_name = models.CharField(max_length=200)
    layer_type = models.CharField(
        max_length=50,
        choices=[
            ("base", "Base Map"),
            ("overlay", "Overlay"),
            ("temporal", "Temporal"),
            ("analysis", "Analysis"),
        ],
        default="overlay",
    )
    source = models.CharField(max_length=100)
    description = models.TextField(blank=True, null=True)
    metadata = models.JSONField(default=dict, blank=True)
    default_opacity = models.FloatField(default=1.0)
    min_zoom = models.IntegerField(default=0)
    max_zoom = models.IntegerField(default=20)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ncop_layer_info"
        indexes = [
            models.Index(fields=["name"]),
            models.Index(fields=["layer_type"]),
            models.Index(fields=["is_active"]),
        ]


class UserLayer(models.Model):
    """User's saved layer configurations"""

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="saved_layers"
    )
    layer_info = models.ForeignKey(
        LayerInfo, on_delete=models.CASCADE, related_name="user_configs"
    )
    name = models.CharField(max_length=200)
    opacity = models.FloatField(default=1.0)
    visible = models.BooleanField(default=True)
    order_index = models.IntegerField(default=0)
    filters = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ncop_user_layer"
        unique_together = [["user", "name"]]
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["layer_info"]),
            models.Index(fields=["order_index"]),
        ]


class Story(models.Model):
    """User-generated stories with map layers"""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="stories")
    slug = models.SlugField(max_length=100, unique=True)
    title = models.CharField(max_length=300)
    subtitle = models.CharField(max_length=500, blank=True, null=True)
    description = models.TextField(blank=True, null=True)
    theme = models.CharField(
        max_length=10,
        choices=[("day", "Day"), ("night", "Night"), ("auto", "Auto")],
        default="auto",
    )
    show_markers = models.BooleanField(default=True)
    use_3d_terrain = models.BooleanField(default=False)
    default_zoom = models.IntegerField(default=8)
    default_bearing = models.FloatField(default=0)
    default_pitch = models.FloatField(default=0)
    chapters = models.JSONField(default=list)
    metadata = models.JSONField(default=dict, blank=True)
    is_public = models.BooleanField(default=False)
    view_count = models.IntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "ncop_story"
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["slug"]),
            models.Index(fields=["is_public"]),
            models.Index(fields=["created_at"]),
        ]


class UserActivity(models.Model):
    """Track user activities for analytics"""

    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="activities")
    activity_type = models.CharField(
        max_length=50,
        choices=[
            ("login", "Login"),
            ("logout", "Logout"),
            ("view_story", "View Story"),
            ("create_layer", "Create Layer"),
            ("export_data", "Export Data"),
            ("api_call", "API Call"),
        ],
    )
    description = models.CharField(max_length=500, blank=True, null=True)
    metadata = models.JSONField(default=dict, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    user_agent = models.TextField(blank=True, null=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ncop_user_activity"
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["activity_type"]),
            models.Index(fields=["timestamp"]),
        ]


class AlertSubscription(models.Model):
    """User alert subscriptions for disaster notifications"""

    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="alert_subscriptions"
    )
    alert_type = models.CharField(
        max_length=50,
        choices=[
            ("flood", "Flood"),
            ("earthquake", "Earthquake"),
            ("cyclone", "Cyclone"),
            ("fire", "Fire"),
            ("air_quality", "Air Quality"),
            ("weather", "Weather"),
        ],
    )
    regions = models.JSONField(default=list)  # GeoJSON polygon coordinates
    severity_threshold = models.CharField(
        max_length=20,
        choices=[
            ("all", "All Severities"),
            ("moderate", "Moderate and Above"),
            ("severe", "Severe Only"),
            ("extreme", "Extreme Only"),
        ],
        default="moderate",
    )
    notification_methods = models.JSONField(
        default=["email"], help_text="Available methods: email, sms, push, webhook"
    )
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "ncop_alert_subscription"
        indexes = [
            models.Index(fields=["user"]),
            models.Index(fields=["alert_type"]),
            models.Index(fields=["is_active"]),
        ]


class DataCache(models.Model):
    """Cache for frequently accessed external data"""

    cache_key = models.CharField(max_length=255, unique=True)
    data = models.JSONField()
    source = models.CharField(max_length=100)
    expiry_time = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    access_count = models.IntegerField(default=0)
    size_bytes = models.IntegerField(default=0)

    class Meta:
        db_table = "ncop_data_cache"
        indexes = [
            models.Index(fields=["cache_key"]),
            models.Index(fields=["source"]),
            models.Index(fields=["expiry_time"]),
        ]

    @classmethod
    def is_expired(cls, cache_entry):
        """Check if cache entry is expired"""
        return timezone.now() > cache_entry.expiry_time

    @classmethod
    def cleanup_expired(cls):
        """Remove expired cache entries"""
        return cls.objects.filter(expiry_time__lt=timezone.now()).delete()
