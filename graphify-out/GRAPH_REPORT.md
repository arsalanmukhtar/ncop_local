# Graph Report - .  (2026-08-05)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1957 nodes · 3842 edges · 118 communities (87 shown, 31 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 41 edges (avg confidence: 0.55)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d79fe057`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 103
- Community 104
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112

## God Nodes (most connected - your core abstractions)
1. `WeatherReportControl` - 129 edges
2. `NavigationPanel` - 74 edges
3. `getNextNDays()` - 41 edges
4. `LayerStyleConfig` - 39 edges
5. `escapeHtml()` - 38 edges
6. `SourceLayerControl` - 37 edges
7. `SplitCompareControl` - 35 edges
8. `SidebarMenu` - 34 edges
9. `LayerAttributePopup` - 25 edges
10. `CropExplorerControl` - 20 edges

## Surprising Connections (you probably didn't know these)
- `_fetchAndBuild()` --calls--> `getPmdWarnings()`  [EXTRACTED]
  frontend/src/modules/story-provincial-forecast.js → frontend/src/modules/gcop-api-cache.js
- `_fetchAndBuild()` --calls--> `getNwfcWeeklyOutlook()`  [EXTRACTED]
  frontend/src/modules/story-provincial-forecast.js → frontend/src/modules/gcop-api-cache.js
- `initGcopMonitorIntegration()` --calls--> `registerNwfcWeatherIcons()`  [EXTRACTED]
  frontend/src/modules/gcop-monitor-integration.js → frontend/src/modules/map-icons.js
- `hydrateWaterlevels()` --calls--> `getFfdWaterlevels()`  [EXTRACTED]
  frontend/src/modules/gcop-ffd-integration.js → frontend/src/modules/gcop-api-cache.js
- `ensureRiversLayer()` --calls--> `getFfdRivers()`  [EXTRACTED]
  frontend/src/modules/gcop-ffd-integration.js → frontend/src/modules/gcop-api-cache.js

## Import Cycles
- None detected.

## Communities (118 total, 31 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (71): baseUrl, bbaod550_layers, buildFC(), cams_aod_daily_layers, cams_aod_hourly_layers, cams_aqi_daily_layers, cams_aqi_hourly_layers, cams_co_daily_layers (+63 more)

### Community 2 - "Community 2"
Cohesion: 0.07
Nodes (58): COUNTRY_ISO_MAP, SOUTH_ASIA_COORDS, toggleOceanParticleLayer(), toggleWindParticleLayer(), _WOP_O_PAL, _WOP_SEA_BOUNDS, _WOP_SEA_CENTER, _WOP_W_PAL (+50 more)

