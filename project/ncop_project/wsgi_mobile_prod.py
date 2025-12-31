"""
WSGI config for NCOP Project - Mobile Production
"""

import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'ncop_project.settings.mobile_prod')

application = get_wsgi_application()