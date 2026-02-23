"""
ncop_vite template tags — drop-in replacements for django_vite's
vite_hmr_client and vite_asset tags.

Problem solved:
    django_vite hardcodes VITE_DEV_SERVER_HOST (e.g. 172.18.7.39) into
    every generated <script> URL at startup time.  When users reach the app
    via a different IP (e.g. the public IP 182.188.28.163) their browser
    cannot reach the internal host and assets fail to load.

Solution:
    These tags read the host from the incoming HTTP request and substitute
    it into the Vite URL so the browser always receives asset URLs that
    point to the same IP it used to reach Django.  In production (dev_mode
    is False) they fall back to the standard django_vite behaviour.

Usage (drop-in replacement in every template):
    {% load ncop_vite %}          ← instead of {% load django_vite %}
    {% vite_hmr_client %}
    {% vite_asset 'src/entries/dashboard_main.js' %}
"""

from urllib.parse import urljoin

from django import template
from django.conf import settings
from django.utils.safestring import mark_safe

register = template.Library()


def _is_dev_mode():
    return settings.DJANGO_VITE.get("default", {}).get("dev_mode", False)


def _build_dev_url(request, path):
    """
    Replicate DjangoViteAppClient._get_dev_server_url() but substitute the
    request host so the URL is reachable from whichever IP the browser used.
    """
    vite_cfg = settings.DJANGO_VITE.get("default", {})
    protocol = vite_cfg.get("dev_server_protocol", "http")
    port = vite_cfg.get("dev_server_port", 5173)
    static_url_prefix = vite_cfg.get("static_url_prefix", "")

    # Use the hostname portion only (drop any port django may have appended)
    host = request.get_host().split(":")[0]

    static_url_base = urljoin(settings.STATIC_URL, static_url_prefix)
    if not static_url_base.endswith("/"):
        static_url_base += "/"

    return urljoin(
        f"{protocol}://{host}:{port}",
        urljoin(static_url_base, path),
    )


@register.simple_tag(takes_context=True)
def vite_hmr_client(context, app="default", **kwargs):
    """
    Drop-in for {% vite_hmr_client %}.
    In dev mode uses the request host; in production returns "".
    """
    if not _is_dev_mode():
        return mark_safe("")

    request = context.get("request")
    if not request:
        # Fallback: let the standard loader handle it
        from django_vite.core.asset_loader import DjangoViteAssetLoader
        return mark_safe(DjangoViteAssetLoader.instance().generate_vite_ws_client(app, **kwargs))

    url = _build_dev_url(request, "@vite/client")
    extra = "".join(f' {k}="{v}"' for k, v in kwargs.items())
    return mark_safe(f'<script type="module" src="{url}"{extra}></script>')


@register.simple_tag(takes_context=True)
def vite_asset(context, path, app="default", **kwargs):
    """
    Drop-in for {% vite_asset 'path/to/entry.js' %}.
    In dev mode uses the request host; in production delegates to the
    standard django_vite loader (manifest lookup, CSS links, preloads).
    """
    assert path is not None

    if not _is_dev_mode():
        from django_vite.core.asset_loader import DjangoViteAssetLoader
        return mark_safe(DjangoViteAssetLoader.instance().generate_vite_asset(path, app, **kwargs))

    request = context.get("request")
    if not request:
        from django_vite.core.asset_loader import DjangoViteAssetLoader
        return mark_safe(DjangoViteAssetLoader.instance().generate_vite_asset(path, app, **kwargs))

    url = _build_dev_url(request, path)
    extra = "".join(f' {k}="{v}"' for k, v in kwargs.items())
    return mark_safe(f'<script type="module" src="{url}"{extra}></script>')
