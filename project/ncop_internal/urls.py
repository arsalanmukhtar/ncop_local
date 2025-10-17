from django.urls import path
from . import views

urlpatterns = [
    path("", views.dashboard_view, name="dashboard"),

    path("login/", views.login_view, name="login"),
    path("signup/", views.signup_view, name="signup"),
    path("logout/", views.logout_view, name="logout"),

    path("password-reset/", views.password_reset_view, name="password_reset"),
    path(
        "password-reset-confirm/<uidb64>/<token>/",
        views.password_reset_confirm_view,
        name="password_reset_confirm",
    ),
]
