from django.conf import settings
from django.contrib import messages
from django.contrib.auth import authenticate, login, logout, get_user_model
from django.contrib.auth.decorators import login_required
from django.contrib.auth.tokens import default_token_generator
from django.core.mail import send_mail
from django.shortcuts import render, redirect
from django.urls import reverse
from django.utils.encoding import force_str
from django.utils.http import urlsafe_base64_decode, urlsafe_base64_encode
from django.utils.translation import gettext as _
import os

User = get_user_model()


@login_required(login_url="login")
@login_required(login_url="login")
def dashboard_view(request):
    return render(request, "dashboard.html", {
        "mapbox_token": settings.MAPBOX_ACCESS_TOKEN
    })


def login_view(request):
    if request.user.is_authenticated:
        return redirect("dashboard")

    if request.method == "POST":
        username = request.POST.get("username", "").strip()
        password = request.POST.get("password", "")
        user = authenticate(request, username=username, password=password)
        if user is not None:
            login(request, user)
            return redirect("dashboard")
        messages.error(request, _("Invalid username or password."))
    return render(request, "auth/login.html")


def signup_view(request):
    if request.user.is_authenticated:
        return redirect("dashboard")

    if request.method == "POST":
        first_name = request.POST.get("first_name", "").strip()
        last_name = request.POST.get("last_name", "").strip()
        username = request.POST.get("username", "").strip()
        email = request.POST.get("email", "").strip().lower()
        password1 = request.POST.get("password1", "")
        password2 = request.POST.get("password2", "")

        if not username or not email or not password1:
            messages.error(request, _("Please fill all required fields."))
            return render(request, "auth/signup.html")

        if password1 != password2:
            messages.error(request, _("Passwords do not match."))
            return render(request, "auth/signup.html")

        if User.objects.filter(username=username).exists():
            messages.error(request, _("Username already taken."))
            return render(request, "auth/signup.html")

        if User.objects.filter(email=email).exists():
            messages.error(request, _("Email already in use."))
            return render(request, "auth/signup.html")

        user = User.objects.create_user(
            username=username,
            email=email,
            password=password1,
            first_name=first_name,
            last_name=last_name,
        )
        login(request, user)
        messages.success(request, _("Account created successfully."))
        return redirect("dashboard")

    return render(request, "auth/signup.html")


def logout_view(request):
    logout(request)
    messages.success(request, _("You have been logged out."))
    return redirect("login")


def password_reset_view(request):
    """
    Sends a password reset link using Django's token generator.
    In dev, set EMAIL_BACKEND='django.core.mail.backends.console.EmailBackend'
    to print emails to console.
    """
    if request.method == "POST":
        email = request.POST.get("email", "").strip().lower()
        if not email:
            messages.error(request, _("Please enter your email address."))
            return render(request, "auth/password_reset.html")

        try:
            user = User.objects.get(email=email)
        except User.DoesNotExist:
            # Don't reveal whether the email exists
            messages.success(request, _("If that email exists, a reset link has been sent."))
            return redirect("password_reset")

        uid = urlsafe_base64_encode(str(user.pk).encode())
        token = default_token_generator.make_token(user)
        reset_url = request.build_absolute_uri(
            reverse("password_reset_confirm", kwargs={"uidb64": uid, "token": token})
        )

        subject = _("Reset your NCOP password")
        message = _(
            "Hello {name},\n\n"
            "Use the link below to set a new password:\n{url}\n\n"
            "If you didn't request this, you can ignore this email."
        ).format(name=user.get_full_name() or user.username, url=reset_url)

        send_mail(
            subject,
            message,
            getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@ncop.local"),
            [email],
            fail_silently=True,
        )

        messages.success(request, _("If that email exists, a reset link has been sent."))
        return redirect("password_reset")

    return render(request, "auth/password_reset.html")


def password_reset_confirm_view(request, uidb64, token):
    """
    Confirms the token and lets the user set a new password.
    Template uses fields: password1, password2 (matching your HTML).
    """
    try:
        uid = force_str(urlsafe_base64_decode(uidb64))
        user = User.objects.get(pk=uid)
    except Exception:
        user = None

    if user is None or not default_token_generator.check_token(user, token):
        messages.error(request, _("Invalid or expired reset link."))
        return redirect("password_reset")

    if request.method == "POST":
        pwd1 = request.POST.get("password1", "")
        pwd2 = request.POST.get("password2", "")
        if not pwd1 or not pwd2:
            messages.error(request, _("Please enter your new password twice."))
            return render(request, "auth/password_reset_confirm.html")

        if pwd1 != pwd2:
            messages.error(request, _("Passwords do not match."))
            return render(request, "auth/password_reset_confirm.html")

        user.set_password(pwd1)
        user.save()
        messages.success(request, _("Your password has been reset. Please log in."))
        return redirect("login")

    return render(request, "auth/password_reset_confirm.html")
