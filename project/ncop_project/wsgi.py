"""
WSGI entry point for ncop_project.

Exposes the WSGI callable as a module-level variable named ``application``.

The settings module is taken from the ``DJANGO_SETTINGS_MODULE`` environment
variable and falls back to ``ncop_project.settings.prod`` — the safe default
for any deploy that reaches this file (dev uses ``manage.py``, staging uses
``wsgi_staging.py``).
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "ncop_project.settings.prod")

application = get_wsgi_application()