### Community 3 - "Community 3"
Cohesion: 0.08
Nodes (21): addExposurePolygonToMap(), clearAllExposureLayersFromMap(), exposureLayersMap, getItemData(), getMap(), handleButtonInteraction(), handleDewExposureCheckbox(), handleDropdownInteraction() (+13 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (44): login_required, _coerce_geoglows_dates(), configure_for_production(), dashboard_view(), documentation_view(), _fetch_geoglows_with_date_fallback(), GdacsEventDetailsApi, GEECatalogView (+36 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (26): closeBasemapPanel(), closeGeocoderPanel(), closeLayerInfoPanel(), closeLayerOrderPanel(), closeLayerStylePanel(), closeSidebarPanel(), closeUserPanel(), closeWeatherReportPanel() (+18 more)

### Community 6 - "Community 6"
Cohesion: 0.11
Nodes (8): clamp(), formatValue(), GEOMETRY_CONTROL_DEFS, GEOMETRY_PILL_META, LABEL_CONTROL_DEFS, LayerStyleConfig, roundToStep(), toHex()

### Community 8 - "Community 8"
Cohesion: 0.08
Nodes (7): MapControls, startStoryBySlug(), StoryManager, BASEMAP_STYLES, BasemapPanel, ProjectionPanel, resolveBasemapUrl()

### Community 9 - "Community 9"
Cohesion: 0.11
Nodes (36): BOUNDARY_SOURCE_IDS, SPEED_TO_MS, addClickListeners(), _applyGlobalOpacityNow(), _boundClickLayers, buildPopupContent(), cleanupSliderLayers(), escapeHtml() (+28 more)

### Community 10 - "Community 10"
Cohesion: 0.11
Nodes (39): generateBBAOD550Layers(), generateCO2_850hPaLayers(), generateCO2SurfaceLayers(), generateConvectivePrecipitationWeeklyLayers(), generateECMWFCycloneLayers(), generateECMWFTempLayers(), generateGDPSAccPreciLayers(), generateGDPSRelHumLayers() (+31 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (41): 10) Appendix B: Stage vs Production, 11) Change Log / Known Issues, 12.1 Pull Latest Code from `stage-arsalan`, 12.2 Build Frontend Assets (Vite), 12.3 Collect Django Static Files, 12.4 Fix File Permissions (after build), 12.5 Service Control Commands, 12.6 Complete Deployment Sequence (Copy‑Paste) (+33 more)

### Community 12 - "Community 12"
Cohesion: 0.06
Nodes (24): AHPModels, EnhancedCompute, GEEDataCatalog, Enhanced semantic search for better dataset matching, Expand query with synonyms and related terms, Calculate semantic similarity score between query and dataset, Advanced hazard management system with semantic search + Environmental…, Enhanced semantic search with priority scoring (+16 more)

### Community 13 - "Community 13"
Cohesion: 0.08
Nodes (38): _attachIpcDragAndResize(), buildFfdPopupContent(), buildIpcPopupContent(), buildUsgsPopupContent(), buildWaqiPopupContent(), chartInstances, _drawIpcBarChart(), _drawIpcHistoryChart() (+30 more)

### Community 14 - "Community 14"
Cohesion: 0.10
Nodes (33): _cache, _FETCH_HEADERS, fetchGcopCached(), _fetchWithRetry(), GCOP_BASE_URL, getFfdBulletins(), getNwfcForecast(), getNwfcMaxTemperatures() (+25 more)

### Community 15 - "Community 15"
Cohesion: 0.09
Nodes (30): createNwfcAnimatedImage(), createPMDAnimatedImage(), createPMDStaticSunCanvas(), createUsgsPulsingDot(), drawEonetAll(), drawEonetBadge(), drawEonetFire(), drawEonetIce() (+22 more)

### Community 17 - "Community 17"
Cohesion: 0.09
Nodes (34): _applyChapterHighlightDay(), _applyChapterWarningsOverlay(), _closeChapterPopup(), _computeBriefingCardOffset(), COUNTRY_LOCATION, _ensureBriefingCard(), _ensureDistrictSource(), _ensureOverlayLayers() (+26 more)

### Community 18 - "Community 18"
Cohesion: 0.06
Nodes (34): 1.1 Recommended client pattern (any language), 1.2 Universal data-quality gotchas, 1. Prerequisites, 2.1 `GET /get-ffd-waterlevels/`, 2.2 `GET /get-ffd-rivers/`, 2.3 `GET /get-ffd-bulletins/`, 2. FFD Flood Forecasting, 3.10 `GET /api/pmd/public-forecast/` (+26 more)

### Community 19 - "Community 19"
Cohesion: 0.08
Nodes (24): APIView, diagnose_ssl_issues(), _extract_geoglows_river_id(), GdacsEventsGeojsonApi, IpcFoodSecurityAPIView, _mon_cached(), _mon_pred_select_steps(), _normalize_eonet_feature() (+16 more)

### Community 22 - "Community 22"
Cohesion: 0.06
Nodes (31): AFTER (What You Have Now), BEFORE (What You Had), BRANCHES AFFECTED 🌿, FILES CREATED (New) ⭐, FILES MODIFIED (Changed) 🔧, 🔄 How to Replicate This Process, 📖 NCOP Project - Detailed Step-by-Step Walkthrough, Phase 1: Create Configuration Files (5 min) (+23 more)

### Community 23 - "Community 23"
Cohesion: 0.09
Nodes (17): GdeltNewsEventsApi, Enhanced Django view with robust error handling and SSL fixes - PAKISTAN FOCUS…, Main GET endpoint with improved error handling, Fetch social media data from multiple sources concurrently, Normalize title for deduplication, Remove duplicate articles based on title similarity, Convert data to GeoJSON format with enhanced processing, Enhanced coordinate extraction from article data - PAKISTAN PRIORITY (+9 more)

### Community 24 - "Community 24"
Cohesion: 0.07
Nodes (28): 1. Django + Vite Setup, 2. Templates, Scripts, and Assets, 3. Dashboard NCOP Functionality, 4. Easy-to-Understand Workflow, 5. Updating and Adding More Features, 6. JavaScript Modules: What They Do and How They Connect, a) Django Project and App, b) Vite Setup (+20 more)

