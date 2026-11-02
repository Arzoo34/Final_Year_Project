// ============================================================
//  MineGuard Pro — api.js
//  Backend API + WebSocket client
// ============================================================

'use strict';

const _host = window.location.hostname;
const _isLocalDev = !_host || _host === 'localhost' || _host === '127.0.0.1';

/** Live Server / Vite etc. — page is not served by SafeMine; API stays on default backend port. */
const _STATIC_DEV_PORTS = new Set(['5500', '5501', '8080', '5173', '4173', '1234', '4200']);

function resolveLocalBackendOrigin() {
  if (window.location.protocol === 'file:') {
    return 'http://127.0.0.1:3001';
  }
  if (!_isLocalDev) return window.location.origin;
  const port = window.location.port;
  if (port && _STATIC_DEV_PORTS.has(port)) {
    return 'http://127.0.0.1:3001';
  }
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin;
  }
  return 'http://127.0.0.1:3001';
}

function originToWs(origin) {
  try {
    const u = new URL(origin);
    const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${u.host}`;
  } catch {
    return 'ws://127.0.0.1:3001';
  }
}

const _backendOrigin = resolveLocalBackendOrigin();
const API_BASE = _isLocalDev ? `${_backendOrigin}/api` : '/api';
const WS_BASE = _isLocalDev ? originToWs(_backendOrigin) : `wss://${window.location.host}`;

/** Supabase session persisted by login.html / signup.html (for AUTH_ENABLED + Supabase). */
const SAFEMINE_SESSION_KEY = 'safemine_supabase_session';

function getAuthHeaders() {
  try {
    const raw = localStorage.getItem(SAFEMINE_SESSION_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (!o || !o.access_token) return {};
    const exp = Number(o.expires_at);
    if (exp && Date.now() / 1000 > exp - 30) return {};
    return { Authorization: `Bearer ${o.access_token}` };
  } catch {
    return {};
  }
}

function hasValidSupabaseSession() {
  try {
    const raw = localStorage.getItem(SAFEMINE_SESSION_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || !o.access_token) return false;
    const exp = Number(o.expires_at);
    if (!exp) return true;
    return Date.now() / 1000 < exp - 60;
  } catch {
    return false;
  }
}

// ── HTTP helpers ──────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...opts.headers },
      ...opts
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn(`[API] ${path} failed:`, err.message);
    return null;
  }
}

const API = {
  health: () => apiFetch('/health'),
  getWorkers: () => apiFetch('/workers'),
  addWorker: (body) => apiFetch('/workers', { method: 'POST', body: JSON.stringify(body) }),
  deleteWorker: (id) => apiFetch(`/workers/${id}`, { method: 'DELETE' }),
  getTelemetry: (params) => apiFetch(`/telemetry?${new URLSearchParams(params)}`),
  getAlerts: (params) => apiFetch(`/alerts?${new URLSearchParams(params)}`),
  createAlert: (body) => apiFetch('/alerts', { method: 'POST', body: JSON.stringify(body) }),
  deleteAlert: (id) => apiFetch(`/alerts/${id}`, { method: 'DELETE' }),
  getSensorFaults: (params) => apiFetch(`/sensor-faults?${new URLSearchParams(params || {})}`),
  resolveSensorFault: (id, body) => apiFetch(`/sensor-faults/${id}/resolve`, { method: 'POST', body: JSON.stringify(body || {}) }),
  getAnchors: () => apiFetch('/anchors'),
  getIncidents: () => apiFetch('/incidents'),
  createIncident: (body) => apiFetch('/incidents', { method: 'POST', body: JSON.stringify(body) }),
  getEvacuations: () => apiFetch('/evacuations'),
  createEvacuation: (body) => apiFetch('/evacuations', { method: 'POST', body: JSON.stringify(body) }),
  getStats: () => apiFetch('/stats'),
  getSettings: () => apiFetch('/settings'),
  putSettings: (body) => apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
  getGeofences: () => apiFetch('/geofences'),
  addGeofence: (body) => apiFetch('/geofences', { method: 'POST', body: JSON.stringify(body) }),
  deleteGeofence: (id) => apiFetch(`/geofences/${id}`, { method: 'DELETE' }),
  getRefuges: () => apiFetch('/refuges'),
  addRefuge: (body) => apiFetch('/refuges', { method: 'POST', body: JSON.stringify(body) }),
  getDrones: () => apiFetch('/drones'),
  addDrone: (body) => apiFetch('/drones', { method: 'POST', body: JSON.stringify(body) }),
  deployDrone: (id, body) => apiFetch(`/drones/${id}/deploy`, { method: 'POST', body: JSON.stringify(body || {}) }),
  // Emergency actions
  sendSOS: (id) => apiFetch(`/sos/${id}`, { method: 'POST' }),
  wristbandIngest: (body) => apiFetch('/wristband', { method: 'POST', body: JSON.stringify(body || {}) }),
  broadcast: (body) => apiFetch('/broadcast', { method: 'POST', body: JSON.stringify(body) }),
  simulateEvent: (body) => apiFetch('/simulate/event', { method: 'POST', body: JSON.stringify(body) }),
  // Risk analytics
  getRiskForecast: () => apiFetch('/analytics/risk-forecast'),
  getGasTrend: (hours) => apiFetch(`/analytics/gas-trend?hours=${hours || 24}`),
  // Muster
  getMuster: () => apiFetch('/muster'),
  // Nearest refuge
  getNearestRefuge: (id) => apiFetch(`/refuges/nearest/${id}`),
  // Ping node
  pingWorker: (id) => apiFetch(`/workers/${id}/ping`, { method: 'POST' }),
  authPublicConfig: () => apiFetch('/auth/public-config'),
};

// ── WebSocket ─────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
const WS_HANDLERS = {};

function wsConnect() {
  try {
    ws = new WebSocket(WS_BASE);

    ws.onopen = () => {
      console.log('[WS] Connected to SafeMine backend');
      const dot = document.getElementById('ws-dot');
      if (dot) { dot.classList.add('connected'); dot.classList.remove('offline'); }
    };

    ws.onmessage = evt => {
      try {
        const { type, payload } = JSON.parse(evt.data);
        if (WS_HANDLERS[type]) WS_HANDLERS[type](payload);
      } catch (e) { console.warn('[WS] Parse error:', e); }
    };

    ws.onclose = () => {
      console.warn('[WS] Disconnected — reconnecting in 5s');
      const dot = document.getElementById('ws-dot');
      if (dot) { dot.classList.remove('connected'); dot.classList.add('offline'); }
      wsReconnectTimer = setTimeout(wsConnect, 5000);
    };

    ws.onerror = () => { /* silently retry */ };
  } catch (e) {
    console.warn('[WS] Cannot connect to backend');
    wsReconnectTimer = setTimeout(wsConnect, 8000);
  }
}

function wsOn(type, handler) { WS_HANDLERS[type] = handler; }

window.API = API;
window.__SAFEMINE_API_BASE__ = API_BASE;
window.SafeMineAuth = {
  SESSION_KEY: SAFEMINE_SESSION_KEY,
  getAuthHeaders,
  hasValidSupabaseSession,
  clearSession() {
    try {
      localStorage.removeItem(SAFEMINE_SESSION_KEY);
    } catch (e) { /* ignore */ }
  },
};

/** Same API base + Bearer token as API.* (for raw fetch in app.js / admin-dashboard.js). */
window.SafeMineFetch = {
  url(path) {
    const p = path.startsWith('/') ? path : '/' + path;
    return API_BASE + p;
  },
  jsonHeaders(extra) {
    return { 'Content-Type': 'application/json', ...getAuthHeaders(), ...(extra || {}) };
  },
};
window.wsConnect = wsConnect;
window.wsOn = wsOn;
