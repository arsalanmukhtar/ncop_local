from django.urls import path
from .views import (
    dashboard_view,
    login_view,
    signup_view,
    logout_view,
    password_reset_view,
    password_reset_confirm_view,
    production_health_dashboard,
    production_health_api,
    production_logs_api,
    production_restart_service,
    StoriesView,
    StoryDetailView,
    WeatherDataPMDFFDView,
    GdacsEventsGeojsonApi,
    GdacsEventDetailsApi,
    WAQIgeojson,
    DynamicGEELayerView,
    GEECatalogView,
    GenerateLegendView,
    TemporalGEELayerView,
    SlickPlusGeojsonApi,
    GdeltNewsEventsApi,

    
)


urlpatterns = [
    path("", dashboard_view, name="dashboard"),

    path("login/", login_view, name="login"),
    path("signup/", signup_view, name="signup"),
    path("logout/", logout_view, name="logout"),
    path("password-reset/", password_reset_view, name="password_reset"),
    path("password-reset-confirm/<uidb64>/<token>/", password_reset_confirm_view, name="password_reset_confirm"),
    path('health/', production_health_dashboard, name='health_dashboard'),
    path('health/api/', production_health_api, name='health_api'),
    path('health/api/logs/', production_logs_api, name='health_logs_api'),
    path('health/api/restart/', production_restart_service, name='health_restart'),
    path("stories/", StoriesView.as_view(), name="stories"),
    path("stories/<slug:slug>/", StoryDetailView.as_view(), name="story-detail"),
    path("get-weather-pmdffd-data/", WeatherDataPMDFFDView.as_view(), name="get-weather-pmdffd-data",),
    path("get-waqi-global-airquality/", WAQIgeojson.as_view(), name="waqi_global_aqi"),
    path("api/slick-plus/", SlickPlusGeojsonApi.as_view(), name="slick_plus_geojson"),
    path("get-gdacs-events/<str:event_slug>/",GdacsEventsGeojsonApi.as_view(),name="get-gdacs-events",),
    path("get-gdacs-event-details/<str:event_type>/<int:event_id>/",GdacsEventDetailsApi.as_view(),name="gdacs-event-details",),
    path("get-gdacs-event-details/<str:event_type>/<int:event_id>/<int:episode_id>/",GdacsEventDetailsApi.as_view(),name="gdacs-event-details-ep",),
    path('api/gee/dynamic-layer/', DynamicGEELayerView.as_view(), name='dynamic_gee'),
    path('api/gee/catalog/', GEECatalogView.as_view(), name='gee_catalog'),
    path('api/gee/legend/', GenerateLegendView.as_view(), name='gee_legend'),
    path('api/gee/temporal-layer/', TemporalGEELayerView.as_view(), name='temporal_gee_layer'),
    path( "get-gdelt-news-events/", GdeltNewsEventsApi.as_view(), name="gdelt-news-events" )
]
