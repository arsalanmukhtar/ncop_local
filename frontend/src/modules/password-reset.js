// Password Reset Page JavaScript
document.addEventListener('DOMContentLoaded', function() {
    // Auto-focus on email field
    const emailInput = document.getElementById('email');
    if (emailInput) {
        emailInput.focus();
    }
    
    // Email validation
    if (emailInput) {
        emailInput.addEventListener('input', function() {
            const email = emailInput.value;
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            
            // Remove existing validation classes
            emailInput.classList.remove('field-error', 'field-success');
            
            if (email.length > 0) {
                if (emailRegex.test(email)) {
                    emailInput.classList.add('field-success');
                } else {
                    emailInput.classList.add('field-error');
                }
            }
        });
    }
});
