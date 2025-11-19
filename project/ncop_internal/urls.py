from django.urls import path
from .views import (
    dashboard_view,
    login_view,
    signup_view,
    logout_view,
    password_reset_view,
    password_reset_confirm_view,
    StoriesView,
    StoryDetailView,
    WeatherDataPMDFFDView,
    GdeltNewsEventsApi,
    WAQIgeojson,
    SlickPlusGeojsonApi,
    
)


urlpatterns = [
    path("", dashboard_view, name="dashboard"),

    path("login/", login_view, name="login"),
    path("signup/", signup_view, name="signup"),
    path("logout/", logout_view, name="logout"),
    path("password-reset/", password_reset_view, name="password_reset"),
    path("password-reset-confirm/<uidb64>/<token>/", password_reset_confirm_view, name="password_reset_confirm"),
    path("stories/", StoriesView.as_view(), name="stories"),
    path("stories/<slug:slug>/", StoryDetailView.as_view(), name="story-detail"),
    path("get-weather-pmdffd-data/", WeatherDataPMDFFDView.as_view(), name="get-weather-pmdffd-data",),
    path("get-waqi-global-airquality/", WAQIgeojson.as_view(), name="waqi_global_aqi"),
    path("api/slick-plus/", SlickPlusGeojsonApi.as_view(), name="slick_plus_geojson"),
    path( "get-gdelt-news-events/", GdeltNewsEventsApi.as_view(), name="gdelt-news-events" ),
]