### Community 25 - "Community 25"
Cohesion: 0.15
Nodes (6): buildEonetPopupContent(), handlePmdPopupClick(), HIDDEN_KEYS, LayerAttributePopup, prettyAttributeName(), setupPmdPopupEventHandlers()

### Community 28 - "Community 28"
Cohesion: 0.20
Nodes (6): chartInstances, CROP_PALETTE, CropExplorerControl, _escape(), _fmtNum(), _themedColor()

### Community 29 - "Community 29"
Cohesion: 0.10
Nodes (21): anchorFloatingPanelToButton(), anchorRailPanelsToButtons(), RAIL_FLOAT_PANEL_BUTTON_MAP, RAIL_PANEL_BUTTON_MAP, RAIL_PANEL_REGISTRY, IMPORTANT: NavigationPanel builds the story modal shell (#story-modal with…, reanchorAllVisibleFloatPanels(), setupRailFloatingPanelAnchoring() (+13 more)

### Community 31 - "Community 31"
Cohesion: 0.09
Nodes (21): _mon_do_login(), _mon_extract_jwt(), _mon_get(), _mon_get_bytes(), _mon_invalidate_session(), _mon_make_bare_session(), _mon_pred_convert_step(), _mon_pred_ramp_file() (+13 more)

### Community 32 - "Community 32"
Cohesion: 0.09
Nodes (14): GDELTClient, PerformanceMonitor, RateLimiter, Thread-safe rate limiter for API requests, Check if we can make a request based on rate limit, Wait until we can make a request, Robust GDELT API client with retry logic and SSL error handling, Fetch articles from GDELT with a hard time budget. `deadline_seconds` bounds… (+6 more)

### Community 33 - "Community 33"
Cohesion: 0.12
Nodes (16): method_decorator, PathLike, DynamicGEELayerView, _list_slugs(), _load_json(), Constructs the path for a story JSON file by slug., Lists all available story JSON files as slugs., Safely load a JSON file. (+8 more)

### Community 34 - "Community 34"
Cohesion: 0.19
Nodes (5): HAZARD_TYPES, initPmdWarningsFilter(), injectStyles(), pmdWarningsFilter, PmdWarningsFilterController

### Community 35 - "Community 35"
Cohesion: 0.10
Nodes (21): 8.1 Service Management Commands, 8.2 Quick Deployment Commands, 8.3 Configuration Files Reference, 8.4 File Locations & Paths, 8.5 Python Dependencies, 8.6 JavaScript Module Documentation, Caching (Optional), Core Django Framework (+13 more)

### Community 36 - "Community 36"
Cohesion: 0.14
Nodes (13): _heatwave_disk_get(), _heatwave_disk_janitor(), _heatwave_disk_path(), _heatwave_disk_put(), _heatwave_get(), HeatwaveDetailView, HeatwaveMonitoringView, Rate-limited GET wrapper for Open-Meteo. Returns (json, error). (+5 more)

### Community 37 - "Community 37"
Cohesion: 0.16
Nodes (17): Any, deep_get(), extract_impact_links(), get_json(), normalize_gdacs_impacts(), parse_impact_payload(), parse_sendai_records(), Lightweight summary across common scalar names used by EQ/TC/WF payloads. (You… (+9 more)

### Community 38 - "Community 38"
Cohesion: 0.18
Nodes (10): CROP_STOPS, cropFilter, CropFilterController, _escape(), FALLBACK_STOPS_DIST, FALLBACK_STOPS_PROV, initCropFilter(), _injectStyles() (+2 more)

### Community 39 - "Community 39"
Cohesion: 0.17
Nodes (19): _buildDayChapterHtml(), _buildFocusChapterHtml(), _buildRichFocusMessage(), _colorForLevel(), _composeWarningText(), _decorateWarningText(), _escapeHtml(), _fmtIsoTime() (+11 more)

### Community 40 - "Community 40"
Cohesion: 0.18
Nodes (10): DashboardManager, waitForEl(), getFfdRivers(), getFfdWaterlevels(), ensureRiversLayer(), hydrateWaterlevels(), initGcopFfdIntegration(), teardownRiversLayer() (+2 more)

### Community 41 - "Community 41"
Cohesion: 0.12
Nodes (15): A.1 Production Settings (prod.py), A.2 Nginx Configuration, A.3 Waitress Service File, Appendix A: Complete File Listings, Appendix B: Environment Variables, Appendix C: Deployment Checklist, Appendix G: Backup & Recovery, Appendix H: Contact & Support (+7 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (15): 10. How to Use This Environment Daily, 11. Summary (What We Achieved), 1. Understanding the Goal, 2. System Requirements, 3. Installing Python 3.11 on Ubuntu, 4. Installing GDAL System Libraries, 5. Creating the Project Virtual Environment, 6. Preparing to Install GDAL for Python (+7 more)

### Community 43 - "Community 43"
Cohesion: 0.13
Nodes (15): bootstrap, chart.js, dependencies, bootstrap, chart.js, @jindin/mapbox-gl-wind-layer, lucide, mapbox-gl (+7 more)

### Community 44 - "Community 44"
Cohesion: 0.20
Nodes (15): aggregateMonthly(), attachHeatwaveDragAndResize(), destroyHeatwaveChart(), ensureHeatwaveModal(), fetchHeatwaveDetail(), getHeatwaveCanvas(), getHeatwaveChartTheme(), hideHeatwaveModal() (+7 more)

### Community 45 - "Community 45"
Cohesion: 0.16
Nodes (15): buildCropPopupContent(), buildNwfcPopupContent(), buildPmdCityForecastPopupContent(), buildPmdForecastStepsTable(), buildPmdPopupContent(), _cropCropName(), _cropFmt(), escapeHtml() (+7 more)

### Community 46 - "Community 46"
Cohesion: 0.23
Nodes (3): _cleanCorruptedDataUrl(), _isTelemetryUrl(), setAssets()

### Community 47 - "Community 47"
Cohesion: 0.21
Nodes (14): generateGDPSPreciTypesLayers(), generateLiquidFogProbability3HourlyLayers(), generateMBX_MeteoblueCAPEHourlyLayers(), generateMBX_MeteoblueHourlyCloudPrecipLayers(), generateMBX_MeteoblueRadarCompositeLayers(), generateMBX_MeteoblueSnowfallHourlyLayers(), generateMBX_MeteoblueStormHelicityHourlyLayers(), generateMeteoblueCAMSAirQualityHourlyLayers() (+6 more)

### Community 48 - "Community 48"
Cohesion: 0.21
Nodes (7): CropGeoJSONAPIView, CropListAPIView, CropMapAPIView, _CropsBaseView, CropSummaryAPIView, CropYearlyAPIView, CropYearsAPIView

### Community 49 - "Community 49"
Cohesion: 0.21
Nodes (13): _bindCardEvents(), _clearTimers(), _ensureCard(), _fetchAndBuild(), _handlePanelVisible(), _loadTtsPref(), _pause(), _play() (+5 more)

### Community 50 - "Community 50"
Cohesion: 0.15
Nodes (12): 1. What it is, and how a user reaches it, 2. Visual style, 3.1 State model, 3.2 The core render loop, 3.3 The "MAP LAYERS" toggle buttons are two-way bound to the sidebar, 3.4 Drill-down sub-views ("PMD NWFC DATA PANELS"), 3.5 Security posture worth replicating, 3. Internal architecture (+4 more)

### Community 51 - "Community 51"
Cohesion: 0.22
Nodes (4): LoginRequiredMixin, GET /api/wind-ocean-particles/?sw_lat=&sw_lng=&ne_lat=&ne_lng= Returns: {…, WindOceanParticleDataApi, _WopRateLimiter

### Community 52 - "Community 52"
Cohesion: 0.15
Nodes (13): 1. Service Health Checks, 2. HTTP Response Tests, 3. Asset Loading Tests, 4. Log Analysis, 5. Database Connectivity, 6.1 Complete Deployment Steps, 6.2 Automated Deployment Script, 6.3 Manual Deployment Process (+5 more)

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (12): createFfdChart(), createNwfcChart(), createPmdChart(), extractMetricTimeseries(), fetchStationDetail(), handleFfdPopupClick(), handleWaqiPopupClick(), populateInlineHeaderForPopup() (+4 more)

### Community 54 - "Community 54"
Cohesion: 0.23
Nodes (12): _applyHazardEffect(), _clearHazardEffects(), _currentTickMs(), _estimateTtsMs(), _goto(), _showChapterPopup(), _speakChapterMessage(), _startTick() (+4 more)

### Community 55 - "Community 55"
Cohesion: 0.17
Nodes (12): 7.1 Common Issues & Solutions, 7.2 The Double Path Problem, 7.3 File Permission Issues, 7.4 Manifest Path Errors, 7.5 Service Startup Problems, 7.6 Static File Loading Errors, 7.7 Debugging Commands, Part VII: Troubleshooting Guide (+4 more)

### Community 56 - "Community 56"
Cohesion: 0.27
Nodes (3): Fetch one WAQI /feed/@<uid> and convert it into a Feature with enrichment., Fetch all FORCE_UIDS by first trying AirNet hourly, and if that fails, falling…, WAQIgeojson

### Community 57 - "Community 57"
Cohesion: 0.22
Nodes (9): hydrate(), initGcopMonitorIntegration(), normaliseNwfcObservationsFC(), toFC(), nwfcWeatherBucket(), nwfcWeatherIconId(), initNwfcHtmlMarkers(), manager (+1 more)

### Community 59 - "Community 59"
Cohesion: 0.20
Nodes (10): autoprefixer, vite, devDependencies, autoprefixer, postcss, tailwindcss, vite, postcss (+2 more)

### Community 61 - "Community 61"
Cohesion: 0.22
Nodes (9): 4.1 Production Environment Overview, 4.2 Initial Production Setup, 4.3 Django Configuration, 4.4 Nginx Configuration, 4.5 Waitress Service Configuration, Cloning Production Code, Creating .env File, Part IV: Production Deployment (Prod-Arsalan) (+1 more)

### Community 62 - "Community 62"
Cohesion: 0.22
Nodes (9): Part I: Introduction & Overview, Part II: Environment Setup, Part III: Development to Staging (Stage-Arsalan), Part IV: Production Deployment (Prod-Arsalan), Part V: Asset Management & Build Process, Part VI: Deployment Workflow, Part VII: Troubleshooting Guide, Part VIII: Reference & Appendices (+1 more)

### Community 64 - "Community 64"
Cohesion: 0.32
Nodes (8): _buildPlaybackList(), _closeWarningHoverPopup(), _hazardCodeForFeature(), _isoDateOnly(), _parseMessageLocations(), _selectWarningFeatures(), _showWarningHoverPopup(), _wireWarningHoverIfNeeded()

### Community 65 - "Community 65"
Cohesion: 0.25
Nodes (3): HTTPAdapter, _MonSSLAdapter, Standalone prod diagnostic for PMD Predictions. Run from the project root under…

### Community 66 - "Community 66"
Cohesion: 0.25
Nodes (8): 2.3 Ubuntu Production Environment Setup, Creating Python Virtual Environment, Installing and Configuring Nginx, Installing GDAL (Geospatial Library), Installing Node.js and npm, Installing PostgreSQL with PostGIS, Installing Python 3.11, Installing Python Dependencies

### Community 67 - "Community 67"
Cohesion: 0.32
Nodes (4): Fetch data from a single endpoint, Get cached data if still valid, Merge data from all endpoints by station name, WeatherDataPMDFFDView

### Community 68 - "Community 68"
Cohesion: 0.29
Nodes (6): name, overrides, vite, private, type, version

### Community 69 - "Community 69"
Cohesion: 0.52
Nodes (6): getPmdStations(), hydrateStations(), initGcopPmdIntegration(), normalizeFC(), normalizeStation(), toNumOrNull()

### Community 70 - "Community 70"
Cohesion: 0.33
Nodes (7): animateUsgsShakeMapLayer(), clearUsgsShakeMapLayer(), collectCoordinates(), ensureUsgsLegendPanel(), handleUsgsPopupClick(), pickPreferredUsgsShakemapContent(), setupUsgsPopupEventHandlers()

### Community 71 - "Community 71"
Cohesion: 0.29
Nodes (7): _buildChaptersFromOutlook(), _chapterDateISO(), DISTRICT_BLACKLIST, _extractDistrictNames(), _extractHazardCodesFrom(), _mentionedProvincesIn(), PROVINCE_ORDER

### Community 72 - "Community 72"
Cohesion: 0.57
Nodes (6): _currentStepIndex(), _ensureDateEl(), initTemporalCurrentStep(), _pickDateFromEntry(), _refresh(), _refreshFromDom()

### Community 73 - "Community 73"
Cohesion: 0.43
Nodes (7): evenSampleArray(), fetchRainViewerDescriptor(), generateRainViewerRadarLayers(), generateRainViewerSatelliteIRLayers(), rvBuildEntry(), rvCollectFrames(), rvFormatPKTLabel()

### Community 74 - "Community 74"
Cohesion: 0.29
Nodes (7): 2.1 Understanding the Three Environments, 2.2 Project Structure, 2.4 System Requirements, **dev-arsalan** (Development Environment), Part II: Environment Setup, **prod-arsalan** (Production Environment), **stage-arsalan** (Staging Environment)

### Community 75 - "Community 75"
Cohesion: 0.29
Nodes (7): 3.1 Stage Branch Process, 3.2 Setting Up Staging Environment, 3.3 Staging Deployment Workflow, Creating Stage Branch, Part III: Development to Staging (Stage-Arsalan), Staging Configuration (staging.py), Waitress Service for Staging

### Community 76 - "Community 76"
Cohesion: 0.29
Nodes (7): 5.1 Understanding Vite Assets, 5.2 Django Static Files, 5.3 The Asset Pipeline, 5.4 Frontend Build Process, Building Vite Assets, Part V: Asset Management & Build Process, Vite Configuration

### Community 77 - "Community 77"
Cohesion: 0.53
Nodes (5): check_file_exists(), main(), print_status(), Print colored status message, Check if file exists and report

### Community 78 - "Community 78"
Cohesion: 0.33
Nodes (6): buildHeatwavePopupContent(), handleHeatwavePopupClick(), heatwaveAlertVariant(), heatwaveFmt(), setupHeatwavePopupEventHandlers(), showHeatwaveModalForCity()

### Community 79 - "Community 79"
Cohesion: 0.40
Nodes (6): _bboxForFeatures(), _flyToChapter(), _startCinematicOrbit(), _stopCinematicLoop(), _stopOrbitOnly(), _walkCoords()

### Community 80 - "Community 80"
Cohesion: 0.33
Nodes (6): _handlePanelHidden(), initStoryProvincialForecast(), _injectStyles(), _removeBriefingCard(), _teardownStoryWarningsOverlay(), _wireVisibilityObserver()

### Community 81 - "Community 81"
Cohesion: 0.40
Nodes (5): scripts, build, build-and-copy, dev, preview

### Community 82 - "Community 82"
Cohesion: 0.40
Nodes (5): 1.1 About This Handbook, 1.2 What is NCOP?, 1.3 Understanding the Architecture, 1.4 Quick Deployment Summary, Part I: Introduction & Overview

### Community 83 - "Community 83"
Cohesion: 0.50
Nodes (4): extractLatestMeteoblueTimeValue(), generateMBX_MeteoblueLHASA2LatestLayer(), getCurrentUtcDateCompact(), getLatestMeteoblueTimeSync()

### Community 84 - "Community 84"
Cohesion: 0.50
Nodes (4): generatePmdPredictionsLoader(), _pmdPickLabelIndices(), _pmdPredBuildEntry(), _pmdPredFormatDate()

### Community 85 - "Community 85"
Cohesion: 0.50
Nodes (3): __dirname, __filename, REPO_ROOT

### Community 86 - "Community 86"
Cohesion: 0.50
Nodes (4): Appendix D: Monitoring & Maintenance, Daily Health Checks, Monthly Maintenance, Weekly Maintenance

### Community 87 - "Community 87"
Cohesion: 0.50
Nodes (4): Appendix E: Security Hardening, Database Security, Firewall Configuration, SSL/HTTPS Setup (Future)

### Community 88 - "Community 88"
Cohesion: 0.50
Nodes (4): Appendix F: Performance Optimization, Database Query Optimization, Nginx Caching, Redis Caching

## Knowledge Gaps
- **423 isolated node(s):** `name`, `private`, `version`, `type`, `dev` (+418 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **31 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WeatherReportControl` connect `Community 7` to `Community 14`, `Community 21`, `Community 27`, `Community 29`, `Community 30`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `NavigationPanel` connect `Community 1` to `Community 2`, `Community 29`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `SidebarMenu` connect `Community 3` to `Community 29`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **What connects `name`, `private`, `version` to the rest of the system?**
  _423 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02939166097060834 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06468797564687975 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07219662058371736 - nodes in this community are weakly interconnected._