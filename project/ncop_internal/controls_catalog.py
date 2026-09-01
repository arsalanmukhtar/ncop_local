# project/ncop_internal/controls_catalog.py
# ---------------------------------------------------------------------------
# NCOP Assistant knowledge base — a curated catalog of NCOP's UI controls,
# so the assistant can explain what a control DOES, not just what a layer
# shows. Hand-authored, not statically parsed from source, unlike
# layer_catalog_parser.py — this is a small, stable set where hand-curation
# is lower-risk and higher-quality than parsing scattered markup across a
# dozen different module files, each with its own button markup shape.
# Mostly `.map-right-rail` (the vertical button rail on the right edge of
# the map — cross-referenced against dashboard.js's buttonOrder construction,
# buildUnifiedRightRail), plus a few important controls that live OUTSIDE
# the rail entirely (e.g. the day/night theme toggle, top-left corner) —
# every entry's own module is where its real id/title/behavior was
# confirmed, not guessed. Several descriptions below are lifted directly
# from nav-controls.js's own guided-tour step content (NCOP_TOUR_STEPS) —
# already-written, already-accurate onboarding copy for that exact control,
# reused here rather than re-describing it from scratch.
#
# `frontend_id` matches the real DOM id — Phase 2's navigation feature keys
# off this the same way it keys off a layer's itemKey, so this schema is
# deliberately shaped like a layer_catalog record (id/label/description/
# category) even though the underlying source (hand-authored vs. parsed) is
# different.
# ---------------------------------------------------------------------------

