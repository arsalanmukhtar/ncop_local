"""
Middleware for mobile app token authentication
"""

from django.conf import settings
from django.http import JsonResponse
from django.utils.deprecation import MiddlewareMixin
import logging

logger = logging.getLogger(__name__)


class MobileAppTokenMiddleware(MiddlewareMixin):
    """
    Middleware to validate mobile app token parameter for production
    Only active when MOBILE_APP_TOKEN_VALUE is configured
    """

    def process_request(self, request):
        # Only enforce in production with mobile token configured
        if not hasattr(settings, 'MOBILE_APP_TOKEN_VALUE'):
            return None
        
        if not settings.MOBILE_APP_TOKEN_VALUE:
            return None

        # Skip for static, media, admin, manifest, favicon - be very permissive
        skip_paths = (
            '/static/',
            '/media/',
            '/admin/',
            '/manifest.json',
            '/favicon.ico',
            '/__debug__/',
        )
        
        if request.path.startswith(skip_paths):
            return None
        
        # Skip if user is already authenticated
        if request.user.is_authenticated:
            return None

        # Get token parameter name (default 'p')
        token_param = getattr(settings, 'MOBILE_APP_TOKEN_PARAM', 'p')
        
        # Check if token is present and valid
        provided_token = request.GET.get(token_param)
        
        if provided_token != settings.MOBILE_APP_TOKEN_VALUE:
            logger.warning(f"Invalid mobile app token attempt from {request.META.get('REMOTE_ADDR')} for path {request.path}")
            return JsonResponse({
                'error': 'Invalid or missing authentication token',
                'message': 'Please use the official mobile application to access this service'
            }, status=403)
        
        return None