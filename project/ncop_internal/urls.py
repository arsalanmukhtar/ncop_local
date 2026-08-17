from django.urls import path
from .chatbot import NcopAssistantChatView, NcopAssistantModelsView
from .views import (
    dashboard_view,
    documentation_view,
    login_view,
    signup_view,
    logout_view,
    password_reset_view,
    password_reset_confirm_view,
    StoriesView,
    StoryDetailView,
    WeatherDataPMDFFDView,
    GdacsEventsGeojsonApi,
    GdacsEventDetailsApi,
    NasaEonetEventsGeojsonApi,
    UsgsEarthquakeAlertsGeojsonApi,
    UsgsEarthquakeDetailApi,
    UsgsShakemapContentProxyApi,
    NcopRasterExportView,
    NcopShapefileUploadView,
    NcopKmzUploadView,
    NcopSpreadsheetUploadView,
    NcopRasterUploadView,
    NcopWmsCapabilitiesProxyView,
    NcopWmsTileProxyView,
    GeoGlowsRiverIdApi,
    GeoGlowsForecastApi,
    GeoGlowsForecastStatsApi,
    GeoGlowsDailyAveragesApi,
    GeoGlowsMonthlyAveragesApi,
    GeoGlowsAnnualAveragesApi,
    WAQIgeojson,
    DynamicGEELayerView,
    GEECatalogView,
    GenerateLegendView,
    TemporalGEELayerView,
    SlickPlusGeojsonApi,
    GdeltNewsEventsApi,
    WindOceanParticleDataApi,
    HeatwaveMonitoringView,
    HeatwaveDetailView,
    IpcFoodSecurityAPIView,
    IpcHistoryAPIView,
    CropListAPIView,
    CropYearsAPIView,
    CropSummaryAPIView,
    CropYearlyAPIView,
    CropMapAPIView,
    CropGeoJSONAPIView,
    PmdMonitorPredictionsAPIView,
    PmdMonitorPredictionValueAPIView,
    FfdHistoryAPIView,
    PmdDailyForecastProAPIView,
    NwfcRainfallReportAPIView,


)


