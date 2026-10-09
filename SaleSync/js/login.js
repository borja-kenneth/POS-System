const API_BASE = "api/index.php";

async function api(path, options = {}) {
  const cleanPath = String(path).replace(/^\/+/, '');
  const response = await fetch(`${API_BASE}?route=${encodeURIComponent(cleanPath)}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || data.detail || `Request failed (${response.status})`);
  return data;
}

const form = document.getElementById('loginForm');
const errorBox = document.getElementById('loginError');
const btn = document.getElementById('loginBtn');
const pw = document.getElementById('password');
const toggle = document.getElementById('pwToggle');

function showMessage(msg, note = false) {
  errorBox.textContent = msg;
  errorBox.classList.toggle('note', note);
  errorBox.hidden = !msg;
}

function goToApp(user) {
  location.replace('index.html#' + (user.role_name === 'ADMIN' ? 'dashboard' : 'checkout'));
}

toggle.addEventListener('click', () => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  toggle.classList.toggle('shown', show);
  toggle.setAttribute('aria-pressed', String(show));
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  pw.focus();
});

document.querySelectorAll('.demo button').forEach(b => b.addEventListener('click', () => {
  document.getElementById('username').value = b.dataset.u;
  pw.value = b.dataset.p;
  showMessage('');
}));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = pw.value;
  if (!username || !password) { showMessage('Please enter your username and password.'); return; }
  if (window.LOGIN_PREVIEW) { showMessage('Preview only. In the real app, signing in opens the dashboard (admin) or checkout (cashier).', true); return; }
  btn.disabled = true; btn.textContent = 'Signing in…'; showMessage('');
  try {
    const result = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    goToApp(result.user);
  } catch (err) {
    showMessage(err.message);
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});

(async function init() {
  if (window.LOGIN_PREVIEW) return;
  try {
    const me = await api('/me');
    if (me.authenticated) goToApp(me.user);
  } catch (_) {
    showMessage('Could not reach the POS server. Start Apache and MySQL in XAMPP, then refresh this page.');
  }
})();