RAIL_CONTROLS = [
    {
        "frontend_id": "menuToggle",
        "label": "Sidebar Menu",
        "category": "navigation",
        "description": (
            "Opens the main sidebar — the full catalog of every layer in NCOP, "
            "organized by category (GIS Layers, Weather Systems, Flood, Air "
            "Quality, Agriculture Monitoring, Ocean/Coastal, Disaster Early "
            "Warning) and subcategory. Layers are toggled on/off from here; "
            "temporal layers (e.g. Meteoblue forecasts) are selected here too. "
            "Includes an in-sidebar search box that filters items by name."
        ),
    },
    {
        "frontend_id": "navToggleBtn",
        "label": "Collapse/Expand Rail",
        "category": "navigation",
        "description": "Collapses the right-side control rail down to just this toggle, or expands it back to show every button.",
    },
    {
        "frontend_id": "userToggle",
        "label": "User Panel",
        "category": "account",
        "description": "Opens the logged-in user's account panel (profile info, logout).",
    },
    {
        "frontend_id": "geocoderToggle",
        "label": "Search Location",
        "category": "navigation",
        "description": "Opens a location search box — type a place name or address to fly the map to it.",
    },
    {
        "frontend_id": "layerOrderToggle",
        "label": "Layer Order",
        "category": "layer-management",
        "description": "Lists every currently-active (toggled-on) layer and lets the operator drag-reorder their stacking order on the map (which layer draws on top of which).",
    },
    {
        "frontend_id": "layerStyleToggle",
        "label": "Layer Style",
        "category": "layer-management",
        "description": "Lets the operator adjust an active layer's visual style — opacity, and other paint properties depending on the layer's geometry type.",
    },
    {
        "frontend_id": "layerInfoToggle",
        "label": "Layer Info",
        "category": "layer-management",
        "description": "Shows metadata about every currently-active layer — source, geometry type, and the same descriptive text shown in the sidebar.",
    },
    {
        "frontend_id": "weatherReportToggle",
        "label": "Weather Report",
        "category": "analysis",
        "description": (
            "Generates a PMD (Pakistan Meteorological Department) weather report for the "
            "current map view or a selected province/district — provincial daily "
            "forecast text, precipitation forecast sampling, and related PMD Monitor "
            "products, assembled into one readable panel."
        ),
    },
    {
        "frontend_id": "splitCompareToggle",
        "label": "Split Compare View",
        "category": "analysis",
        "description": "Splits the map into two side-by-side panes so two different temporal layers (e.g. two different forecast times, or two different datasets) can be visually compared at once, with synced playback controls.",
    },
    {
        "frontend_id": "floodModelToggle",
        "label": "Flash-Flood Early Warning",
        "category": "analysis",
        "description": (
            "A real, on-demand flood model — not a fixed pre-computed layer. Covers "
            "two flood types: flash flood (small basin, local runoff) and riverine "
            "(major river reach). Four modes: fixed HAND (Height Above Nearest "
            "Drainage) threshold susceptibility; rainfall-scenario discharge-driven "
            "(SCS-CN runoff through Manning's equation, giving a spatially-varying "
            "flood stage instead of one uniform cutoff); AHP susceptibility "
            "(literature-weighted overlay of terrain, land cover, soil, rainfall, "
            "NDVI, and connectivity factors into a low/medium/high zone map); and "
            "live gauge-driven riverine flood-fill (a real water-surface elevation, "
            "either from a named PMD/FFD barrage gauge or, for a custom area, a "
            "GeoGLOWS discharge forecast converted via a synthetic rating curve). "
            "The area to model can be a curated catchment (6 flash-flood pilots — "
            "Nullah Lai, Bhudni Nullah, Karachi Urban, Swat-Mingora, Lasbela-Uthal, "
            "Hunza-Karimabad, one real documented small-basin case per major region — "
            "plus 31 real FFD gauge/barrage stations spanning every province along the "
            "Indus, Jhelum, Chenab, Ravi, Sutlej, and Kabul rivers), a polygon drawn "
            "directly on the map, or an uploaded shapefile/GeoJSON/KML file. Every "
            "run reports real computed exposure (buildings, population by age/sex, "
            "roads, drainage, schools, bridges, hospitals, administrative context), "
            "an honest accuracy figure (a calibrated AUC for the curated catchments, "
            "or a live AHP-vs-observed-flood cross-check for a custom area when real "
            "ground truth is nearby), and can be downloaded as a self-contained "
            "GeoJSON file with every attribute attached."
        ),
    },
    {
        "frontend_id": "gisExportToggle",
        "label": "GIS Export",
        "category": "data",
        "description": (
            "Export tab: lists every currently-active NCOP layer and exports each as "
            "the most appropriate GIS format (GeoJSON, GeoTIFF, or a source manifest) "
            "without asking the operator to pick a format. Import tab: drag-and-drop "
            "(or browse) a GeoJSON, zipped Shapefile, or GeoTIFF onto the map, or "
            "connect to an external WMS server and add its layers."
        ),
    },
    {
        "frontend_id": "ncopAssistantToggle",
        "label": "NCOP Assistant",
        "category": "assistant",
        "description": "This chatbot — answers questions about NCOP, its layers, and its documentation using retrieval-augmented generation (RAG) grounded in NCOP's own docs and layer catalog.",
    },
    {
        "frontend_id": "basemapToggle",
        "label": "Basemap",
        "category": "navigation",
        "description": "Switches the underlying map basemap style (e.g. satellite, streets, dark, light).",
    },
    {
        "frontend_id": "ncopTourToggle",
        "label": "NCOP Guided Tour",
        "category": "help",
        "description": "Starts a guided, step-by-step walkthrough of NCOP's own interface for new users.",
    },
    {
        "frontend_id": "projectionSwitch",
        "label": "Map Projections",
        "category": "navigation",
        "description": (
            "Cycles between Mercator (default flat), Globe (spherical), and other "
            "Mapbox map projections. Globe mode gives a Google Earth-style rotating "
            "view, useful for a briefing look."
        ),
    },
    {
        "frontend_id": "toggle3D",
        "label": "3D Toggle",
        "category": "navigation",
        "description": (
            "Switches between a standard flat 2D view and a tilted 3D view with "
            "terrain relief — useful for visualizing mountain flooding, glacial "
            "catchments, and topographic hazard exposure."
        ),
    },
    {
        "frontend_id": "themeToggleBtn",
        "label": "Day/Night Theme Toggle",
        "category": "appearance",
        "description": (
            "Switches the whole NCOP interface between day (light) and night "
            "(dark) theme. Night mode is designed for dark operations rooms and "
            "reduces eye strain during long shifts. Lives at the top-left of the "
            "screen, outside the main right-hand control rail."
        ),
    },
    {
        "frontend_id": "windParticles",
        "label": "Wind Animation",
        "category": "visualization",
        "description": "Toggles an animated wind-particle overlay showing live wind flow direction and speed across the map.",
    },
    {
        "frontend_id": "oceanParticles",
        "label": "Ocean Currents Animation",
        "category": "visualization",
        "description": "Toggles an animated particle overlay showing ocean current flow.",
    },
    {
        "frontend_id": "geoglowsForecast",
        "label": "GeoGLOWS River Forecast",
        "category": "analysis",
        "description": "Opens a panel for looking up GeoGLOWS' simulated river-discharge forecast (streamflow, daily/monthly/annual historical averages) for any river reach, by clicking a location on the map or searching.",
    },
    {
        "frontend_id": "locate",
        "label": "Find My Location",
        "category": "navigation",
        "description": "Centers/zooms the map to the operator's current location (defaults to Islamabad if geolocation is unavailable).",
    },
    {
        "frontend_id": "localNews",
        "label": "Local News Panel",
        "category": "context",
        "description": "Toggles a panel/ticker of recent local news relevant to the current hazard/disaster context.",
    },
    {
        "frontend_id": "geeChat",
        "label": "GEE Data Assistant",
        "category": "assistant",
        "description": (
            "A separate chatbot (Earth Engine Data Assistant) scoped specifically to "
            "creating Google Earth Engine dynamic layers from a natural-language "
            "request — e.g. \"show snow cover in Gilgit Baltistan\". Distinct from the "
            "NCOP Assistant (this one): the GEE assistant creates map layers on "
            "request, the NCOP Assistant answers questions and (in later phases) "
            "navigates the existing UI."
        ),
    },
    {
        "frontend_id": "homeExtent",
        "label": "Zoom to South Asia",
        "category": "navigation",
        "description": "Resets the map view to its home extent, framing Pakistan/South Asia.",
    },
    {
        "frontend_id": "storyBtn",
        "label": "Story Panel",
        "category": "story",
        "description": (
            "Opens NCOP's cinematic Story Mode — narrated, chapter-based hazard "
            "briefings that fly the camera through the map, activating real layers "
            "and reading live data as they go (e.g. the Dynamic Weather Report "
            "story, the Provincial Forecast story)."
        ),
    },
    {
        "frontend_id": "zoomIn",
        "label": "Zoom In",
        "category": "navigation",
        "description": "Zooms the map in one step.",
    },
    {
        "frontend_id": "zoomOut",
        "label": "Zoom Out",
        "category": "navigation",
        "description": "Zooms the map out one step.",
    },
    {
        "frontend_id": "resetBearing",
        "label": "Reset Bearing & Tilt",
        "category": "navigation",
        "description": "Resets the map's compass bearing and pitch back to north-up, flat.",
    },
]
