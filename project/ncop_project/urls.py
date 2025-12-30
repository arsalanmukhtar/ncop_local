# Add this to your main urls.py file (ncop_project/urls.py)
# 
# Import at the top:
# from django.urls import path, include
#
# Add to urlpatterns:
# path('', include('pwa.urls')),  # PWA routes
#
# Full example:

from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from django.views.generic import TemplateView

urlpatterns = [
    # Admin
    path('admin/', admin.site.urls),
    
    # PWA URLs - Add this line
    path("", include(("pwa.urls", "pwa"), namespace="pwa")),
    
    # Offline page - Custom offline view
    path('offline/', TemplateView.as_view(template_name='pwa/offline.html'), name='offline'),
    
    # Your existing app URLs
    path('', include('ncop_internal.urls')),
    
    # Add other URL patterns here
]

# Serve static and media files in development
if settings.DEBUG:
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)