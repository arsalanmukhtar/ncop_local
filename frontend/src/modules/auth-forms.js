// Consolidated auth page behaviors: shared base (lucide + alert dismiss),
// login page (single password toggle + focus), signup page (dual password
// toggle + strength/match validation + focus), password-reset page (email
// regex validation + focus).
//
// Every handler is guarded by `if (element)` so it is safe to side-effect
// this file on all auth pages — only the handlers whose elements exist on
// the current page attach listeners.

document.addEventListener("DOMContentLoaded", function () {
    // ---------------------------------------------------------------
    // Shared base: initialize Lucide icons + auto-dismiss flash alerts
    // ---------------------------------------------------------------
    lucide.createIcons();

    const alerts = document.querySelectorAll(".alert-message");
    alerts.forEach(function (alert) {
        setTimeout(function () {
            alert.style.opacity = "0";
            setTimeout(function () {
                alert.remove();
            }, 500);
        }, 3000);
    });

    // ---------------------------------------------------------------
    // Helper: wire a single password visibility toggle button
    // ---------------------------------------------------------------
    function wirePasswordToggle(toggleId, inputId, iconId) {
        const toggleBtn = document.getElementById(toggleId);
        const input = document.getElementById(inputId);
        if (!toggleBtn || !input) return;

        let isVisible = false;

        toggleBtn.addEventListener("click", function () {
            if (isVisible) {
                input.type = "password";
                isVisible = false;
            } else {
                input.type = "text";
                isVisible = true;
            }

            const oldIcon = document.getElementById(iconId);
            if (oldIcon) {
                oldIcon.remove();

                const newIcon = document.createElement("i");
                newIcon.setAttribute("data-lucide", isVisible ? "eye-off" : "eye");
                newIcon.setAttribute("id", iconId);
                newIcon.className = "h-4 w-4";

                toggleBtn.appendChild(newIcon);
                lucide.createIcons();
            }
        });
    }

    // ---------------------------------------------------------------
    // Login page: single password toggle
    // ---------------------------------------------------------------
    wirePasswordToggle("togglePassword", "password", "eyeIcon");

    // ---------------------------------------------------------------
    // Signup page: two password toggles + strength/match validation
    // ---------------------------------------------------------------
    wirePasswordToggle("togglePassword1", "password1", "eyeIcon1");
    wirePasswordToggle("togglePassword2", "password2", "eyeIcon2");

    const password1Input = document.getElementById("password1");
    const password2Input = document.getElementById("password2");

    if (password1Input && password2Input) {
        function validatePasswords() {
            const password1 = password1Input.value;
            const password2 = password2Input.value;

            password1Input.classList.remove("field-error", "field-success");
            password2Input.classList.remove("field-error", "field-success");

            if (password1.length >= 8) {
                password1Input.classList.add("field-success");
            } else if (password1.length > 0) {
                password1Input.classList.add("field-error");
            }

            if (password2.length > 0) {
                if (password1 === password2 && password1.length >= 8) {
                    password2Input.classList.add("field-success");
                } else {
                    password2Input.classList.add("field-error");
                }
            }
        }

        password1Input.addEventListener("input", validatePasswords);
        password2Input.addEventListener("input", validatePasswords);
    }

    // ---------------------------------------------------------------
    // Password reset page: email regex validation
    // ---------------------------------------------------------------
    const emailInput = document.getElementById("email");
    if (emailInput) {
        emailInput.addEventListener("input", function () {
            const email = emailInput.value;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

            emailInput.classList.remove("field-error", "field-success");

            if (email.length > 0) {
                if (emailRegex.test(email)) {
                    emailInput.classList.add("field-success");
                } else {
                    emailInput.classList.add("field-error");
                }
            }
        });
    }

    // ---------------------------------------------------------------
    // Auto-focus: prefer username (login/signup), fall back to email (reset).
    // Whichever input the current page renders wins.
    // ---------------------------------------------------------------
    const usernameInput = document.getElementById("username");
    if (usernameInput) {
        usernameInput.focus();
    } else if (emailInput) {
        emailInput.focus();
    }
});