urlpatterns = [
    path("", dashboard_view, name="dashboard"),
    path("docs/", documentation_view, name="documentation"),

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
    path("get-gdacs-events/<str:event_slug>/",GdacsEventsGeojsonApi.as_view(),name="get-gdacs-events",),
    path("get-gdacs-event-details/<str:event_type>/<int:event_id>/",GdacsEventDetailsApi.as_view(),name="gdacs-event-details",),
    path("get-gdacs-event-details/<str:event_type>/<int:event_id>/<int:episode_id>/",GdacsEventDetailsApi.as_view(),name="gdacs-event-details-ep",),
    path("get-nasa-eonet-events/<str:category_slug>/", NasaEonetEventsGeojsonApi.as_view(), name="nasa-eonet-events"),
    path("get-usgs-earthquake-alerts/", UsgsEarthquakeAlertsGeojsonApi.as_view(), name="usgs-earthquake-alerts"),
    path("get-usgs-earthquake-detail/<str:event_id>/", UsgsEarthquakeDetailApi.as_view(), name="usgs-earthquake-detail"),
    path("get-usgs-shakemap-content/", UsgsShakemapContentProxyApi.as_view(), name="usgs-shakemap-content"),
    path("gis-export/raster/", NcopRasterExportView.as_view(), name="gis-export-raster"),
    path("upload-shapefile/", NcopShapefileUploadView.as_view(), name="upload-shapefile"),
    path("upload-kmz/", NcopKmzUploadView.as_view(), name="upload-kmz"),
    path("upload-spreadsheet/", NcopSpreadsheetUploadView.as_view(), name="upload-spreadsheet"),
    path("upload-raster/", NcopRasterUploadView.as_view(), name="upload-raster"),
    path("wms-capabilities/", NcopWmsCapabilitiesProxyView.as_view(), name="wms-capabilities"),
    path("wms-tile/", NcopWmsTileProxyView.as_view(), name="wms-tile"),
    path("get-geoglows-riverid/", GeoGlowsRiverIdApi.as_view(), name="geoglows-riverid"),
    path("get-geoglows-forecast/<int:river_id>/", GeoGlowsForecastApi.as_view(), name="geoglows-forecast"),
    path("get-geoglows-forecaststats/<int:river_id>/", GeoGlowsForecastStatsApi.as_view(), name="geoglows-forecaststats"),
    path("get-geoglows-dailyaverages/<int:river_id>/", GeoGlowsDailyAveragesApi.as_view(), name="geoglows-dailyaverages"),
    path("get-geoglows-monthlyaverages/<int:river_id>/", GeoGlowsMonthlyAveragesApi.as_view(), name="geoglows-monthlyaverages"),
    path("get-geoglows-annualaverages/<int:river_id>/", GeoGlowsAnnualAveragesApi.as_view(), name="geoglows-annualaverages"),
    path('api/gee/dynamic-layer/', DynamicGEELayerView.as_view(), name='dynamic_gee'),
    path('api/gee/catalog/', GEECatalogView.as_view(), name='gee_catalog'),
    path('api/gee/legend/', GenerateLegendView.as_view(), name='gee_legend'),
    path('api/gee/temporal-layer/', TemporalGEELayerView.as_view(), name='temporal_gee_layer'),
    path("api/wind-ocean-particles/", WindOceanParticleDataApi.as_view(), name="wind_ocean_particles"),
    path( "get-gdelt-news-events/", GdeltNewsEventsApi.as_view(), name="gdelt-news-events" ),
    path("get-heatwave-monitoring/", HeatwaveMonitoringView.as_view(), name="heatwave-monitoring"),
    path("get-heatwave-detail/", HeatwaveDetailView.as_view(), name="heatwave-detail"),
    # IPC / Food Security — one route, country in the path.  Resolves
    # the latest analysis cycle server-side and returns GeoJSON directly
    # to Mapbox's geojson source (see map-layers.js → Food Security).
    path("api/ipc/<str:country>/", IpcFoodSecurityAPIView.as_view(), name="ipc-food-security"),
    # PTT (Population Tracking Tool) historical time-series — used by
    # the Food Security stats-modal's Historical Trend tab.
    path("api/ipc/<str:country>/history/", IpcHistoryAPIView.as_view(), name="ipc-history"),
    # Pakistan Crop Data (na.data.gov.pk / PBS)
    path("api/crops/list/",    CropListAPIView.as_view(),    name="crops-list"),
    path("api/crops/years/",   CropYearsAPIView.as_view(),   name="crops-years"),
    path("api/crops/summary/", CropSummaryAPIView.as_view(), name="crops-summary"),
    path("api/crops/yearly/",  CropYearlyAPIView.as_view(),  name="crops-yearly"),
    path("api/crops/map/",     CropMapAPIView.as_view(),     name="crops-map"),
    path("api/crops/geojson/", CropGeoJSONAPIView.as_view(), name="crops-geojson"),

    # PMD Monitor — WRFPRS precipitation forecast rasters, colorized
    # server-side into PNGs consumed by the temporal-slider system as
    # Mapbox `image` sources.  <element_key> ∈ {hourtpe, sixtpe,
    # twelvetpe, daytpe} — 3h / 6h / 12h / 24h accumulation windows.
    path(
        "api/pmd/monitor/predictions/<str:element_key>/",
        PmdMonitorPredictionsAPIView.as_view(),
        name="pmd-monitor-predictions",
    ),

    # Point-sample companion to the above — returns the actual numeric
    # value (not a picture) at one lat/lon, read from the same warped
    # GeoTIFF the PNG above was rendered from. See PmdMonitorPredictionValueAPIView.
    path(
        "api/pmd/monitor/predictions/<str:element_key>/value/",
        PmdMonitorPredictionValueAPIView.as_view(),
        name="pmd-monitor-predictions-value",
    ),

    # FFD barrage/dam discharge history — internal API primary, cached
    # public-feed buffer fallback. See FfdHistoryAPIView.
    path(
        "get-ffd-history/",
        FfdHistoryAPIView.as_view(),
        name="ffd-history",
    ),

    # PMD Provincial Daily Forecast — proxy for the public
    # pmd.gov.pk/phpapi/daily-forecastpro.php feed.  Consumed by the
    # Story panel's Provincial Forecast card (see
    # frontend/src/modules/story-provincial-forecast.js).  30-min
    # cache + 6 h stale fallback baked into the view.
    path(
        "api/pmd/monitor/daily-forecast-pro/",
        PmdDailyForecastProAPIView.as_view(),
        name="pmd-daily-forecast-pro",
    ),

    # NWFC Daily Rainfall Report, discovered + downloaded + parsed
    # server-side (PDF -> structured JSON). Feeds Chapter 1 of the
    # cinematic Dynamic Weather Report story
    # (frontend/src/modules/story-precipitation-briefing.js).  4 h
    # cache + 24 h stale fallback baked into the view.
    path(
        "api/pmd/nwfc/rainfall-report/",
        NwfcRainfallReportAPIView.as_view(),
        name="nwfc-rainfall-report",
    ),

    # NCOP Assistant (Phase 1 — RAG Q&A). See ncop_internal/chatbot.py +
    # chat_engine.py. Route left room under api/assistant/ for a future
    # Phase 2 (e.g. api/assistant/navigate/) without a namespace rename.
    path(
        "api/assistant/chat/",
        NcopAssistantChatView.as_view(),
        name="ncop-assistant-chat",
    ),
    # Model picker — see chat_engine.SUPPORTED_MODELS / NcopAssistantModelsView.
    path(
        "api/assistant/models/",
        NcopAssistantModelsView.as_view(),
        name="ncop-assistant-models",
    ),
]
