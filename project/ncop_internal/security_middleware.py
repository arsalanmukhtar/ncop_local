from django.utils.deprecation import MiddlewareMixin
from django.http import JsonResponse, HttpResponseForbidden
from django.conf import settings
import time
import logging
import re
from collections import defaultdict

logger = logging.getLogger(__name__)


class RateLimitMiddleware(MiddlewareMixin):
    """
    Rate limiting middleware to prevent API abuse
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.requests = defaultdict(list)
        super().__init__(get_response)

    def process_request(self, request):
        """Process incoming request for rate limiting"""

        # Get client IP
        ip_address = self._get_client_ip(request)

        # Skip rate limiting for static files and admin
        if self._should_skip_rate_limit(request):
            return None

        # Define rate limits (requests per minute)
        rate_limits = {
            "/api/": 60,  # API endpoints: 60 req/min
            "/login/": 10,  # Login: 10 req/min
            "/signup/": 5,  # Signup: 5 req/min
            "/stories/": 30,  # Stories: 30 req/min
            "default": 100,  # Default: 100 req/min
        }

        # Get rate limit for this endpoint
        rate_limit = self._get_rate_limit(request.path, rate_limits)
        current_time = time.time()

        # Clean old requests (older than 1 minute)
        self.requests[ip_address] = [
            req_time
            for req_time in self.requests[ip_address]
            if current_time - req_time < 60
        ]

        # Add current request
        self.requests[ip_address].append(current_time)

        # Check if rate limit exceeded
        if len(self.requests[ip_address]) > rate_limit:
            logger.warning(
                f"Rate limit exceeded for IP: {ip_address} to {request.path}"
            )

            return JsonResponse(
                {
                    "error": "Rate limit exceeded",
                    "message": f"Too many requests. Maximum {rate_limit} requests per minute allowed.",
                    "retry_after": 60,
                },
                status=429,
            )

        return None

    def _get_client_ip(self, request):
        """Get client IP address"""
        x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
        if x_forwarded_for:
            return x_forwarded_for.split(",")[0].strip()

        x_real_ip = request.META.get("HTTP_X_REAL_IP")
        if x_real_ip:
            return x_real_ip

        return request.META.get("REMOTE_ADDR")

    def _should_skip_rate_limit(self, request):
        """Determine if rate limiting should be skipped"""
        skip_paths = ["/static/", "/media/", "/admin/", "/health/"]

        return any(request.path.startswith(path) for path in skip_paths)

    def _get_rate_limit(self, path, rate_limits):
        """Get rate limit for specific path"""
        for pattern, limit in rate_limits.items():
            if path.startswith(pattern):
                return limit
        return rate_limits["default"]


class SecurityHeadersMiddleware(MiddlewareMixin):
    """
    Add security headers to all responses
    """

    def process_response(self, request, response):
        """Add security headers to response"""

        # Security headers
        response["X-Content-Type-Options"] = "nosniff"
        response["X-Frame-Options"] = "DENY"
        response["X-XSS-Protection"] = "1; mode=block"
        response["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https:; "
            "connect-src 'self' https:; "
            "font-src 'self' https:; "
            "object-src 'none'; "
            "media-src 'self' https:; "
            "frame-src 'none'"
        )

        # Remove server information
        response.pop("Server", None)
        response["X-Powered-By"] = "NCOP Platform"

        return response


class InputValidationMiddleware(MiddlewareMixin):
    """
    Validate and sanitize input parameters
    """

    def process_request(self, request):
        """Validate and sanitize request data"""

        # Skip validation for file uploads and static files
        if self._should_skip_validation(request):
            return None

        # Validate GET parameters
        if request.method == "GET":
            if self._validate_get_params(request):
                return None
            else:
                return JsonResponse(
                    {
                        "error": "Invalid parameters",
                        "message": "One or more parameters contain invalid data",
                    },
                    status=400,
                )

        # Validate POST data
        if request.method == "POST":
            if self._validate_post_data(request):
                return None
            else:
                return JsonResponse(
                    {
                        "error": "Invalid data",
                        "message": "Request body contains invalid data",
                    },
                    status=400,
                )

        return None

    def _should_skip_validation(self, request):
        """Determine if validation should be skipped"""
        skip_paths = ["/admin/", "/static/", "/media/"]

        return any(request.path.startswith(path) for path in skip_paths)

    def _validate_get_params(self, request):
        """Validate GET parameters"""
        dangerous_patterns = [
            r"<script[^>]*>.*?</script>",
            r"javascript:",
            r"on\w+\s*=",  # onclick, onload, etc.
            r"expression\s*\(",
            r"vbscript:",
            r"data:text/html",
            r"\.\./",  # Path traversal attempt
            r"\.\.\\",  # Windows path traversal
        ]

        for param_name, param_value in request.GET.items():
            if isinstance(param_value, str):
                for pattern in dangerous_patterns:
                    if re.search(pattern, param_value, re.IGNORECASE):
                        logger.warning(
                            f"Potential XSS/Injection in parameter {param_name}: {param_value}"
                        )
                        return False
        return True

    def _validate_post_data(self, request):
        """Validate POST data"""
        if hasattr(request, "body") and request.body:
            try:
                import json

                data = json.loads(request.body.decode("utf-8"))
                return self._validate_json_data(data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                return False

        return True

    def _validate_json_data(self, data):
        """Validate JSON data structure"""
        if not isinstance(data, (dict, list)):
            return False

        # Check for deeply nested objects (potential DoS)
        max_depth = 10

        def get_depth(obj, current_depth=0):
            if isinstance(obj, dict):
                if current_depth >= max_depth:
                    return current_depth
                return (
                    max(get_depth(v, current_depth + 1) for v in obj.values())
                    if obj
                    else 0
                )
            elif isinstance(obj, list):
                if current_depth >= max_depth:
                    return current_depth
                return (
                    max(get_depth(item, current_depth + 1) for item in obj)
                    if obj
                    else 0
                )
            else:
                return current_depth

        if get_depth(data) > max_depth:
            logger.warning("Potential DoS attack: deeply nested JSON object")
            return False

        # Check JSON size (prevent large payloads)
        import sys

        json_size = sys.getsizeof(data)
        max_size = 10 * 1024 * 1024  # 10MB

        if json_size > max_size:
            logger.warning(f"Large JSON payload detected: {json_size} bytes")
            return False

        return True


class AuditLoggingMiddleware(MiddlewareMixin):
    """
    Log important security events and access patterns
    """

    def process_request(self, request):
        """Log request details for audit trail"""

        # Skip logging for static files and health checks
        if self._should_skip_logging(request):
            return None

        ip_address = self._get_client_ip(request)
        user_agent = request.META.get("HTTP_USER_AGENT", "Unknown")

        # Log suspicious patterns
        suspicious_patterns = ["sqlmap", "nmap", "nikto", "burp", "dirb", "gobuster"]

        is_suspicious = any(
            pattern.lower() in user_agent.lower() for pattern in suspicious_patterns
        )

        if is_suspicious:
            logger.warning(
                f"Suspicious user agent detected: {user_agent} from IP: {ip_address}"
            )

        # Log authentication attempts
        if request.path in ["/login/", "/signup/"]:
            log_level = "INFO"
            if is_suspicious:
                log_level = "WARNING"

            logger.log(
                log_level,
                f"Auth attempt to {request.path} from {ip_address} - {user_agent}",
            )

        # Log API access
        if request.path.startswith("/api/"):
            logger.info(
                f"API access: {request.method} {request.path} from {ip_address}"
            )

        return None

    def _should_skip_logging(self, request):
        """Determine if logging should be skipped"""
        skip_paths = ["/static/", "/media/", "/favicon.ico", "/health/", "/robots.txt"]

        return any(
            request.path == path or request.path.startswith(path) for path in skip_paths
        )

    def _get_client_ip(self, request):
        """Get client IP address"""
        x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
        if x_forwarded_for:
            return x_forwarded_for.split(",")[0].strip()

        x_real_ip = request.META.get("HTTP_X_REAL_IP")
        if x_real_ip:
            return x_real_ip

        return request.META.get("REMOTE_ADDR")


class APIThrottlingMiddleware(MiddlewareMixin):
    """
    Throttle API calls based on user tier and endpoint type
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.api_calls = defaultdict(list)
        super().__init__(get_response)

    def process_request(self, request):
        """Throttle API calls based on user and endpoint"""

        if not request.path.startswith("/api/"):
            return None

        # Get user from request (if authenticated)
        user = getattr(request, "user", None)

        # Define API limits based on user role
        api_limits = {
            "viewer": {"per_minute": 100, "per_hour": 1000, "per_day": 10000},
            "analyst": {"per_minute": 200, "per_hour": 2000, "per_day": 20000},
            "manager": {"per_minute": 500, "per_hour": 5000, "per_day": 50000},
            "admin": {"per_minute": 1000, "per_hour": 10000, "per_day": 100000},
            "anonymous": {"per_minute": 30, "per_hour": 300, "per_day": 1000},
        }

        user_role = "anonymous"
        if user and hasattr(user, "profile"):
            user_role = user.profile.role

        limits = api_limits.get(user_role, api_limits["anonymous"])
        current_time = time.time()

        # Get or create user API call tracking
        key = f"{user.id if user else 'anonymous'}_{request.path}"

        # Clean old calls (older than 1 minute for per-minute check)
        self.api_calls[key] = [
            call_time
            for call_time in self.api_calls[key]
            if current_time - call_time < 60
        ]

        # Add current call
        self.api_calls[key].append(current_time)

        # Check limits
        if len(self.api_calls[key]) > limits["per_minute"]:
            logger.warning(
                f"API rate limit exceeded for user {user_role}: {request.path}"
            )

            return JsonResponse(
                {
                    "error": "API rate limit exceeded",
                    "message": f"Rate limit exceeded. Maximum {limits['per_minute']} API calls per minute allowed for {user_role} users.",
                    "retry_after": 60,
                    "limits": limits,
                },
                status=429,
            )

        return None
