// Login Page JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Toggle password visibility
    const togglePassword = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');
    
    if (togglePassword && passwordInput) {
        let isPasswordVisible = false;
        
        togglePassword.addEventListener('click', function() {
            // Toggle password type
            if (isPasswordVisible) {
                passwordInput.type = 'password';
                isPasswordVisible = false;
            } else {
                passwordInput.type = 'text';
                isPasswordVisible = true;
            }
            
            // Update icon by getting fresh reference each time
            const eyeIcon = document.getElementById('eyeIcon');
            if (eyeIcon) {
                // Remove old icon
                eyeIcon.remove();
                
                // Create new icon
                const newIcon = document.createElement('i');
                newIcon.setAttribute('data-lucide', isPasswordVisible ? 'eye-off' : 'eye');
                newIcon.setAttribute('id', 'eyeIcon');
                newIcon.className = 'h-4 w-4';
                
                // Add to button
                togglePassword.appendChild(newIcon);
                
                // Reinitialize lucide icons
                lucide.createIcons();
            }
        });
    }
    
    // Auto-focus on username field
    const usernameInput = document.getElementById('username');
    if (usernameInput) {
        usernameInput.focus();
    }
});
