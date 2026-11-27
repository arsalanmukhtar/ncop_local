"""
ASGI entry point for ncop_project.

Exposes the ASGI callable as a module-level variable named ``application``.

The settings module is taken from the ``DJANGO_SETTINGS_MODULE`` environment
variable and falls back to ``ncop_project.settings.prod``.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "ncop_project.settings.prod")

application = get_asgi_application()
