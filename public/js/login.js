const API_BASE = window.location.origin;

document.addEventListener('DOMContentLoaded', async () => {
    const form = document.getElementById('login-form');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const errorEl = document.getElementById('login-error');
    const loginBtn = document.getElementById('btn-login');

    // If already authenticated, redirect to dashboard.
    try {
        const meRes = await fetch(`${API_BASE}/api/auth/me`);
        if (meRes.ok) {
            window.location.href = '/';
            return;
        }
    } catch (err) {
        // ignore and allow login attempt
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorEl.textContent = '';
        loginBtn.disabled = true;
        loginBtn.textContent = 'AUTHENTICATING...';

        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: emailInput.value.trim(),
                    password: passwordInput.value
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Login failed');
            }
            window.location.href = '/';
        } catch (err) {
            errorEl.textContent = err.message;
            passwordInput.value = '';
        } finally {
            loginBtn.disabled = false;
            loginBtn.textContent = 'LOGIN';
        }
    });
});
