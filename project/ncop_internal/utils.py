# ncop_internal/utils.py
import base64
import hashlib
import hmac
import json
import time

from django.conf import settings


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode())


def build_auto_login_token(username: str) -> str:
    now = int(time.time())
    payload = {"u": username, "iat": now}

    payload_b = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    payload_s = _b64url_encode(payload_b)

    secret = settings.AUTO_LOGIN_TOKEN_SECRET.encode()
    sig = hmac.new(secret, payload_s.encode(), hashlib.sha256).digest()
    sig_s = _b64url_encode(sig)

    return f"{payload_s}.{sig_s}"


def verify_auto_login_token(token: str) -> dict:
    try:
        payload_s, sig_s = token.split(".", 1)
    except ValueError:
        raise ValueError("Invalid token format")

    secret = settings.AUTO_LOGIN_TOKEN_SECRET.encode()
    expected_sig = hmac.new(secret, payload_s.encode(), hashlib.sha256).digest()
    expected_sig_s = _b64url_encode(expected_sig)

    # constant-time compare
    if not hmac.compare_digest(expected_sig_s, sig_s):
        raise ValueError("Invalid token signature")

    payload = json.loads(_b64url_decode(payload_s).decode())

    max_age = int(getattr(settings, "AUTO_LOGIN_TOKEN_MAX_AGE", 60))
    iat = int(payload.get("iat", 0))
    now = int(time.time())
    if now - iat > max_age:
        raise ValueError("Token expired")

    return payload

generate_auto_login_token = build_auto_login_token