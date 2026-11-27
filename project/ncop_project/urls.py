"""Top-level URL configuration for ncop_project.

All application URLs live in ``ncop_internal.urls``; this file only composes
the admin site, the app mount, and static/media passthroughs.
"""

import re
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve as _serve_media

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("ncop_internal.urls")),
]

# ---- /media/  — served in EVERY environment ------------------------------
# STATIC is handled by WhiteNoise middleware in prod / staging (see
# STORAGES + MIDDLEWARE in settings/base.py), but WhiteNoise only knows
# about STATIC_ROOT — it never serves MEDIA.  Runtime-generated files under
# MEDIA_ROOT (currently: the PMD Predictions PNG cache under
# `MEDIA_ROOT/pmd_predictions/`) therefore 404'd on staging (waitress with
# DEBUG=False) and would 404 on prod too unless nginx picks up `/media/`
# with an `alias` rule.  Registering `django.views.static.serve` here as
# a permanent fallback means:
#   * dev (runserver): Django serves it → works.
#   * staging (waitress only, DEBUG=False): Django serves it → works.
#   * prod (nginx + waitress): if nginx has  `location /media/ { alias …; }`
#     the request never reaches Django (fast path).  If nginx doesn't have
#     the rule, Django serves as fallback → nothing 404s.
# `serve` only reads files under `document_root` — no directory traversal.
_media_prefix = re.escape(settings.MEDIA_URL.lstrip("/"))
urlpatterns += [
    re_path(
        rf"^{_media_prefix}(?P<path>.*)$",
        _serve_media,
        {"document_root": settings.MEDIA_ROOT},
    ),
]

if settings.DEBUG:
    # Static passthrough is still DEBUG-only — WhiteNoise handles this in
    # non-DEBUG environments.  MEDIA is registered unconditionally above.
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
