// ── Shared utilities ──────────────────────────────────────────────────────────

const API = {
  async request(method, path, body) {
    const token = localStorage.getItem('gbm_token') || '';
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    if (res.status === 401) {
      localStorage.removeItem('gbm_token');
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },
  get: (path) => API.request('GET', path),
  post: (path, body) => API.request('POST', path, body),
  put: (path, body) => API.request('PUT', path, body),
  delete: (path) => API.request('DELETE', path),
};

// ── Toast Notifications ───────────────────────────────────────────────────────

function showToast(message, type = 'default') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ── Auth guard ────────────────────────────────────────────────────────────────

// Paths that are public and must never trigger a login redirect
const PUBLIC_PATHS = ['/', '/landing.html', '/login.html', '/approve.html', '/payment-success.html'];

function requireAuth() {
  if (!localStorage.getItem('gbm_token') && !PUBLIC_PATHS.includes(window.location.pathname)) {
    window.location.href = '/login.html';
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt$$(n) {
  return '$' + (parseFloat(n) || 0).toFixed(2);
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(str + (str.includes('T') ? '' : 'T12:00:00'));
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDateTime(str) {
  if (!str) return '—';
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" with no Z — treat as UTC
  const utcStr = (str.includes('Z') || str.includes('+')) ? str : str.replace(' ', 'T') + 'Z';
  return new Date(utcStr).toLocaleString('en-US', {
    timeZone: 'America/Denver',
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function fmtPhone(p) {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

function loadSize(s) {
  const map = { quarter: '¼ Load', half: '½ Load', three_quarter: '¾ Load', full: 'Full Load' };
  return map[s] || s || '?';
}

function statusBadge(status) {
  return `<span class="badge badge-${status?.replace('_','-') || 'pending'}">${status?.replace(/_/g,' ') || 'unknown'}</span>`;
}

// ── Active nav link ───────────────────────────────────────────────────────────

function setActiveNav() {
  const page = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.getAttribute('href') === page || (page === 'index.html' && a.getAttribute('href') === 'index.html')) {
      a.classList.add('active');
    }
  });
}

// ── Update pending badge in nav ───────────────────────────────────────────────

async function updateNavBadges() {
  try {
    const stats = await API.get('/api/dashboard/stats');
    const badge = document.getElementById('pending-badge');
    if (badge && stats.pending_review > 0) {
      badge.textContent = stats.pending_review;
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  requireAuth();
  setActiveNav();
  updateNavBadges();
});
