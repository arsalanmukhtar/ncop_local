"""
WSGI config for ncop_project staging environment.

This is the entry point for Waitress when serving the staging environment.
Exposes the WSGI callable as a module-level variable named ``application``.

Usage:
    waitress-serve --port=8080 --host=127.0.0.1 ncop_project.wsgi_staging:application

For more information on WSGI:
    https://docs.djangoproject.com/en/5.1/howto/deployment/wsgi/
"""

import os
from django.core.wsgi import get_wsgi_application

# Point to the staging settings module
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'ncop_project.settings.staging')

application = get_wsgi_application()