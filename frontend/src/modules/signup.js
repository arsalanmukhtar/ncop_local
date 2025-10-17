// Signup Page JavaScript
document.addEventListener('DOMContentLoaded', function() {    // Toggle password visibility for both password fields
    const togglePassword1 = document.getElementById('togglePassword1');
    const togglePassword2 = document.getElementById('togglePassword2');
    const passwordInput1 = document.getElementById('password1');
    const passwordInput2 = document.getElementById('password2');
    
    if (togglePassword1 && passwordInput1) {
        let isPassword1Visible = false;
        
        togglePassword1.addEventListener('click', function() {
            if (isPassword1Visible) {
                passwordInput1.type = 'password';
                isPassword1Visible = false;
            } else {
                passwordInput1.type = 'text';
                isPassword1Visible = true;
            }
            
            const eyeIcon1 = document.getElementById('eyeIcon1');
            if (eyeIcon1) {
                eyeIcon1.remove();
                
                const newIcon = document.createElement('i');
                newIcon.setAttribute('data-lucide', isPassword1Visible ? 'eye-off' : 'eye');
                newIcon.setAttribute('id', 'eyeIcon1');
                newIcon.className = 'h-4 w-4';
                
                togglePassword1.appendChild(newIcon);
                lucide.createIcons();
            }
        });
    }
    
    if (togglePassword2 && passwordInput2) {
        let isPassword2Visible = false;
        
        togglePassword2.addEventListener('click', function() {
            if (isPassword2Visible) {
                passwordInput2.type = 'password';
                isPassword2Visible = false;
            } else {
                passwordInput2.type = 'text';
                isPassword2Visible = true;
            }
            
            const eyeIcon2 = document.getElementById('eyeIcon2');
            if (eyeIcon2) {
                eyeIcon2.remove();
                
                const newIcon = document.createElement('i');
                newIcon.setAttribute('data-lucide', isPassword2Visible ? 'eye-off' : 'eye');
                newIcon.setAttribute('id', 'eyeIcon2');
                newIcon.className = 'h-4 w-4';
                
                togglePassword2.appendChild(newIcon);
                lucide.createIcons();
            }
        });
    }
    
    // Auto-focus on username field
    const usernameInput = document.getElementById('username');
    if (usernameInput) {
        usernameInput.focus();
    }
    
    // Password strength validation
    const password1Input = document.getElementById('password1');
    const password2Input = document.getElementById('password2');
    
    if (password1Input && password2Input) {
        function validatePasswords() {
            const password1 = password1Input.value;
            const password2 = password2Input.value;
            
            // Remove existing validation classes
            password1Input.classList.remove('field-error', 'field-success');
            password2Input.classList.remove('field-error', 'field-success');
            
            // Validate password strength
            if (password1.length >= 8) {
                password1Input.classList.add('field-success');
            } else if (password1.length > 0) {
                password1Input.classList.add('field-error');
            }
            
            // Validate password match
            if (password2.length > 0) {
                if (password1 === password2 && password1.length >= 8) {
                    password2Input.classList.add('field-success');
                } else {
                    password2Input.classList.add('field-error');
                }
            }
        }
        
        password1Input.addEventListener('input', validatePasswords);
        password2Input.addEventListener('input', validatePasswords);
    }
});
