// ============================================================
//  MineGuard Pro — app.js  v2.0  (All bugs fixed)
// ============================================================
'use strict';

let state = {
  workers: [], anchors: [], alerts: [], incidents: [], evacuations: [],
  charts: {}, backendOnline: false, mapMode: 'workers',
  theme: 'dark', aiHistory: [], liveTimer: null,
  settings: null,
  escalations: {},   // workerId → { stage, countdown, workerName, zone, intervalId }
  fusionAlerts: [],  // recent sensor fusion alerts
  sensorFaults: [], // sensor_faults records for maintenance dashboard
};

/* ══ INIT ══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  initClock(); initNav(); wsConnect(); wireWebSocket();
  requestNotifyPermission();
  await loadAllData();
  await loadAdminSettings();
  initDashboard(); initWorkerGrid(); initAlertsList();
  initGasPage(); initHealthPage(); initEvacPage();
  initNetworkPage(); initIncidentsList();
  startLiveUpdates();
});

/* ══ BROWSER NOTIFICATIONS ════════════════════════════════ */
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

const _notifiedAlerts = new Set();
function notifyWorker(alert) {
  // Show browser notification for emergency/critical alerts
  if (!['emergency', 'critical'].includes(alert.level)) return;
  const key = (alert.title || '') + (alert.worker_id || '') + (alert.created_at || Date.now());
  if (_notifiedAlerts.has(key)) return;
  _notifiedAlerts.add(key);
  // Browser notification
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification('🛡 SafeMine ALERT — ' + alert.title, {
      body: (alert.desc || '') + (alert.worker_id ? ' · ' + alert.worker_id : ''),
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><text y="26" font-size="28">⛏</text></svg>',
      tag: key,
      requireInteraction: alert.level === 'emergency',
    });
    n.onclick = () => { window.focus(); navigateTo('alerts'); n.close(); };
    if (alert.level !== 'emergency') setTimeout(() => n.close(), 8000);
  }
  // Play alert tone
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = alert.level === 'emergency' ? 880 : 660;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.start(); osc.stop(ctx.currentTime + 0.8);
  } catch (e) { }
}

/* ══ DATA ══════════════════════════════════════════════════ */
async function loadAllData() {
  const health = await API.health();
  state.backendOnline = !!health?.status;

  if (state.backendOnline) {
    const [workers, alerts, anchors, incidents, stats] = await Promise.all([
      API.getWorkers(), API.getAlerts({ limit: 50 }),
      API.getAnchors(), API.getIncidents(), API.getStats()
    ]);
    state.workers = workers || [];
    // Enrich alerts with zone from worker data (no demo fallback)
    state.alerts = (alerts || []).map(a => {
      if (!a.zone && a.worker_id) {
        const w = (workers || []).find(x => x.id === a.worker_id);
        if (w) a.zone = w.zone;
      }
      return a;
    });
    state.anchors = anchors || [];
    state.incidents = incidents || [];
    if (stats) updateKPIs(stats);
    showToast('✓ Live data — ' + state.workers.length + ' miners tracked');
  } else {
    // Backend is offline → do NOT simulate any workers or gas.
    state.workers = [];
    state.alerts = [];
    state.anchors = [];
    state.incidents = [];
    const b = document.getElementById('backend-banner');
    if (b) {
      b.textContent = '⚠ Backend offline — NO LIVE DATA. Run `npm start` from the project root and check server logs.';
      b.style.display = 'block';
    }
  }
}

/* ══ WEBSOCKET ═════════════════════════════════════════════ */
function wireWebSocket() {
  wsOn('SNAPSHOT', p => { if (p.workers?.length) { state.workers = p.workers; refreshUI(); } });
  wsOn('WORKER_UPDATE', w => {
    const i = state.workers.findIndex(x => x.id === w.id);
    if (i >= 0) state.workers[i] = { ...state.workers[i], ...w }; else state.workers.push(w);
    refreshUI();
  });
  wsOn('NEW_ALERT', a => {
    // Enrich alert with zone from worker if missing
    if (!a.zone && a.worker_id) {
      const w = state.workers.find(x => x.id === a.worker_id);
      if (w) a.zone = w.zone;
    }
    state.alerts.unshift({ ...a, time: 'Just now' });
    renderAlertFeed(); renderAlertsList(); updateAlertBadge();
    notifyWorker(a);
    if (a.level === 'emergency' || a.type === 'MANUAL_SOS' || a.priority === 'critical') showEmergencyBanner(a);

    // Keep the maintenance dashboard up to date when sensor faults happen.
    if (typeof a.title === 'string' && a.title.startsWith('SENSOR_FAILURE:')) {
      const pageActive = document.getElementById('page-maintenance')?.classList.contains('active');
      if (pageActive) loadSensorFaultsPage();
    }
  });
  wsOn('ANCHOR_UPDATE', a => {
    const i = state.anchors.findIndex(x => x.id === a.id);
    if (i >= 0) state.anchors[i] = { ...state.anchors[i], ...a }; else state.anchors.push(a);
  });
  wsOn('EVACUATION_ORDERED', d => {
    showEmergencyBanner({ title: 'EVACUATION — ' + d.zone, desc: d.reason });
    state.evacuations.unshift({ ...d, status: 'active', created_at: new Date().toISOString() });
  });

  // ── Escalation stage updates ────────────────────────────────
  wsOn('ESCALATION_STAGE', d => {
    // Clear old interval if any
    if (state.escalations[d.workerId]?.intervalId) {
      clearInterval(state.escalations[d.workerId].intervalId);
    }
    let countdown = d.countdown || 0;
    const entry = { stage: d.stage, countdown, workerName: d.workerName, zone: d.zone };
    // Run countdown timer locally
    if (countdown > 0) {
      entry.intervalId = setInterval(() => {
        if (state.escalations[d.workerId]) {
          state.escalations[d.workerId].countdown = Math.max(0, state.escalations[d.workerId].countdown - 1);
          renderEscalationPanel();
        }
      }, 1000);
    }
    state.escalations[d.workerId] = entry;
    renderEscalationPanel();
    // Play escalation sound
    playEscalationTone(d.stage);
  });

  wsOn('ESCALATION_CANCELLED', d => {
    if (state.escalations[d.workerId]?.intervalId) clearInterval(state.escalations[d.workerId].intervalId);
    delete state.escalations[d.workerId];
    renderEscalationPanel();
  });

  // ── Sensor fusion alerts ────────────────────────────────────
  wsOn('NEW_ALERT', a => {
    if (a.fusion) {
      state.fusionAlerts.unshift({ ...a, receivedAt: Date.now() });
      state.fusionAlerts = state.fusionAlerts.slice(0, 10);
      showFusionToast(a);
    }
  });

  // ── Optimization live updates ─────────────────────────────
  wsOn('OPTIMIZATION_UPDATE', payload => {
    if (typeof handleOptimUpdate === 'function') handleOptimUpdate(payload);
  });

  // ── Contact/comms log updates ─────────────────────────────
  wsOn('CONTACT_LOG_UPDATE', payload => {
    if (typeof handleContactLogUpdate === 'function') handleContactLogUpdate(payload);
  });
}

function refreshUI() {
  renderWorkerTable(); renderWorkerGrid(state.workers);
  updateKPIFromState(); renderAgenticBanner();
  renderZoneSummary(); updateGasCards(); renderHealthList();
  if (document.getElementById('page-map')?.classList.contains('active')) drawMap();
}

/* ══ KPIs ══════════════════════════════════════════════════ */
function updateKPIs(s) {
  setEl('kpi-total', s.totalWorkers ?? 0); setEl('kpi-emergency', s.emergencies ?? 0);
  setEl('kpi-critical', s.criticals ?? 0); setEl('kpi-risk', s.avgRisk ?? '0.0');
  setEl('alert-badge', s.activeAlerts ?? 0);
  setEl('critical-badge', (s.emergencies ?? 0) + (s.criticals ?? 0));

  // Shift headcount widget (sidebar)
  const hc = s.headcount;
  if (hc) {
    const name = document.getElementById('shift-name');
    const time = document.getElementById('shift-time');
    const label = hc.currentShift === 'B' ? 'Night Shift B' : 'Day Shift A';
    if (name) name.textContent = `${label} · ${hc.currentShiftActive || 0} workers`;
    if (time) time.textContent = hc.currentShiftRange || (hc.currentShift === 'B' ? '18:00 – 06:00' : '06:00 – 18:00');
  }
}

function updateKPIFromState() {
  const n = state.workers.length;
  const em = state.workers.filter(w => w.status === 'emergency').length;
  const cr = state.workers.filter(w => w.status === 'critical').length;
  const avg = n ? (state.workers.reduce((a, w) => a + w.risk, 0) / n).toFixed(1) : 0;
  // Flammable Gas KPI: use gas_raw (ESP32 ADC), fallback to estimated (ch4*10000)
  const peakGasRaw = state.workers.reduce((a, w) => {
    const val = w.gas_raw != null ? w.gas_raw : (w.ch4 != null ? Math.round(w.ch4 * 10000) : 0);
    return Math.max(a, val);
  }, 0);
  const pw = state.workers.reduce((best, w) => {
    const val = w.gas_raw != null ? w.gas_raw : (w.ch4 != null ? Math.round(w.ch4 * 10000) : 0);
    return val > (best?.val || 0) ? { w, val } : best;
  }, null);
  setEl('kpi-total', n); setEl('kpi-emergency', em); setEl('kpi-critical', cr);
  setEl('kpi-risk', avg);
  setEl('kpi-ch4', peakGasRaw);
  const gasUnitEl = document.getElementById('kpi-gas-unit');
  if (gasUnitEl) gasUnitEl.textContent = ' ADC';
  setEl('kpi-ch4-zone', pw?.w?.zone || '—');
  setEl('kpi-lora', state.backendOnline ? 'LIVE' : 'OFF');
  setEl('kpi-anchors', state.anchors.filter(a => a.status === 'online').length + ' anchors');
  setEl('kpi-all-safe', (em + cr) === 0 ? 'ALL TRACKED' : (em + cr) + ' AT RISK');
  const ac = state.alerts.filter(a => a.level === 'emergency' || a.level === 'critical').length;
  setEl('alert-badge', ac); setEl('critical-badge', em + cr);
  setEl('marquee-workers', n + ' MINERS TRACKED');
  const ma = document.getElementById('marquee-alerts');
  if (ma) { ma.textContent = ac + ' ACTIVE ALERTS'; ma.className = 'marquee-item ' + (ac > 0 ? 'warn' : 'safe'); }
}
function updateAlertBadge() {
  setEl('alert-badge', state.alerts.filter(a => a.level === 'emergency' || a.level === 'critical').length);
}

/* ══ CLOCK ═════════════════════════════════════════════════ */
function initClock() {
  const e = document.getElementById('topbar-time');
  function t() { if (e) e.textContent = new Date().toLocaleTimeString('en', { hour12: false }); }
  t(); setInterval(t, 1000);
}

/* ══ NAV ═══════════════════════════════════════════════════ */
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault(); navigateTo(item.dataset.page);
      if (window.innerWidth < 768) document.getElementById('sidebar')?.classList.remove('open');
    });
  });
  document.getElementById('menu-toggle')?.addEventListener('click', () =>
    document.getElementById('sidebar')?.classList.toggle('open'));
}

function navigateTo(page) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const t = document.getElementById('page-' + page);
  if (t) t.classList.add('active');
  const titles = {
    dashboard: 'Dashboard', map: 'Mine Map', workers: 'Workers',
    alerts: 'Alert Center', gas: 'Gas Monitoring', health: 'Health & Vitals',
    evacuation: 'Evacuation Control', network: 'LoRa Network',
    incidents: 'Incident Log', aiassist: 'AI Safety Assistant',
    analytics: 'Predictive AI', simulation: 'Emergency Simulator',
    drones: 'Drone Fleet', muster: 'Muster Report',
    geofence: 'Geofences', admin: 'Admin Settings',
    admindash: '🛡 Admin Command Dashboard', optimization: '🧠 Optimization Engine',
    maintenance: '🛠 Maintenance Dashboard'
  };
  setEl('page-title', titles[page] || page);

  // FIX: draw map AFTER the page is visible so canvas has real dimensions
  if (page === 'map') {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        initMineMap();
        // Load geofences for overlay if not already loaded
        if (typeof state_geofences !== 'undefined' && state_geofences.length === 0 && state.backendOnline) {
          loadGeofences().then(() => startMapAnimation());
        } else {
          startMapAnimation();
        }
      });
    });
  } else {
    // Stop animation when leaving the map page to save CPU
    stopMapAnimation();
  }
  if (page === 'workers') renderWorkerGrid(state.workers);
  if (page === 'alerts') renderAlertsList();
  if (page === 'gas') { updateGasCards(); requestAnimationFrame(() => initGasCharts()); }
  if (page === 'health') { renderHealthList(); if (state.charts.hrChart) { state.charts.hrChart.destroy(); state.charts.hrChart = null; } initHRChart(); }
  if (page === 'evacuation') { renderEvacZones(); loadEvacLog(); }
  if (page === 'network') { renderNetworkStats(); renderAnchorTable(); if (state.charts.rssiChart) { state.charts.rssiChart.destroy(); state.charts.rssiChart = null; } initRSSIChart(); updatePacketLog(); }
  if (page === 'incidents') renderIncidentsList();
  if (page === 'simulation') { loadRefuges(); }
  if (page === 'analytics') { loadRiskForecast(); }
  if (page === 'muster') { loadMusterReport(); }
  if (page === 'geofence') { loadGeofences(); }
  if (page === 'drones') { loadDrones(); }
  if (page === 'admin') { loadAdminSettings(); }
  // Admin Dashboard + Optimization pages
  if (page === 'admindash') { if (typeof onAdminDashShow === 'function') onAdminDashShow(); }
  if (page === 'optimization') { if (typeof onOptimShow === 'function') onOptimShow(); }
  if (page === 'maintenance') { loadSensorFaultsPage(); }
}

/* ══ DASHBOARD ═════════════════════════════════════════════ */
function initDashboard() {
  renderWorkerTable(); renderAlertFeed(); renderZoneSummary();
  renderAgenticBanner(); updateKPIFromState(); buildGasTrendChart(24);
}

function renderWorkerTable() {
  const tbody = document.getElementById('worker-tbody');
  if (!tbody) return;
  tbody.innerHTML = state.workers.map(w => {
    const rc = riskColor(w.risk);
    const pct = (w.risk / 10 * 100).toFixed(0);
    // Flammable Gas: use gas_raw (ESP32 MQ2 ADC, 0-4095). ADC threshold: warn>=1200, crit>=2000
    const rawGas = w.gas_raw ?? null;
    const gasDisp = rawGas !== null ? rawGas : (w.ch4 != null ? (w.ch4 * 10000).toFixed(0) + '<small style="font-size:9px"> est</small>' : '—');
    const gasc = rawGas !== null
      ? (rawGas >= 2000 ? 'var(--danger)' : rawGas >= 1200 ? 'var(--warning)' : 'var(--text-sec)')
      : (w.ch4 != null ? ((w.ch4 >= 1.0 ? 'var(--danger)' : w.ch4 >= 0.5 ? 'var(--warning)' : 'var(--text-sec)')) : 'var(--text-sec)');
    const o2c = (w.o2 || 21) <= 19.5 ? 'var(--danger)' : 'var(--text-sec)';
    const hrc = (w.heart_rate || 72) > 120 ? 'var(--warning)' : 'var(--text-sec)';
    const bc = w.battery < 20 ? 'var(--danger)' : w.battery < 40 ? 'var(--warning)' : 'var(--text-sec)';
    const presDisp = w.pressure != null ? w.pressure.toFixed(1) + ' hPa' : '—';
    const presc = w.pressure != null && w.pressure < 900 ? 'var(--danger)' : 'var(--text-sec)';
    return `<tr>
      <td><span style="font-family:var(--font-mono)">${w.id}</span></td>
      <td><strong>${w.name}</strong></td>
      <td><span style="color:var(--accent)">${w.zone}</span>/<span style="color:var(--text-muted)">${w.tunnel}</span></td>
      <td style="color:${gasc};font-family:var(--font-mono)">${gasDisp}</td>
      <td style="color:${o2c};font-family:var(--font-mono)">${w.o2 || 20.9}%</td>
      <td style="color:${presc};font-family:var(--font-mono)">${presDisp}</td>
      <td style="color:${hrc};font-family:var(--font-mono)">${w.heart_rate || '—'}bpm</td>
      <td><div class="risk-bar"><div class="risk-bar-bg"><div class="risk-bar-fill" style="width:${pct}%;background:${rc}"></div></div><span style="color:${rc};font-weight:700;font-family:var(--font-mono);min-width:28px">${w.risk}</span></div></td>
      <td><span class="status-tag ${w.status}">${workerStatusLabel(w)}</span></td>
      <td style="color:${bc};font-family:var(--font-mono)">${w.battery || '—'}%</td>
    </tr>`;
  }).join('');
}

function renderAlertFeed() {
  const el = document.getElementById('alert-feed');
  if (!el) return;
  el.innerHTML = state.alerts.slice(0, 6).map(a => `
    <div class="alert-item ${a.level}">
      <span class="alert-icon">${a.icon || alertIcon(a.level)}</span>
      <div><div class="alert-title">${a.title}</div>
      <div class="alert-meta">${a.desc || ''} · ${a.time || timeAgo(a.created_at)}</div></div>
    </div>`).join('') ||
    '<div style="color:var(--safe);padding:20px;text-align:center;font-size:12px">✓ No active alerts</div>';
}

function renderZoneSummary() {
  const el = document.getElementById('zone-summary'); if (!el) return;
  const zones = {};
  state.workers.forEach(w => {
    if (!zones[w.zone]) zones[w.zone] = { total: 0, critical: 0, emergency: 0, maxRisk: 0 };
    zones[w.zone].total++;
    if (w.status === 'critical') zones[w.zone].critical++;
    if (w.status === 'emergency') zones[w.zone].emergency++;
    zones[w.zone].maxRisk = Math.max(zones[w.zone].maxRisk, w.risk);
  });
  el.innerHTML = Object.entries(zones).sort(([a], [b]) => a.localeCompare(b)).map(([name, z]) => {
    const col = z.emergency > 0 ? 'var(--danger)' : z.critical > 0 ? 'var(--accent3)' : 'var(--accent)';
    const pct = (z.maxRisk / 10 * 100).toFixed(0);
    return `<div class="zone-row">
      <span class="zone-label" style="color:${col}">${name}</span>
      <span class="zone-count">${z.total}</span>
      <div class="zone-bar-bg"><div class="zone-bar" style="width:${pct}%;background:${col}"></div></div>
      <span class="zone-status" style="color:${col}">${z.emergency > 0 ? 'EMERGENCY' : z.critical > 0 ? 'CRITICAL' : 'OK'}</span>
    </div>`;
  }).join('');
}

function renderAgenticBanner() {
  const banner = document.getElementById('agentic-banner'); if (!banner) return;
  const items = [];
  const em = state.workers.filter(w => w.status === 'emergency');
  const hch4 = state.workers.filter(w => (w.ch4 || 0) >= 1.0);
  const stat = state.workers.filter(w => w.motion === 0);
  if (em.length) items.push(`<div class="agentic-alert"><div class="agentic-alert-icon">🚨</div><div>
    <div class="agentic-alert-title">EMERGENCY — ${em.map(w => w.name).join(', ')}</div>
    <div class="agentic-alert-desc">Immediate rescue required.</div>
    <span class="agentic-alert-action" onclick="openEvacuationModal()">→ Order Evacuation</span>
    <span class="agentic-alert-action" style="margin-left:8px" onclick="navigateTo('map')">→ Find Location</span>
  </div></div>`);
  if (hch4.length) items.push(`<div class="agentic-alert"><div class="agentic-alert-icon">💨</div><div>
    <div class="agentic-alert-title" style="color:var(--warning)">METHANE CRITICAL — ${hch4.map(w => w.zone).filter((v, i, a) => a.indexOf(v) === i).join(', ')}</div>
    <div class="agentic-alert-desc">${hch4.map(w => w.id + ': ' + (w.ch4 || 0).toFixed(2) + '%').join(' · ')} — Explosive threshold exceeded!</div>
    <span class="agentic-alert-action" style="color:var(--warning)" onclick="navigateTo('gas')">→ Gas Monitor</span>
  </div></div>`);
  if (stat.length && !em.length) items.push(`<div class="agentic-alert" style="border-color:rgba(0,212,255,0.25)"><div class="agentic-alert-icon">🛑</div><div>
    <div class="agentic-alert-title" style="color:var(--accent)">Workers Stationary — ${stat.map(w => w.id).join(', ')}</div>
    <div class="agentic-alert-desc">No motion detected. Check if assistance needed.</div>
  </div></div>`);
  if (items.length) { banner.innerHTML = items.join(''); banner.style.display = 'flex'; banner.style.flexDirection = 'column'; }
  else banner.style.display = 'none';
}

function buildGasTrendChart(hours) {
  const ctx = document.getElementById('gasTrendChart')?.getContext('2d');
  if (!ctx) return;
  if (state.charts.gasTrend) { state.charts.gasTrend.destroy(); }
  (async () => {
    let labels = [];
    let ch4 = [];
    let co = [];
    let o2 = [];

    if (state.backendOnline) {
      try {
        const res = await fetch(`/api/analytics/gas-trend?hours=${hours}`);
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length) {
            labels = rows.map(r => new Date(r.created_at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }));
            ch4 = rows.map(r => (r.maxCh4 ?? r.avgCh4 ?? 0));
            co = rows.map(r => (r.avgCo ?? 0));
            o2 = rows.map(r => (r.minO2 ?? 20.9));
          }
        }
      } catch (e) {
        console.error('Gas trend API error:', e);
      }
    }

    // If no backend data, render an empty chart (no fake trend)
    state.charts.gasTrend = new Chart(ctx, {
      type: 'line',
      data: {
        labels, datasets: [
          { label: 'Flammable Gas (ADC×0.01)', data: ch4.map(v => +(v * 100).toFixed(0)), borderColor: '#ff6b35', backgroundColor: 'rgba(255,107,53,0.1)', tension: .4, pointRadius: 0, fill: true },
          { label: 'O₂ (%)', data: o2, borderColor: '#00d4ff', backgroundColor: 'rgba(0,212,255,0.07)', tension: .4, pointRadius: 0, fill: true },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { usePointStyle: true, color: '#7a9cb5', font: { family: 'Share Tech Mono' } } } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#3d5a72', maxTicksLimit: 8, font: { family: 'Share Tech Mono', size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#3d5a72', font: { family: 'Share Tech Mono', size: 10 } } },
        }
      }
    });
  })();
}

function setGasTrendRange(hours, btn) {
  document.querySelectorAll('#page-dashboard .btn-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  buildGasTrendChart(hours);
}

/* ══ MINE MAP — CANVAS ════════════════════════════════════ */
// FIX: proper canvas sizing & drawing on visible page
let _mapResizeObserver = null;
function initMineMap() {
  const canvas = document.getElementById('mine-canvas');
  if (!canvas) return;
  const container = canvas.parentElement;

  // Force the container to have an explicit pixel height
  if (!container.clientHeight || container.clientHeight < 50) {
    container.style.height = (window.innerHeight - 230) + 'px';
  }

  const W = container.clientWidth || window.innerWidth - 240;
  const H = container.clientHeight || window.innerHeight - 230;
  canvas.width = W;
  canvas.height = H;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  // Attach a ResizeObserver so the map redraws when the window resizes
  if (!_mapResizeObserver && window.ResizeObserver) {
    _mapResizeObserver = new ResizeObserver(() => {
      if (document.getElementById('page-map')?.classList.contains('active')) {
        initMineMap(); drawMap();
      }
    });
    _mapResizeObserver.observe(container);
  }
}

function drawMap() {
  const canvas = document.getElementById('mine-canvas');
  if (!canvas) return;

  // Make sure canvas has proper size
  const container = canvas.parentElement;
  if (canvas.width < 10) {
    canvas.width = container.clientWidth || 900;
    canvas.height = container.clientHeight || 520;
  }

  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const sX = W / 900, sY = H / 520;

  // ── Background
  ctx.fillStyle = '#050a10';
  ctx.fillRect(0, 0, W, H);

  // ── Scanline grid
  ctx.strokeStyle = 'rgba(0,180,220,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 50 * sX) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40 * sY) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // ── Surface bar
  ctx.fillStyle = 'rgba(0,255,157,0.06)';
  ctx.fillRect(0, 0, W, 28 * sY);
  ctx.fillStyle = 'rgba(0,255,157,0.5)';
  ctx.font = `bold ${Math.max(9, 10 * sX)}px Share Tech Mono`;
  ctx.textAlign = 'left';
  ctx.fillText('▲ SURFACE / CONTROL ROOM', 12 * sX, 18 * sY);

  // ── Tunnel definitions
  const tunnels = [
    {
      id: 'T1', label: 'Tunnel 1 · 30m', color: 'rgba(0,212,255,0.6)', lineW: 14,
      path: [{ x: 170, y: 30 }, { x: 170, y: 110 }]
    },
    {
      id: 'Main', label: '', color: 'rgba(0,212,255,0.15)', lineW: 22,
      path: [{ x: 170, y: 30 }, { x: 170, y: 460 }]
    },
    {
      id: 'T2', label: 'Tunnel 2 · 55m', color: 'rgba(0,190,220,0.6)', lineW: 14,
      path: [{ x: 170, y: 160 }, { x: 400, y: 160 }]
    },
    {
      id: 'T3', label: 'Tunnel 3 · 75m', color: 'rgba(0,160,190,0.6)', lineW: 14,
      path: [{ x: 370, y: 160 }, { x: 370, y: 250 }, { x: 580, y: 250 }]
    },
    {
      id: 'T4', label: 'Tunnel 4 · 90m', color: 'rgba(0,130,160,0.6)', lineW: 14,
      path: [{ x: 170, y: 310 }, { x: 620, y: 310 }]
    },
    {
      id: 'T5', label: 'Tunnel 5 · 105m', color: 'rgba(0,100,130,0.6)', lineW: 14,
      path: [{ x: 590, y: 250 }, { x: 750, y: 250 }, { x: 750, y: 360 }]
    },
    {
      id: 'T6', label: 'Tunnel 6 · 125m', color: 'rgba(0,80,110,0.6)', lineW: 14,
      path: [{ x: 620, y: 310 }, { x: 870, y: 310 }, { x: 870, y: 430 }]
    },
  ];

  // Draw tunnels
  tunnels.forEach(t => {
    if (!t.path?.length) return;
    ctx.beginPath();
    ctx.moveTo(t.path[0].x * sX, t.path[0].y * sY);
    for (let i = 1; i < t.path.length; i++) ctx.lineTo(t.path[i].x * sX, t.path[i].y * sY);
    ctx.strokeStyle = t.color;
    ctx.lineWidth = t.lineW * Math.min(sX, sY) + 2;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke();
    // Label
    if (t.label) {
      const mid = t.path[Math.floor(t.path.length / 2)];
      ctx.fillStyle = 'rgba(0,212,255,0.55)';
      ctx.font = `bold ${Math.max(8, 9 * sX)}px Share Tech Mono`;
      ctx.textAlign = 'center';
      ctx.fillText(t.label, mid.x * sX, mid.y * sY - 12 * sY);
    }
  });

  // ── Depth markers on main shaft
  [30, 55, 75, 90, 105, 125].forEach((d, i) => {
    const y = (100 + i * 60) * sY;
    ctx.strokeStyle = 'rgba(0,212,255,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(120 * sX, y); ctx.lineTo(220 * sX, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(0,212,255,0.4)';
    ctx.font = `${Math.max(8, 8 * sX)}px Share Tech Mono`;
    ctx.textAlign = 'right';
    ctx.fillText(d + 'm', 115 * sX, y + 4 * sY);
  });

  // ── Anchors
  const filtTunnel = document.getElementById('tunnel-filter')?.value || 'all';
  if (state.mapMode === 'anchors' || state.mapMode === 'workers') {
    state.anchors.forEach(a => {
      if (filtTunnel !== 'all' && a.tunnel !== filtTunnel) return;
      const ax = a.x * sX, ay = a.y * sY;
      const col = a.status === 'online' ? '#00d4ff' : '#ffcc00';
      ctx.fillStyle = col + '33'; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(ax - 5 * sX, ay - 5 * sY, 10 * sX, 10 * sY);
      ctx.fill(); ctx.stroke();
      if (state.mapMode === 'anchors') {
        ctx.fillStyle = col; ctx.font = `${Math.max(7, 8 * sX)}px Share Tech Mono`;
        ctx.textAlign = 'center';
        ctx.fillText(a.id.replace('ANC-', ''), ax, ay + 16 * sY);
      }
    });
  }

  // ── Geofence Danger Zone Overlays (drawn BEFORE workers so workers appear on top)
  const geofencesToDraw = (typeof state_geofences !== 'undefined' ? state_geofences : []).filter(gf => gf.active);
  const _gfNow = Date.now();
  geofencesToDraw.forEach(gf => {
    const gx = gf.cx * sX, gy = gf.cy * sY;
    const gr = gf.radius * Math.min(sX, sY);

    // Color scheme by type
    const typeColors = {
      hazard:     { fill: 'rgba(255,45,85,',     stroke: '#ff2d55', label: '#ff2d55' },
      restricted: { fill: 'rgba(255,204,0,',     stroke: '#ffcc00', label: '#ffcc00' },
      safe:       { fill: 'rgba(0,255,157,',     stroke: '#00ff9d', label: '#00ff9d' },
      machinery:  { fill: 'rgba(255,107,53,',    stroke: '#ff6b35', label: '#ff6b35' },
    };
    const c = typeColors[gf.type] || typeColors.hazard;

    // Animated pulse for hazard/machinery zones
    const isPulseType = gf.type === 'hazard' || gf.type === 'machinery';
    const pulse = isPulseType ? 0.5 + 0.5 * Math.abs(Math.sin(_gfNow / 1200)) : 0;

    // Outer pulsing ring
    if (isPulseType) {
      ctx.beginPath();
      ctx.arc(gx, gy, gr + 8 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = c.stroke + (pulse * 0.6).toFixed(2) + ')';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Filled zone
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fillStyle = c.fill + '0.12)';
    ctx.fill();

    // Hatched fill for hazard zones (danger crosshatch pattern)
    if (gf.type === 'hazard' || gf.type === 'machinery') {
      ctx.save();
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.clip();
      ctx.strokeStyle = c.stroke + '22';
      ctx.lineWidth = 1;
      for (let hx = gx - gr; hx < gx + gr; hx += 12 * Math.min(sX, sY)) {
        ctx.beginPath();
        ctx.moveTo(hx, gy - gr);
        ctx.lineTo(hx + gr * 0.5, gy + gr);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Solid border
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.strokeStyle = c.stroke;
    ctx.lineWidth = isPulseType ? 2 : 1.5;
    ctx.setLineDash(gf.type === 'restricted' ? [6, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // Zone name label
    const typeLabels = { hazard: '⛔ DANGER', restricted: '⚠ RESTRICTED', safe: '✓ SAFE ZONE', machinery: '⚙ MACHINERY' };
    const typeTag = typeLabels[gf.type] || gf.type.toUpperCase();
    const nameText = gf.name.slice(0, 20);
    ctx.font = `bold ${Math.max(9, 10 * Math.min(sX, sY))}px Share Tech Mono`;
    ctx.textAlign = 'center';
    // Name on top
    ctx.fillStyle = c.label;
    ctx.fillText(nameText, gx, gy - 6);
    // Type tag below
    ctx.font = `${Math.max(7, 8 * Math.min(sX, sY))}px Share Tech Mono`;
    ctx.fillStyle = c.label + 'cc';
    ctx.fillText(typeTag, gx, gy + 8);

    // Check workers inside this geofence
    const workersInZone = state.workers.filter(w => {
      const d = Math.sqrt(Math.pow(w.x - gf.cx, 2) + Math.pow(w.y - gf.cy, 2));
      return d <= gf.radius;
    });
    if (workersInZone.length > 0) {
      // Bright breach indicator badge
      const badgeR = 10 * Math.min(sX, sY);
      ctx.beginPath();
      ctx.arc(gx, gy - gr - badgeR - 4, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = gf.type === 'safe' ? 'rgba(0,255,157,0.9)' : 'rgba(255,45,85,0.9)';
      ctx.fill();
      ctx.font = `bold ${Math.max(8, 9 * Math.min(sX, sY))}px Share Tech Mono`;
      ctx.fillStyle = '#fff';
      ctx.fillText(workersInZone.length, gx, gy - gr - badgeR + 3);
      // If it's a hazard zone, add warning flash
      if (gf.type === 'hazard' || gf.type === 'machinery') {
        ctx.font = `${Math.max(11, 13 * Math.min(sX, sY))}px sans-serif`;
        ctx.fillText('⚠', gx + gr * 0.65, gy - gr * 0.4);
      }
    }
  });

  // ── Gas cloud overlay
  if (state.mapMode === 'gas') {
    state.workers.forEach(w => {
      if (!(w.ch4 > 0)) return;
      const wx = w.x * sX, wy = w.y * sY;
      const intensity = Math.min(1, w.ch4 / 1.5);
      const r = 70 * intensity * Math.min(sX, sY) + 25;
      const grad = ctx.createRadialGradient(wx, wy, 0, wx, wy, r);
      grad.addColorStop(0, `rgba(255,107,53,${0.45 * intensity})`);
      grad.addColorStop(1, 'rgba(255,107,53,0)');
      ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad; ctx.fill();
    });
  }

  // ── Workers
  const filtStatus = document.getElementById('status-filter')?.value || 'all';
  const now = Date.now();
  state.workers.forEach(w => {
    if (filtTunnel !== 'all' && w.tunnel !== filtTunnel) return;
    if (filtStatus !== 'all' && w.status !== filtStatus) return;
    const wx = w.x * sX, wy = w.y * sY;
    const col = statusColor(w.status);
    const r = Math.max(7, (10 * Math.min(sX, sY)));

    // Pulse for emergencies
    if (w.status === 'emergency' || w.status === 'critical') {
      const pulse = 0.4 + 0.6 * Math.abs(Math.sin(now / 600));
      ctx.beginPath(); ctx.arc(wx, wy, r + 8 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = col + '55'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    // Worker circle
    ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2);
    ctx.fillStyle = col + 'cc'; ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();

    // ID label
    ctx.fillStyle = '#e8f2fa';
    ctx.font = `bold ${Math.max(8, 9 * Math.min(sX, sY))}px Exo 2`;
    ctx.textAlign = 'center';
    ctx.fillText(w.id.replace('MNR-', ''), wx, wy - r - 4 * sY);

    // Warning icons
    if ((w.ch4 || 0) >= 1.0) {
      ctx.font = `${Math.max(10, 11 * Math.min(sX, sY))}px sans-serif`;
      ctx.fillText('⚠', wx + r + 6, wy + 4 * sY);
    }
    if (w.panic) {
      ctx.font = `${Math.max(11, 13 * Math.min(sX, sY))}px sans-serif`;
      ctx.fillText('🆘', wx, wy - r - 16 * sY);
    }
    // Stationary indicator
    if (w.motion === 0) {
      ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(wx, wy, r + 4, 0, Math.PI * 2);
      ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
  });

  // ── Legend box (workers + geofences)
  const leg = [['#ff2d55', 'Emergency'], ['#ff6b35', 'Critical'], ['#ffcc00', 'Warning'], ['#00ff9d', 'Online']];
  const gfLeg = [['#ff2d55', '⛔ Hazard'], ['#ffcc00', '⚠ Restricted'], ['#00ff9d', '✓ Safe'], ['#ff6b35', '⚙ Machinery']];
  const lw = 200 * sX, lh = (leg.length + gfLeg.length) * 10 * sY + 22 * sY;
  const lx = 10 * sX, ly = H - lh - 8 * sY;
  ctx.fillStyle = 'rgba(5,10,16,0.88)';
  ctx.fillRect(lx, ly, lw, lh);
  ctx.strokeStyle = 'rgba(0,212,255,0.2)'; ctx.lineWidth = 1;
  ctx.strokeRect(lx, ly, lw, lh);
  ctx.font = `bold ${Math.max(7, 8 * sX)}px Share Tech Mono`;
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.fillText('WORKER STATUS', lx + 8 * sX, ly + 12 * sY);
  leg.forEach((l, i) => {
    const lbx = lx + (i % 2) * 95 * sX + 8 * sX;
    const lby = ly + (Math.floor(i / 2)) * 12 * sY + 22 * sY;
    ctx.fillStyle = l[0]; ctx.beginPath(); ctx.arc(lbx + 4, lby - 3 * sY, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = `${Math.max(7, 8 * sX)}px Share Tech Mono`;
    ctx.fillStyle = 'rgba(200,220,240,0.6)';
    ctx.fillText(l[1], lbx + 12 * sX, lby);
  });
  const gfLegY = ly + Math.ceil(leg.length / 2) * 12 * sY + 26 * sY;
  ctx.font = `bold ${Math.max(7, 8 * sX)}px Share Tech Mono`;
  ctx.fillStyle = 'rgba(0,212,255,0.5)';
  ctx.fillText('GEOFENCE ZONES', lx + 8 * sX, gfLegY);
  gfLeg.forEach((l, i) => {
    const lbx = lx + (i % 2) * 95 * sX + 8 * sX;
    const lby = gfLegY + (Math.floor(i / 2)) * 12 * sY + 10 * sY;
    ctx.beginPath();
    ctx.arc(lbx + 4, lby - 3 * sY, 4, 0, Math.PI * 2);
    ctx.strokeStyle = l[0]; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = `${Math.max(7, 8 * sX)}px Share Tech Mono`;
    ctx.fillStyle = 'rgba(200,220,240,0.6)';
    ctx.fillText(l[1], lbx + 12 * sX, lby);
  });
}

// Animate the map continuously so geofence pulses work
let _mapAnimFrame = null;
function startMapAnimation() {
  if (_mapAnimFrame) return;
  function _animLoop() {
    if (document.getElementById('page-map')?.classList.contains('active') &&
        document.getElementById('underground-map-wrap')?.style.display !== 'none') {
      drawMap();
    }
    _mapAnimFrame = requestAnimationFrame(_animLoop);
  }
  _mapAnimFrame = requestAnimationFrame(_animLoop);
}
function stopMapAnimation() {
  if (_mapAnimFrame) { cancelAnimationFrame(_mapAnimFrame); _mapAnimFrame = null; }
}
/* Surface real-world map (Leaflet) */
let _leafletMap = null;
let _leafletMarkers = {};

function getMineCoords() {
  // Try settings from API first
  const lat = Number(state.settings?.mineLat);
  const lng = Number(state.settings?.mineLng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    return { lat, lng };
  }
  // FALLBACK: hardcoded default so Surface Map always loads
  return { lat: 6.2041, lng: -1.6747 };
}

function initSurfaceMap() {
  const el = document.getElementById('leaflet-map');
  if (!el) return;
  const coords = getMineCoords(); // Always returns coords now (has built-in fallback)
  if (_leafletMap) {
    _leafletMap.setView([coords.lat, coords.lng], _leafletMap.getZoom());
    _leafletMap.invalidateSize();
    updateSurfaceMarkers();
    return;
  }
  _leafletMap = L.map('leaflet-map', { zoomControl: true }).setView([coords.lat, coords.lng], 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(_leafletMap);
  // Mine boundary marker
  const mineName = state.settings?.mineName || 'Mine Site';
  L.circle([coords.lat, coords.lng], { radius: 200, color: '#00d4ff', fillColor: '#00d4ff', fillOpacity: 0.08, weight: 2 })
    .addTo(_leafletMap).bindPopup(`<b>⛏ ${mineName}</b><br>Operations area`);
  // Shaft entry marker
  L.marker([coords.lat, coords.lng], {
    icon: L.divIcon({ html: '<div style="background:#00ff9d;width:18px;height:18px;border-radius:3px;border:2px solid #004;display:flex;align-items:center;justify-content:center;font-size:10px">⛏</div>', iconSize: [18, 18] })
  }).addTo(_leafletMap).bindPopup('<b>Main Shaft Entry</b><br>Control Room Access');
  updateSurfaceMarkers();
}

function updateSurfaceMarkers() {
  if (!_leafletMap) return;
  const coords = getMineCoords();
  // Remove old markers
  Object.values(_leafletMarkers).forEach(m => _leafletMap.removeLayer(m));
  _leafletMarkers = {};
  // Offsets to spread workers around the mine site when no real GPS
  const offsets = [
    [0.0005,0.0003],[-0.0002,0.0008],[0.0010,-0.0005],[0.0003,-0.0002],
    [-0.0008,0.0004],[-0.0004,0.0010],[0.0015,0.0002],[0.0008,-0.0007],
    [0.0001,0.0001],[-0.0012,-0.0009],[-0.0006,0.0007],[-0.0009,-0.0003]
  ];
  state.workers.forEach((w, i) => {
    // Use real GPS if available, otherwise spread around mine center
    const hasGPS = Number.isFinite(w.lat) && Number.isFinite(w.lng) && (w.lat !== 0 || w.lng !== 0);
    if (!hasGPS) {
      const [dLat, dLng] = offsets[i % offsets.length];
      w = { ...w, lat: coords.lat + dLat, lng: coords.lng + dLng };
    }
    const lat = Number(w.lat);
    const lng = Number(w.lng);
    const dotColor = {
      'emergency': '#ff2d55',
      'critical': '#ff6b35',
      'warning': '#ffcc00',
      'offline': '#ff2d55',
      'sensor_fault_warning': '#ffcc00',
      'sensor_fault_critical': '#ff2d55',
      'degraded_mode': '#ffcc00',
      'online': '#00ff9d',
      'stationary': '#00d4ff'
    }[w.status] || '#00ff9d';
    const pulse = w.status === 'emergency' || w.status === 'critical' || w.status === 'offline' || w.status === 'sensor_fault_critical'
      ? ' class="leaflet-pulse"' : '';
    const icon = L.divIcon({
      html: `<div style="background:${dotColor};width:16px;height:16px;border-radius:50%;border:2px solid rgba(0,0,0,0.5);box-shadow:0 0 ${w.status === 'emergency' ? '12px 4px ' + dotColor : '6px ' + dotColor}"></div>`,
      iconSize: [16, 16], iconAnchor: [8, 8]
    });
    const marker = L.marker([lat, lng], { icon }).addTo(_leafletMap);
    marker.bindPopup(`<b>${w.name}</b> (${w.id})<br>Zone: ${w.zone} · ${w.tunnel}<br>Status: <b style="color:${dotColor}">${workerStatusLabel(w).toUpperCase()}</b><br>CH₄: ${(w.ch4 || 0).toFixed(2)}% · CO: ${w.co || 0}ppm<br>O₂: ${w.o2 || '—'}% · HR: ${w.heart_rate || '—'}bpm<br>Risk: ${w.risk}/10 · Battery: ${w.battery || '—'}%<br>Depth: ${w.depth || 0}m underground`);
    if (w.status === 'emergency' || w.status === 'critical' || w.status === 'offline' || w.status === 'sensor_fault_critical') marker.openPopup();
    _leafletMarkers[w.id] = marker;
  });
}

function setMapMode(mode, btn) {
  document.querySelectorAll('.map-toolbar .btn-tool').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  state.mapMode = mode;
  if (mode === 'surface') {
    document.getElementById('underground-map-wrap').style.display = 'none';
    document.getElementById('surface-map-wrap').style.display = 'block';
    requestAnimationFrame(() => { initSurfaceMap(); });
  } else {
    document.getElementById('underground-map-wrap').style.display = 'block';
    document.getElementById('surface-map-wrap').style.display = 'none';
    drawMap();
  }
}
function filterByTunnel(v) { drawMap(); }
function filterByStatus(v) { drawMap(); }

/* ══ WORKERS PAGE ══════════════════════════════════════════ */
function initWorkerGrid() { renderWorkerGrid(state.workers); }

function renderWorkerGrid(workers) {
  const el = document.getElementById('worker-grid'); if (!el) return;
  el.innerHTML = workers.map(w => {
    const rc = riskColor(w.risk);
    const bp = w.battery || 0;
    const bc = bp < 20 ? 'var(--danger)' : bp < 40 ? 'var(--warning)' : 'var(--safe)';
    const hb = (w.helmet_status === 'online');
    const wb = (w.wristband_status === 'online');
    const helmDot = hb ? '🟢' : '🔴';
    const wristDot = wb ? '🟢' : '🔴';
    const wbatt = Number.isFinite(Number(w.wristband_battery)) ? Number(w.wristband_battery) : null;
    const c4c = (w.ch4 || 0) >= 1.0 ? 'var(--danger)' : (w.ch4 || 0) >= 0.5 ? 'var(--warning)' : 'var(--text-sec)';
    const coc = (w.co || 0) >= 50 ? 'var(--danger)' : (w.co || 0) >= 25 ? 'var(--warning)' : 'var(--text-sec)';
    const o2c = (w.o2 || 21) <= 19.5 ? 'var(--danger)' : 'var(--text-sec)';
    const hrc = (w.heart_rate || 72) > 120 ? 'var(--warning)' : 'var(--text-sec)';
    return `<div class="worker-card ${w.status}" data-id="${w.id}" onclick="openWorkerDetail('${w.id}')" style="cursor:pointer">
      <div class="worker-header">
        <div>
          <div class="worker-id">${w.id} · ${w.protocol}</div>
          <div class="worker-name">${w.name} ${isSensorFaultStatus(w.status) ? '⚠' : ''} ${w.panic ? '🆘' : ''}</div>
          <div class="worker-loc" style="margin-top:2px">🎩 Helmet ${helmDot} · ⌚ Wristband ${wristDot}${wbatt === null ? '' : ` · ⌚ ${wbatt}%`}</div>
          <div class="worker-loc">📍 ${w.zone} / ${w.tunnel} · ${w.depth || 0}m depth</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="status-tag ${w.status}">${workerStatusLabel(w)}</span>
          <button class="btn-chip" style="font-size:10px" onclick="simulateWristbandSOS('${w.id}', event)">🆘 Wristband SOS</button>
        </div>
      </div>
      <div class="worker-readings">
        <div class="reading-block"><div class="reading-label">CH₄</div><div class="reading-val" style="color:${c4c}">${(w.ch4 || 0).toFixed(2)}<span style="font-size:9px">%</span></div></div>
        <div class="reading-block"><div class="reading-label">CO</div><div class="reading-val" style="color:${coc}">${w.co || 0}<span style="font-size:9px">ppm</span></div></div>
        <div class="reading-block"><div class="reading-label">O₂</div><div class="reading-val" style="color:${o2c}">${w.o2 || '—'}<span style="font-size:9px">%</span></div></div>
        <div class="reading-block"><div class="reading-label">Temp</div><div class="reading-val" style="color:${(w.temp || 22) > 35 ? 'var(--warning)' : 'var(--text-sec)'}">${w.temp || '—'}<span style="font-size:9px">°C</span></div></div>
      </div>
      <div class="worker-readings">
        <div class="reading-block"><div class="reading-label">Heart Rate</div><div class="reading-val" style="color:${hrc}">${w.heart_rate || '—'}<span style="font-size:9px">bpm</span></div></div>
        <div class="reading-block"><div class="reading-label">Risk</div><div class="reading-val" style="color:${rc}">${w.risk}<span style="font-size:9px">/10</span></div></div>
        <div class="reading-block"><div class="reading-label">RSSI</div><div class="reading-val" style="font-size:12px">${w.rssi || '—'}<span style="font-size:9px">dBm</span></div></div>
        <div class="reading-block"><div class="reading-label">Motion</div><div class="reading-val">${w.motion ? '✓' : '⏸'}</div></div>
      </div>
      <div class="worker-footer">
        <span>${w.last_seen || '—'}</span>
        <span><div class="bat-bar-wrap"><div class="bat-bar" style="width:${bp}%;background:${bc}"></div></div><span style="color:${bc}">${bp}%</span></span>
      </div>
    </div>`;
  }).join('');
}

function filterWorkers(q) {
  const f = state.workers.filter(w =>
    w.id.toLowerCase().includes(q.toLowerCase()) ||
    w.name.toLowerCase().includes(q.toLowerCase()) ||
    (w.zone || '').toLowerCase().includes(q.toLowerCase()) ||
    (w.status || '').includes(q.toLowerCase())
  );
  renderWorkerGrid(f);
}

function openAddWorkerModal() { document.getElementById('modal-add-worker')?.classList.add('open'); }

async function addWorker() {
  const id = document.getElementById('new-worker-id')?.value.trim();
  const name = document.getElementById('new-worker-name')?.value.trim();
  const zone = document.getElementById('new-worker-zone')?.value;
  const tunnel = document.getElementById('new-worker-tunnel')?.value;
  const protocol = document.getElementById('new-worker-protocol')?.value;
  const shift = document.getElementById('new-worker-shift')?.value || 'A';
  if (!id || !name) { showToast('ID and Name required', true); return; }
  if (state.backendOnline) await API.addWorker({ id, name, zone, tunnel, protocol, shift });
  state.workers.push({ id, name, zone, tunnel, protocol, shift, x: 200, y: 100, depth: 50, ch4: 0, co: 5, o2: 20.9, temp: 22, heart_rate: 72, battery: 100, wristband_battery: 100, helmet_status: 'offline', wristband_status: 'offline', panic: 0, fall: 0, motion: 1, rssi: -75, risk: 0, status: 'online', last_seen: 'Just now' });
  renderWorkerGrid(state.workers); renderWorkerTable(); updateKPIFromState();
  closeModal('modal-add-worker');
  showToast('Miner ' + id + ' registered');
}

/* ══ ALERTS PAGE ═══════════════════════════════════════════ */
function initAlertsList() { renderAlertsList(); }

function renderAlertsList(filter) {
  filter = filter || 'all';
  const el = document.getElementById('alerts-list'); if (!el) return;
  const list = filter === 'all' ? state.alerts : state.alerts.filter(a => a.level === filter);
  el.innerHTML = list.map(a => `
    <div class="alert-item ${a.level}" style="padding:12px 16px">
      <span class="alert-icon" style="font-size:20px">${a.icon || alertIcon(a.level)}</span>
      <div style="flex:1">
        <div class="alert-title">${a.title}</div>
        <div class="alert-meta">${a.desc || ''} · Worker: ${a.worker_id || '—'} · Zone: ${a.zone || '—'}</div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);white-space:nowrap">${a.time || timeAgo(a.created_at)}</div>
    </div>`).join('') || '<div style="color:var(--safe);padding:30px;text-align:center">✓ No alerts</div>';
}

function filterAlerts(level, btn) {
  document.querySelectorAll('#page-alerts .btn-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderAlertsList(level);
}

function clearAlerts() {
  state.alerts = state.alerts.filter(a => a.level === 'emergency');
  renderAlertsList(); renderAlertFeed(); updateAlertBadge();
  showToast('Non-emergency alerts cleared');
}

function showEmergencyBanner(alert) {
  const el = document.getElementById('emergency-banner'); if (!el) return;
  const isManualSOS = alert?.type === 'MANUAL_SOS' || (typeof alert?.title === 'string' && alert.title.includes('MANUAL SOS'));
  el.textContent = (isManualSOS ? '🆘 ' : '🚨 ') + alert.title + ' — ' + (alert.desc || '');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 15000);
}

/* ══ GAS PAGE ══════════════════════════════════════════════ */
function initGasPage() { updateGasCards(); }

function updateGasCards() {
  // ── Flammable Gas (MQ2 Raw ADC from ESP32, field: gas_raw) ──────────────
  // gas_raw: 12-bit ADC value (0-4095). When null, fall back to ch4*10000 estimate.
  const peakGasRaw = state.workers.reduce((a, w) => {
    const v = w.gas_raw != null ? w.gas_raw : (w.ch4 != null ? Math.round(w.ch4 * 10000) : 0);
    return Math.max(a, v);
  }, 0);
  const isRealHW = state.workers.some(w => w.gas_raw != null);
  const srcEl = document.getElementById('gas-flammable-source');
  if (srcEl) srcEl.textContent = isRealHW ? 'Source: ESP32 gas_raw (live)' : 'Source: Estimated from CH₄ (dummy)';
  setEl('gas-flammable-val', peakGasRaw);
  const fb = document.getElementById('gas-flammable-bar');
  if (fb) {
    fb.style.width = Math.min(100, peakGasRaw / 4095 * 100) + '%';
    fb.style.background = peakGasRaw >= 2000 ? 'var(--danger)' : peakGasRaw >= 1200 ? 'var(--warning)' : 'var(--safe)';
  }
  const fc = document.getElementById('gas-flammable');
  if (fc) fc.className = 'gas-card ' + (peakGasRaw >= 2000 ? 'danger' : peakGasRaw >= 1200 ? 'warn' : '');

  // ── Oxygen ──────────────────────────────────────────────────────────────
  const minO2 = state.workers.reduce((a, w) => Math.min(a, w.o2 || 21), 21);
  setEl('gas-o2-val', minO2.toFixed(1));
  const ob = document.getElementById('gas-o2-bar');
  if (ob) { ob.style.width = (minO2 / 21 * 100).toFixed(0) + '%'; ob.style.background = minO2 <= 18 ? 'var(--danger)' : minO2 <= 19.5 ? 'var(--warning)' : 'var(--accent)'; }
  const oc = document.getElementById('gas-o2');
  if (oc) oc.className = 'gas-card ' + (minO2 <= 18 ? 'danger' : minO2 <= 19.5 ? 'warn' : '');

  // ── Temperature ─────────────────────────────────────────────────────────
  const peak = k => state.workers.reduce((a, w) => Math.max(a, w[k] || 0), 0);
  const tmp = peak('temp'); setEl('gas-temp-val', tmp.toFixed(0));
  const tb = document.getElementById('gas-temp-bar');
  if (tb) { tb.style.width = Math.min(100, tmp / 45 * 100) + '%'; tb.style.background = tmp >= 40 ? 'var(--danger)' : tmp >= 35 ? 'var(--warning)' : 'var(--accent3)'; }

  // ── Pressure (BMP180) ───────────────────────────────────────────────────
  // Use the average of all workers that have a real pressure reading.
  const presReadings = state.workers.filter(w => w.pressure != null).map(w => w.pressure);
  const avgPressure = presReadings.length ? (presReadings.reduce((a, v) => a + v, 0) / presReadings.length) : null;
  setEl('gas-pressure-val', avgPressure != null ? avgPressure.toFixed(1) : '--');
  const pb = document.getElementById('gas-pressure-bar');
  if (pb && avgPressure != null) {
    // Map 850-1050 hPa range onto 0-100% bar
    pb.style.width = Math.min(100, Math.max(0, (avgPressure - 850) / 200 * 100)) + '%';
    pb.style.background = avgPressure < 900 ? 'var(--danger)' : 'var(--accent)';
  }
  const pCard = document.getElementById('gas-pressure');
  if (pCard) pCard.className = 'gas-card ' + (avgPressure != null && avgPressure < 900 ? 'danger' : '');
  const dropEl = document.getElementById('gas-pressure-drop');
  if (dropEl && avgPressure != null) {
    dropEl.style.color = avgPressure < 900 ? 'var(--danger)' : 'var(--text-muted)';
    dropEl.textContent = avgPressure < 900
      ? '⚠ LOW PRESSURE — Cave-in / Structural risk!'
      : 'Sudden drop >20 hPa → structural alert';
  }
}

function initGasCharts() {
  // Destroy old charts so they rebuild fresh with latest data
  if (state.charts.gasZone) { state.charts.gasZone.destroy(); state.charts.gasZone = null; }
  if (state.charts.ch4Miner) { state.charts.ch4Miner.destroy(); state.charts.ch4Miner = null; }
  // Zone gas chart — uses gas_raw (fallback to ch4*10000 estimate)
  const zCtx = document.getElementById('gasZoneChart')?.getContext('2d');
  if (zCtx && !state.charts.gasZone) {
    const zones = {};
    state.workers.forEach(w => {
      if (!zones[w.zone]) zones[w.zone] = { gasRaw: 0, o2min: 21 };
      const val = w.gas_raw != null ? w.gas_raw : (w.ch4 != null ? Math.round(w.ch4 * 10000) : 0);
      zones[w.zone].gasRaw = Math.max(zones[w.zone].gasRaw, val);
      zones[w.zone].o2min = Math.min(zones[w.zone].o2min, w.o2 || 21);
    });
    const zl = Object.keys(zones);
    state.charts.gasZone = new Chart(zCtx, {
      type: 'bar', data: {
        labels: zl, datasets: [
          { label: 'Peak Gas Raw (ADC)', data: zl.map(z => zones[z].gasRaw), backgroundColor: 'rgba(255,107,53,0.7)', borderRadius: 4 },
          { label: 'Min O₂ (%×100)', data: zl.map(z => (zones[z].o2min * 100).toFixed(0)), backgroundColor: 'rgba(0,212,255,0.4)', borderRadius: 4 },
        ]
      }, options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { ticks: { color: '#3d5a72' }, grid: { color: 'rgba(255,255,255,0.03)' } }, x: { ticks: { color: '#3d5a72' } } },
        plugins: { legend: { labels: { color: '#7a9cb5', usePointStyle: true } } }
      }
    });
  }
  // Per-miner Flammable Gas chart
  const cCtx = document.getElementById('ch4MinerChart')?.getContext('2d');
  if (cCtx && !state.charts.ch4Miner) {
    state.charts.ch4Miner = new Chart(cCtx, {
      type: 'bar', indexAxis: 'y', data: {
        labels: state.workers.map(w => w.id.replace('MNR', '')),
        datasets: [{
          label: 'Flammable Gas (ADC)', data: state.workers.map(w => w.gas_raw != null ? w.gas_raw : Math.round((w.ch4 || 0) * 10000)),
          backgroundColor: state.workers.map(w => {
            const v = w.gas_raw != null ? w.gas_raw : Math.round((w.ch4 || 0) * 10000);
            return v >= 2000 ? 'rgba(255,45,85,0.8)' : v >= 1200 ? 'rgba(255,107,53,0.8)' : 'rgba(0,212,255,0.4)';
          }), borderRadius: 3
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { x: { title: { display: true, text: 'Gas Raw (ADC 0-4095)', color: '#7a9cb5' }, ticks: { color: '#3d5a72' }, grid: { color: 'rgba(255,255,255,0.03)' } }, y: { ticks: { color: '#3d5a72' } } }
      }
    });
  }
}

/* ══ HEALTH PAGE ═══════════════════════════════════════════ */
function initHealthPage() { renderHealthList(); }

function renderHealthList() {
  const el = document.getElementById('health-list'); if (!el) return;
  el.innerHTML = state.workers.map(w => {
    const hrc = w.heart_rate > 130 ? 'var(--danger)' : w.heart_rate > 110 ? 'var(--warning)' : 'var(--safe)';
    const o2c = (w.o2 || 21) <= 19.5 ? 'var(--danger)' : 'var(--text-sec)';
    return `<div class="health-row">
      <span class="status-tag ${w.status}" style="width:80px;text-align:center">${workerStatusLabel(w)}</span>
      <span class="health-name">${w.name} <span style="color:var(--text-muted);font-size:11px">${w.id}</span></span>
      <span class="health-hr" style="color:${hrc}">❤ ${w.heart_rate || '—'}bpm</span>
      <span class="health-stat" style="color:${o2c}">O₂:${w.o2 || '—'}%</span>
      <span class="health-stat">T:${w.temp || '—'}°C</span>
      <span class="health-stat">🔋${w.battery || '—'}%</span>
      <span class="health-stat" style="color:var(--text-muted)">${w.zone}</span>
    </div>`;
  }).join('');
}

function initHRChart() {
  const ctx = document.getElementById('hrChart')?.getContext('2d');
  if (!ctx || state.charts.hrChart) return;
  state.charts.hrChart = new Chart(ctx, {
    type: 'bar', data: {
      labels: state.workers.map(w => w.name.split(' ')[0]),
      datasets: [{
        label: 'Heart Rate (bpm)', data: state.workers.map(w => w.heart_rate || 72),
        backgroundColor: state.workers.map(w => (w.heart_rate || 72) > 130 ? 'rgba(255,45,85,0.8)' : (w.heart_rate || 72) > 110 ? 'rgba(255,204,0,0.7)' : 'rgba(0,212,255,0.6)'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { y: { title: { display: true, text: 'BPM', color: '#3d5a72' }, ticks: { color: '#3d5a72' }, grid: { color: 'rgba(255,255,255,0.03)' } }, x: { ticks: { color: '#3d5a72' } } }
    }
  });
}

/* ══ EVACUATION PAGE ═══════════════════════════════════════ */
function initEvacPage() { renderEvacZones(); }

function renderEvacZones() {
  const el = document.getElementById('evac-zones'); if (!el) return;
  const zones = {};
  state.workers.forEach(w => {
    if (!zones[w.zone]) zones[w.zone] = { count: 0, risk: 0, names: [] };
    zones[w.zone].count++;
    zones[w.zone].risk = Math.max(zones[w.zone].risk, w.risk);
    zones[w.zone].names.push(w.name.split(' ')[0]);
  });
  el.innerHTML = Object.entries(zones).map(([name, z]) => `
    <div class="evac-zone-card" style="border-color:${z.risk >= 7 ? 'rgba(255,45,85,.3)' : z.risk >= 4 ? 'rgba(255,107,53,.2)' : 'var(--border)'}">
      <div class="evac-zone-name" style="color:${riskColor(z.risk)}">${name}</div>
      <div class="evac-zone-workers">${z.count} workers · Risk: ${z.risk.toFixed(1)}/10<br><span style="font-size:10px">${z.names.slice(0, 3).join(', ')}${z.count > 3 ? '…' : ''}</span></div>
      <button class="evac-zone-btn" onclick="evacuateZone('${name}')">🚨 EVACUATE ${name}</button>
    </div>`).join('');
}

async function loadEvacLog() {
  let evacs = state.evacuations;
  if (state.backendOnline) { const d = await API.getEvacuations(); if (d) evacs = d; }
  renderEvacLog(evacs);
}

function renderEvacLog(evacs) {
  const el = document.getElementById('evac-log'); if (!el) return;
  const list = evacs || state.evacuations;
  el.innerHTML = list.length ? list.map(e => `
    <div class="alert-item emergency">
      <span class="alert-icon">🏃</span>
      <div><div class="alert-title">Evacuation — ${e.zone}</div>
      <div class="alert-meta">${e.reason} · By: ${e.initiated_by || 'Control Room'} · ${e.status}</div></div>
      <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${timeAgo(e.created_at)}</div>
    </div>`).join('') : '<div style="color:var(--text-muted);padding:20px;text-align:center;font-size:12px">No evacuations on record</div>';
}

function openEvacuationModal() { document.getElementById('modal-evacuate')?.classList.add('open'); }
function evacuateZone(zone) { document.getElementById('evac-zone').value = zone; openEvacuationModal(); }

async function executeEvacuation() {
  const zone = document.getElementById('evac-zone')?.value;
  const reason = document.getElementById('evac-reason')?.value || 'Manual evacuation order';
  if (state.backendOnline) await API.createEvacuation({ zone, reason, initiated_by: 'Control Room' });
  const evac = { id: 'EVA-' + Date.now(), zone, reason, initiated_by: 'Control Room', status: 'active', created_at: new Date().toISOString() };
  state.evacuations.unshift(evac);
  state.alerts.unshift({ level: 'emergency', icon: '🚨', title: 'EVACUATION — ' + zone, desc: reason, time: 'Just now', zone });
  renderEvacLog(); renderAlertFeed(); updateAlertBadge();
  showEmergencyBanner({ title: 'EVACUATION ORDERED — ' + zone, desc: reason });
  closeModal('modal-evacuate');
  if (document.getElementById('evac-reason')) document.getElementById('evac-reason').value = '';
  showToast('Evacuation ordered for ' + zone);
}

/* ══ NETWORK PAGE ══════════════════════════════════════════ */
function initNetworkPage() { renderNetworkStats(); renderAnchorTable(); }

function renderNetworkStats() {
  const el = document.getElementById('lora-stats-row'); if (!el) return;
  const on = state.anchors.filter(a => a.status === 'online').length;
  const warn = state.anchors.filter(a => a.status === 'warning').length;
  const avgR = state.workers.length ? (state.workers.reduce((a, w) => a + (w.rssi || 0), 0) / state.workers.length).toFixed(0) : 0;
  const proto = {};
  state.workers.forEach(w => { proto[w.protocol] = (proto[w.protocol] || 0) + 1; });
  el.innerHTML = [
    { label: 'Anchors Online', val: `${on}/${state.anchors.length}`, color: 'var(--safe)' },
    { label: 'Anchors Warning', val: warn, color: 'var(--warning)' },
    { label: 'Avg Signal', val: `${avgR}dBm`, color: 'var(--accent)' },
    { label: 'LoRaWAN Nodes', val: proto['LoRaWAN'] || 0, color: 'var(--accent)' },
    { label: 'UWB Nodes', val: proto['UWB'] || 0, color: 'var(--accent2)' },
    { label: 'Backend', val: state.backendOnline ? 'LIVE' : 'OFFLINE', color: state.backendOnline ? 'var(--safe)' : 'var(--danger)' },
  ].map(s => `<div class="lora-stat-card"><div class="lora-stat-label">${s.label}</div><div class="lora-stat-val" style="color:${s.color}">${s.val}</div></div>`).join('');
}

function renderAnchorTable() {
  const tbody = document.getElementById('anchor-tbody'); if (!tbody) return;
  tbody.innerHTML = state.anchors.map(a => `<tr>
    <td style="font-family:var(--font-mono)">${a.id}</td>
    <td>${a.tunnel}</td>
    <td style="font-family:var(--font-mono)">(${a.x},${a.y})</td>
    <td style="font-family:var(--font-mono)">${a.depth}m</td>
    <td style="font-family:var(--font-mono);color:${(a.rssi || 0) < -85 ? 'var(--warning)' : 'var(--text-sec)'}">${a.rssi}dBm</td>
    <td><span class="status-tag ${a.status}">${a.status}</span></td>
    <td style="font-family:var(--font-mono);color:var(--text-muted)">${a.last_seen || '—'}</td>
  </tr>`).join('');
}

function initRSSIChart() {
  const ctx = document.getElementById('rssiChart')?.getContext('2d');
  if (!ctx) return;
  if (state.charts.rssiChart) { state.charts.rssiChart.destroy(); state.charts.rssiChart = null; }
  if (!state.anchors.length) {
    // Draw placeholder message if no anchor data yet
    const canvas = document.getElementById('rssiChart');
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = 'rgba(0,212,255,0.3)';
    c.font = '13px Share Tech Mono';
    c.textAlign = 'center';
    c.fillText('No anchor data yet — refresh page', (canvas.width||300)/2, (canvas.height||150)/2);
    return;
  }
  state.charts.rssiChart = new Chart(ctx, {
    type: 'bar', indexAxis: 'y', data: {
      labels: state.anchors.map(a => a.id.replace('ANC-', '')),
      datasets: [{
        label: 'RSSI (dBm)', data: state.anchors.map(a => a.rssi || 0),
        backgroundColor: state.anchors.map(a => (a.rssi || 0) < -85 ? 'rgba(255,204,0,0.7)' : 'rgba(0,212,255,0.6)'), borderRadius: 3
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: { x: { min: -100, max: -50, title: { display: true, text: 'dBm', color: '#3d5a72' }, ticks: { color: '#3d5a72' }, grid: { color: 'rgba(255,255,255,0.03)' } }, y: { ticks: { color: '#3d5a72' } } }
    }
  });
}

function updatePacketLog() {
  const log = document.getElementById('packet-log'); if (!log) return;
  const now = new Date().toLocaleTimeString('en', { hour12: false });
  const picks = [...state.workers].sort(() => Math.random() - .5).slice(0, 3);
  picks.forEach(w => {
    const div = document.createElement('div');
    div.textContent = `[${now}] ${w.id} → CH4:${(w.ch4 || 0).toFixed(3)}% CO:${w.co || 0}ppm O2:${w.o2 || '--'}% HR:${w.heart_rate || '--'}bpm [${w.protocol}]`;
    log.insertBefore(div, log.firstChild);
  });
  while (log.children.length > 60) log.removeChild(log.lastChild);
}

/* ══ INCIDENTS PAGE ════════════════════════════════════════ */
function initIncidentsList() { renderIncidentsList(); }

function renderIncidentsList() {
  const el = document.getElementById('incident-list'); if (!el) return;
  const icons = { 'Gas Leak': '💨', 'Equipment Fault': '🔧', 'Minor Injury': '🩹', 'Seismic Event': '🌍', 'Flooding': '💧', 'Fire': '🔥', 'Other': '📋' };
  el.innerHTML = state.incidents.map(i => `
    <div class="alert-item ${i.severity === 'high' || i.severity === 'critical' ? 'critical' : 'warning'}" style="padding:14px 16px">
      <span class="alert-icon" style="font-size:22px">${icons[i.type] || '📋'}</span>
      <div style="flex:1">
        <div class="alert-title">${i.type} — ${i.zone}</div>
        <div class="alert-meta">${i.description}</div>
        <div style="margin-top:4px">
          <span class="status-tag ${i.status === 'open' ? 'warning' : 'online'}">${i.status}</span>
          <span style="font-size:10px;color:var(--text-muted)"> Severity: ${i.severity} · By: ${i.reporter}</span>
        </div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono)">${timeAgo(i.created_at)}</div>
    </div>`).join('') || '<div style="color:var(--text-muted);padding:30px;text-align:center">No incidents logged</div>';
}

function openIncidentModal() { document.getElementById('modal-incident')?.classList.add('open'); }

async function submitIncident() {
  const type = document.getElementById('inc-type')?.value;
  const zone = document.getElementById('inc-zone')?.value;
  const sev = document.getElementById('inc-severity')?.value;
  const desc = document.getElementById('inc-desc')?.value;
  if (!desc) { showToast('Please add a description', true); return; }
  if (state.backendOnline) await API.createIncident({ type, zone, severity: sev, description: desc, reporter: 'Control Room' });
  state.incidents.unshift({ id: 'INC-' + Date.now(), type, zone, severity: sev, description: desc, reporter: 'Control Room', status: 'open', created_at: new Date().toISOString() });
  renderIncidentsList(); closeModal('modal-incident');
  showToast('Incident reported');
  if (document.getElementById('inc-desc')) document.getElementById('inc-desc').value = '';
}

/* ══ AI ASSISTANT ══════════════════════════════════════════ */
async function sendAIMessage() {
  const input = document.getElementById('ai-input');
  const msg = input?.value?.trim(); if (!msg) return;
  input.value = '';
  appendAIMsg('user', msg);
  const btn = document.getElementById('ai-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  const em = state.workers.filter(w => w.status === 'emergency').map(w => w.id).join(',') || 'none';
  const cr = state.workers.filter(w => w.status === 'critical').map(w => w.id + '(Risk:' + w.risk + ')').join(',') || 'none';
  const ch4 = state.workers.reduce((a, w) => Math.max(a, w.ch4 || 0), 0).toFixed(2);
  const co = state.workers.reduce((a, w) => Math.max(a, w.co || 0), 0);
  const o2 = state.workers.reduce((a, w) => Math.min(a, w.o2 || 21), 21).toFixed(1);
  const avg = state.workers.length ? (state.workers.reduce((a, w) => a + w.risk, 0) / state.workers.length).toFixed(1) : '0.0';
  const workerSummary = state.workers.map(w => `${w.id}(${w.name},${w.zone},CH4:${(w.ch4 || 0).toFixed(2)}%,CO:${w.co || 0}ppm,O2:${w.o2 || 20.9}%,HR:${w.heart_rate || 72}bpm,Risk:${w.risk},Status:${w.status})`).join(' | ');

  const mineName = state.settings?.mineName || 'the mine site';
  const systemContext = `You are SafeMine AI, underground mine safety expert for ${mineName}.
LIVE DATA: ${state.workers.length} miners underground. Emergencies: ${em}. Criticals: ${cr}.
Peak CH4: ${ch4}% (explosive >1%). Peak CO: ${co}ppm (toxic >50ppm). Min O2: ${o2}% (danger <19.5%).
Avg Risk: ${avg}/10. Backend: ${state.backendOnline ? 'LIVE' : 'OFFLINE'}.
Worker details: ${workerSummary}
Give short, practical safety advice. Use bullet points for lists. Always be specific about which miner or zone.`;

  try {
    // Route through backend /api/chat proxy (uses Groq, avoids CORS)
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemContext,
        messages: [...state.aiHistory.slice(-10), { role: 'user', content: msg }]
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'API error');
    const reply = data.content?.map(c => c.text || '').join('') || 'No response.';
    state.aiHistory.push({ role: 'user', content: msg }, { role: 'assistant', content: reply });
    if (state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);
    appendAIMsg('assistant', reply);
  } catch (e) {
    appendAIMsg('assistant', '⚠ AI error: ' + (e.message || 'Could not reach backend. Make sure `npm start` is running from the project root.'));
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
}

function appendAIMsg(role, text) {
  const log = document.getElementById('ai-chat-log'); if (!log) return;
  const div = document.createElement('div');
  div.className = 'ai-msg ' + role;
  const html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  div.innerHTML = `<div class="ai-msg-label">${role === 'user' ? '👷 Control Room' : '🤖 SafeMine AI'}</div><div class="ai-msg-text">${html}</div>`;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
}

function clearAIChat() {
  state.aiHistory = [];
  const log = document.getElementById('ai-chat-log');
  if (log) log.innerHTML = `<div class="ai-msg assistant"><div class="ai-msg-label">🤖 SafeMine AI</div><div class="ai-msg-text">Chat cleared. How can I assist?</div></div>`;
  showToast('Chat cleared');
}
function askAI(q) { document.getElementById('ai-input').value = q; sendAIMessage(); }
function handleAIKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIMessage(); } }

/* ══ LIVE UPDATES ══════════════════════════════════════════ */
function startLiveUpdates() {
  state.liveTimer = setInterval(() => {
    // Only update from backend state; never simulate workers
    updateKPIFromState(); updateGasCards();
    renderWorkerTable(); renderAgenticBanner(); renderZoneSummary();
    if (document.getElementById('page-map')?.classList.contains('active')) drawMap();
    if (document.getElementById('page-network')?.classList.contains('active')) updatePacketLog();
    if (document.getElementById('page-health')?.classList.contains('active')) renderHealthList();
  }, 4000);
}

/* ══ UTILS ═════════════════════════════════════════════════ */
function setEl(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }
function riskColor(r) {
  if (r >= 8) return 'var(--danger)';
  if (r >= 6) return 'var(--accent3)';
  if (r >= 4) return 'var(--warning)';
  if (r >= 2) return 'var(--accent)';
  return 'var(--safe)';
}
function statusColor(s) {
  return {
    emergency: '#ff2d55',
    critical: '#ff6b35',
    warning: '#ffcc00',
    stationary: '#00d4ff',
    online: '#00ff9d',
    offline: '#ff2d55',
    sensor_fault_warning: '#ffcc00',
    sensor_fault_critical: '#ff2d55',
    degraded_mode: '#ffcc00',
  }[s] || '#3a5570';
}

function isSensorFaultStatus(s) {
  return s === 'sensor_fault_warning' || s === 'sensor_fault_critical';
}

function workerStatusLabel(w) {
  if (!w) return '';
  if (w.status === 'degraded_mode') return 'Tracking via Wristband';
  return isSensorFaultStatus(w.status) ? 'Sensor Fault' : (w.status || '');
}
function alertIcon(l) { return { emergency: '🆘', critical: '🚨', warning: '⚠️', info: 'ℹ️' }[l] || '📢'; }
function timeAgo(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'Just now';
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  return Math.floor(h / 24) + ' days ago';
}
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
function showToast(msg, error) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (error ? ' error' : ''); t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 3000);
}

async function simulateWristbandSOS(workerId, e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const w = state.workers.find(x => x.id === workerId);
  if (!w) return;
  if (!state.backendOnline) { showToast('Backend offline — cannot send wristband SOS', true); return; }
  const ok = confirm(`Trigger MANUAL SOS from wristband for ${w.name} (${w.id})?`);
  if (!ok) return;
  const res = await API.wristbandIngest({
    worker_id: w.id,
    battery: Number.isFinite(Number(w.wristband_battery)) ? Number(w.wristband_battery) : 100,
    movement: !!w.motion,
    sos: true,
    signal: Number.isFinite(Number(w.rssi)) ? Number(w.rssi) : -80,
  });
  if (res?.ok) showToast('🆘 Wristband SOS sent for ' + w.id);
  else showToast('❌ Wristband SOS failed', true);
}
function exportWorkersCSV() {
  const hdr = ['ID', 'Name', 'Zone', 'Tunnel', 'Depth', 'CH4%', 'COppm', 'O2%', 'TempC', 'HR', 'Battery%', 'Risk', 'Status', 'Protocol'];
  const rows = state.workers.map(w => [w.id, w.name, w.zone, w.tunnel, w.depth, w.ch4, w.co, w.o2, w.temp, w.heart_rate, w.battery, w.risk, w.status, w.protocol].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([[hdr.join(','), ...rows].join('\n')], { type: 'text/csv' }));
  a.download = 'mineguard_' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
  showToast('CSV exported ✓');
}
function refreshData() {
  if (state.backendOnline) loadAllData().then(() => { refreshUI(); showToast('Refreshed'); });
  else {
    showToast('Backend offline — cannot refresh (no live data).', true);
  }
}
function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  document.body.classList.toggle('light-theme', state.theme === 'light');
  setEl('theme-btn', state.theme === 'dark' ? '☀' : '🌙');
}

/* ══ PREDICTIVE AI PAGE ═════════════════════════════════ */
async function loadRiskForecast() {
  let forecast;
  if (state.backendOnline) {
    const data = await fetch('/api/analytics/risk-forecast').then(r => r.json()).catch(() => null);
    forecast = data?.forecast;
  }
  if (!forecast) {
    // Compute locally from state
    forecast = state.workers.map(w => ({
      id: w.id, name: w.name, zone: w.zone, currentRisk: w.risk,
      ch4Trend: w.ch4 > 0.8 ? 'rising' : w.ch4 > 0.4 ? 'stable' : 'safe',
      prediction: w.risk >= 6 ? 'CRITICAL in <15min' : w.risk >= 4 ? 'WARNING likely' : 'STABLE',
      fatigueScore: Math.min(10, ((w.heart_rate || 72) - 60) / 8 + w.risk * 0.3).toFixed(1)
    }));
  }
  // Table
  const tbody = document.getElementById('forecast-tbody'); if (!tbody) return;
  tbody.innerHTML = forecast.map(f => {
    const pc = f.prediction.includes('CRITICAL') ? 'pred-critical' : f.prediction.includes('WARNING') ? 'pred-warning' : 'pred-stable';
    const tc = f.ch4Trend === 'rising' ? 'trend-rising' : f.ch4Trend === 'stable' ? 'trend-stable' : 'trend-safe';
    return `<tr>
      <td><strong>${f.name}</strong> <span style="color:var(--text-muted);font-size:11px">${f.id}</span></td>
      <td style="color:var(--accent)">${f.zone}</td>
      <td style="color:${riskColor(f.currentRisk)};font-family:var(--font-mono);font-weight:700">${f.currentRisk}/10</td>
      <td class="${tc}">${f.ch4Trend === 'rising' ? '↗️ Rising' : f.ch4Trend === 'stable' ? '➡️ Stable' : '↘️ Safe'}</td>
      <td style="font-family:var(--font-mono)">${f.fatigueScore}/10</td>
      <td class="${pc}">${f.prediction}</td>
    </tr>`;
  }).join('');
  // High risk list
  const hl = document.getElementById('high-risk-list'); if (hl) {
    const high = forecast.filter(f => f.currentRisk >= 4).sort((a, b) => b.currentRisk - a.currentRisk);
    hl.innerHTML = high.length ? high.map(f => `
      <div class="alert-item ${f.currentRisk >= 7 ? 'critical' : 'warning'}">
        <span class="alert-icon">${f.currentRisk >= 7 ? '🚨' : '⚠️'}</span>
        <div><div class="alert-title">${f.name}</div>
        <div class="alert-meta">${f.zone} · Risk: ${f.currentRisk}/10 · ${f.prediction}</div></div>
      </div>`).join('') : '<div style="color:var(--safe);padding:20px;text-align:center">✓ All workers safe</div>';
  }
  // Fatigue Chart
  const fCtx = document.getElementById('fatigueChart')?.getContext('2d');
  if (fCtx) {
    if (state.charts.fatigueChart) { state.charts.fatigueChart.destroy(); }
    state.charts.fatigueChart = new Chart(fCtx, {
      type: 'bar', data: {
        labels: forecast.map(f => f.name.split(' ')[0]),
        datasets: [{
          label: 'Fatigue Score', data: forecast.map(f => f.fatigueScore),
          backgroundColor: forecast.map(f => f.fatigueScore >= 7 ? 'rgba(255,45,85,0.8)' : f.fatigueScore >= 4 ? 'rgba(255,204,0,0.7)' : 'rgba(0,212,255,0.5)'), borderRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
        scales: { y: { max: 10, ticks: { color: '#3d5a72' }, grid: { color: 'rgba(255,255,255,0.03)' } }, x: { ticks: { color: '#3d5a72' } } }
      }
    });
  }
  // Zone Risk Chart
  const zCtx = document.getElementById('zoneRiskChart')?.getContext('2d');
  if (zCtx) {
    if (state.charts.zoneRiskChart) { state.charts.zoneRiskChart.destroy(); }
    const zones = {};
    state.workers.forEach(w => { if (!zones[w.zone]) zones[w.zone] = []; zones[w.zone].push(w.risk); });
    const zl = Object.keys(zones);
    const avgRisks = zl.map(z => (zones[z].reduce((a, v) => a + v, 0) / zones[z].length).toFixed(1));
    state.charts.zoneRiskChart = new Chart(zCtx, {
      type: 'radar', data: {
        labels: zl,
        datasets: [{ label: 'Avg Risk', data: avgRisks, backgroundColor: 'rgba(0,212,255,0.15)', borderColor: '#00d4ff', pointBackgroundColor: '#00d4ff' }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { r: { min: 0, max: 10, ticks: { color: '#3d5a72', stepSize: 2 }, grid: { color: 'rgba(255,255,255,0.06)' }, pointLabels: { color: '#7a9cb5' } } },
        plugins: { legend: { display: false } }
      }
    });
  }
}

/* ══ EMERGENCY SCENARIO SIMULATOR ═════════════════════════ */
async function runLiveScenario(type) {
  if (!state.backendOnline) { showToast('⚠ Backend offline — cannot run scenario', true); return; }
  if (!state.workers.length) { showToast('⚠ No workers in DB. Start LoRa simulator first.', true); return; }

  const names = { gas_spike: 'Gas Spike', panic: 'Panic Button', fall: 'Fall Detected', low_o2: 'Low Oxygen', fire: 'Fire' };
  const icons = { gas_spike: '💨', panic: '🆘', fall: '🫸', low_o2: '🫁', fire: '🔥' };
  showToast('⚡ Running scenario: ' + names[type] + '...');

  try {
    const res = await API.simulateEvent({ type });
    if (!res?.ok) { showToast('❌ Scenario failed: ' + (res?.error || 'Unknown error'), true); return; }

    const card = document.getElementById('sim-result-card');
    const el = document.getElementById('sim-results');
    if (card) card.style.display = 'block';
    if (el) {
      el.innerHTML = `
        <div class="alert-item ${type === 'gas_spike' || type === 'low_o2' ? 'critical' : 'emergency'}" style="padding:14px">
          <span class="alert-icon" style="font-size:24px">${icons[type]}</span>
          <div>
            <div class="alert-title">${names[type]} injected — ${res.workerName} (${res.workerId})</div>
            <div class="alert-meta">Alert ID: ${res.alertId} · Dashboard & alerts updated live via WebSocket</div>
            <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
              ✔ Worker status updated — Check Dashboard and Alerts page for live reaction
            </div>
          </div>
        </div>`;
    }
    showToast('✓ Scenario "' + names[type] + '" triggered on ' + res.workerName);
  } catch (e) {
    showToast('❌ Error: ' + e.message, true);
  }
}

function openBroadcastModal() { document.getElementById('modal-broadcast')?.classList.add('open'); }

async function sendBroadcast() {
  const zone = document.getElementById('bc-zone')?.value || 'ALL';
  const level = document.getElementById('bc-level')?.value || 'warning';
  const message = document.getElementById('bc-message')?.value?.trim();
  if (!message) { showToast('Please enter a message', true); return; }
  if (!state.backendOnline) { showToast('⚠ Backend offline', true); return; }
  try {
    const res = await API.broadcast({ zone, level, message });
    if (res?.ok) {
      showToast('📢 Broadcast sent to ' + zone);
      closeModal('modal-broadcast');
      document.getElementById('bc-message').value = '';
    } else {
      showToast('❌ Broadcast failed', true);
    }
  } catch (e) { showToast('Error: ' + e.message, true); }
}

async function loadRefuges() {
  let refuges = null;
  if (state.backendOnline) refuges = await API.getRefuges();
  const el = document.getElementById('refuge-list'); if (!el) return;
  const list = Array.isArray(refuges) ? refuges : [];
  if (!list.length) {
    el.innerHTML = `<div style="padding:14px;color:var(--text-muted);font-size:12px">
      No refuge chambers configured. Add them via Admin → DB or API.
    </div>`;
    return;
  }
  el.innerHTML = list.map(r => `
    <div class="zone-row">
      <span class="zone-label" style="color:var(--safe)">${r.name}</span>
      <span class="zone-count">${r.capacity} cap</span>
      <span style="font-size:11px;color:var(--text-muted);margin:0 8px">${r.zone} / ${r.tunnel}</span>
      <span style="font-size:11px;color:var(--text-muted)">${r.supplies}hr supplies</span>
      <span class="zone-status" style="color:var(--safe)">${r.status.toUpperCase()}</span>
    </div>`).join('');
}

/* ══ DRONES PAGE ════════════════════════════════════════════ */
async function loadDrones() {
  const drones = state.backendOnline ? (await API.getDrones()) : null;
  const list = Array.isArray(drones) ? drones : [];
  // Stats row
  const sr = document.getElementById('drone-stats-row'); if (sr) {
    if (!list.length) {
      sr.innerHTML = `<div class="lora-stat-card"><div class="lora-stat-label">Drones</div><div class="lora-stat-val" style="color:var(--text-muted)">Not configured</div></div>`;
    } else {
      const active = list.filter(d => d.status === 'active').length;
      sr.innerHTML = [
        { label: 'Active Drones', val: active, color: 'var(--safe)' },
        { label: 'Standby Drones', val: list.length - active, color: 'var(--warning)' },
        { label: 'Fleet Battery', val: Math.round(list.reduce((a, d) => a + (d.battery || 0), 0) / list.length) + '%', color: 'var(--accent)' },
        { label: 'Zones Monitored', val: [...new Set(list.filter(d => d.status === 'active').map(d => d.zone))].join(', ') || 'None', color: 'var(--accent)' },
      ].map(s => `<div class="lora-stat-card"><div class="lora-stat-label">${s.label}</div><div class="lora-stat-val" style="color:${s.color}">${s.val}</div></div>`).join('');
    }
  }
  // Drone grid
  const grid = document.getElementById('drone-grid'); if (grid) {
    if (!list.length) {
      grid.innerHTML = `<div style="padding:18px;color:var(--text-muted)">No drones configured.</div>`;
      return;
    }
    grid.innerHTML = list.map(d => {
      const bc = d.battery < 30 ? 'var(--danger)' : d.battery < 60 ? 'var(--warning)' : 'var(--safe)';
      return `<div class="drone-card ${d.status}">
        <div class="worker-header">
          <div>
            <div class="worker-id">${d.id}</div>
            <div class="worker-name">🚁 ${d.name}</div>
            <div class="worker-loc">📍 ${d.zone}</div>
          </div>
          <span class="status-tag ${d.status === 'active' ? 'online' : 'warning'}">${d.status.toUpperCase()}</span>
        </div>
        <div class="worker-readings" style="margin-top:12px">
          <div class="reading-block"><div class="reading-label">Battery</div><div class="reading-val" style="color:${bc}">${d.battery}<span style="font-size:9px">%</span></div></div>
          <div class="reading-block"><div class="reading-label">Last Scan</div><div class="reading-val" style="font-size:12px">${timeAgo(d.lastInspection)}</div></div>
        </div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <button class="btn-primary" style="flex:1;font-size:11px" onclick="deployDrone('${d.id}')">Deploy</button>
          <button class="btn-secondary" style="flex:1;font-size:11px">Recall</button>
        </div>
      </div>`;
    }).join('');
  }
}

async function deployDrone(id) {
  const zone = prompt('Deploy to zone? (e.g. Zone C)');
  if (!zone) return;
  if (state.backendOnline) await API.deployDrone(id, { zone });
  showToast('🚁 Drone ' + id + ' deployed to ' + zone);
  loadDrones();
}

/* ══ MUSTER REPORT ══════════════════════════════════════════ */
async function loadMusterReport() {
  let report;
  if (state.backendOnline) {
    report = await fetch('/api/muster').then(r => r.json()).catch(() => null);
  }
  if (!report) return;
  // KPI row
  const kr = document.getElementById('muster-kpi-row'); if (kr) {
    kr.innerHTML = [
      { icon: '👷', val: report.total, label: 'Total Underground', color: 'var(--text)' },
      { icon: '✅', val: report.accounted, label: 'Accounted For', color: 'var(--safe)' },
      { icon: '❌', val: report.missing?.length || 0, label: 'Missing/Offline', color: 'var(--danger)' },
      { icon: '🚨', val: report.emergency?.length || 0, label: 'In Emergency', color: 'var(--danger)' },
    ].map(k => `<div class="kpi-card ${k.val > 0 && k.color === 'var(--danger)' ? 'danger' : ''}"><div class="kpi-icon">${k.icon}</div><div class="kpi-body"><div class="kpi-value" style="color:${k.color}">${k.val}</div><div class="kpi-label">${k.label}</div></div></div>`).join('');
  }
  // Time
  setEl('muster-time', new Date(report.generatedAt).toLocaleTimeString());
  // Zone summary
  const mz = document.getElementById('muster-zones'); if (mz) {
    mz.innerHTML = Object.entries(report.byZone || {}).map(([zone, workers]) => {
      const em = workers.filter(w => w.status === 'emergency').length;
      const cr = workers.filter(w => w.status === 'critical').length;
      const col = em > 0 ? 'var(--danger)' : cr > 0 ? 'var(--accent3)' : 'var(--safe)';
      return `<div class="zone-row">
        <span class="zone-label" style="color:${col}">${zone}</span>
        <span class="zone-count">${workers.length} workers</span>
        <span style="font-size:11px;color:var(--text-muted);flex:1;margin:0 8px">${workers.map(w => w.name.split(' ')[0]).join(', ')}</span>
        <span class="zone-status" style="color:${col}">${em > 0 ? 'EMERGENCY' : cr > 0 ? 'CRITICAL' : 'SAFE'}</span>
      </div>`;
    }).join('');
  }
  // Missing
  const mm = document.getElementById('muster-missing'); if (mm) {
    mm.innerHTML = (report.missing?.length) ? report.missing.map(w => `
      <div class="alert-item critical"><span class="alert-icon">❌</span>
      <div><div class="alert-title">${w.name} (${w.id})</div><div class="alert-meta">Last seen: ${w.last_seen || '—'}</div></div></div>`).join('')
      : '<div style="color:var(--safe);padding:16px;text-align:center">✓ All workers accounted for</div>';
  }
  // Emergency
  const me = document.getElementById('muster-emergency'); if (me) {
    me.innerHTML = (report.emergency?.length) ? report.emergency.map(w => `
      <div class="alert-item emergency"><span class="alert-icon">🚨</span>
      <div><div class="alert-title">${w.name} (${w.id})</div><div class="alert-meta">EMERGENCY — requires immediate rescue</div></div></div>`).join('')
      : '<div style="color:var(--safe);padding:16px;text-align:center">✓ No emergencies</div>';
  }
  // Detail table
  const tb = document.getElementById('muster-tbody'); if (tb) {
    tb.innerHTML = state.workers.map(w => `<tr>
      <td style="font-family:var(--font-mono)">${w.id}</td>
      <td><strong>${w.name}</strong></td>
      <td style="color:var(--accent)">${w.zone}</td>
      <td><span class="status-tag ${w.status}">${workerStatusLabel(w)}</span></td>
      <td style="color:var(--text-muted);font-family:var(--font-mono)">${w.last_seen || '—'}</td>
    </tr>`).join('');
  }
}

function exportMusterPDF() {
  const rows = state.workers.map(w => [w.id, w.name, w.zone, w.tunnel, w.status, w.last_seen || '—'].join(','));
  const csv = 'ID,Name,Zone,Tunnel,Status,Last Seen\n' + rows.join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'muster_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click(); showToast('Muster report exported ✓');
}

/* ══ MAINTENANCE ═══════════════════════════════════════════════ */
async function loadSensorFaultsPage() {
  const el = document.getElementById('sensor-faults-list');
  if (!el) return;
  if (!state.backendOnline) {
    el.innerHTML = '<div style="color:var(--danger);padding:16px;text-align:center">Backend offline — no sensor health data.</div>';
    return;
  }
  el.innerHTML = '<div style="color:var(--text-muted);padding:16px;text-align:center">Loading sensor faults…</div>';
  const faults = await API.getSensorFaults({ unresolvedOnly: 'false', limit: 200 }) || [];
  state.sensorFaults = Array.isArray(faults) ? faults : [];
  renderSensorFaults();
}

function renderSensorFaults() {
  const el = document.getElementById('sensor-faults-list'); if (!el) return;
  if (!state.sensorFaults?.length) {
    el.innerHTML = '<div style="color:var(--safe);padding:16px;text-align:center">✓ No recorded sensor faults</div>';
    return;
  }
  el.innerHTML = state.sensorFaults.map(f => {
    const lvl = f.severity || 'warning';
    const isResolved = f.repair_status === 'resolved';
    const sensorLabel = String(f.sensor || 'telemetry').toUpperCase();
    const workerLabel = f.worker_name ? `${f.worker_name} (${f.worker_id})` : (f.worker_id || '—');
    const lastTs = f.last_detected_at || f.first_detected_at || f.updated_at;
    return `<div class="alert-item ${lvl}" style="align-items:center">
      <span class="alert-icon">${lvl === 'critical' ? '🚨' : '⚠️'}</span>
      <div style="flex:1">
        <div class="alert-title">${sensorLabel} · ${workerLabel}</div>
        <div class="alert-meta">
          Repair: ${f.repair_status || 'required'} · First: ${timeAgo(f.first_detected_at)} · Last: ${timeAgo(lastTs)}
        </div>
      </div>
      <button class="btn-chip" style="font-size:10px;margin-left:8px" ${isResolved ? 'disabled' : ''} onclick="resolveSensorFault('${f.id}')">
        ${isResolved ? 'Resolved' : 'Mark Resolved'}
      </button>
    </div>`;
  }).join('');
}

async function resolveSensorFault(id) {
  const note = prompt('Optional maintenance note (e.g., "Replaced CH4 sensor, recalibrated").');
  await API.resolveSensorFault(id, { notes: note || '' });
  showToast('Sensor fault marked as resolved');
  loadSensorFaultsPage();
}

/* ══ GEOFENCES ════════════════════════════════════════════════ */
let state_geofences = [];
async function loadGeofences() {
  state_geofences = [];
  if (state.backendOnline) {
    const data = await API.getGeofences();
    if (Array.isArray(data)) state_geofences = data;
  }
  renderGeofenceTable();
  drawGeofenceMap();
}

function renderGeofenceTable() {
  const tbody = document.getElementById('geofence-tbody'); if (!tbody) return;
  tbody.innerHTML = state_geofences.map(gf => {
    const workersInside = state.workers.filter(w => {
      const dist = Math.sqrt(Math.pow(w.x - gf.cx, 2) + Math.pow(w.y - gf.cy, 2));
      return dist <= gf.radius;
    });
    const typeClass = 'gf-' + gf.type;
    return `<tr>
      <td><strong>${gf.name}</strong></td>
      <td style="color:var(--accent)">${gf.zone}</td>
      <td class="${typeClass}">${gf.type.toUpperCase()}</td>
      <td style="font-family:var(--font-mono)">${gf.radius}u</td>
      <td><span class="status-tag ${gf.active ? 'online' : 'warning'}">${gf.active ? 'ACTIVE' : 'INACTIVE'}</span></td>
      <td style="color:${workersInside.length > 0 && gf.type === 'hazard' ? 'var(--danger)' : 'var(--text-sec)'}">
        ${workersInside.length} ${workersInside.length > 0 ? '(' + workersInside.map(w => w.id.replace('MNR-', '')).join(',') + ')' : ''}
      </td>
    </tr>`;
  }).join('');
}

function drawGeofenceMap() {
  const canvas = document.getElementById('geofence-canvas'); if (!canvas) return;
  const W = canvas.parentElement.clientWidth - 32 || 800;
  const H = 260; canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const sX = W / 900, sY = H / 500;
  ctx.fillStyle = '#050a10'; ctx.fillRect(0, 0, W, H);
  // Draw tunnels (simplified)
  ctx.strokeStyle = 'rgba(0,212,255,0.3)'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  [[170, 30, 170, 460], [170, 160, 400, 160], [370, 160, 370, 250, 580, 250], [170, 310, 620, 310], [590, 250, 750, 250, 750, 360], [620, 310, 870, 310, 870, 430]].forEach(pts => {
    ctx.beginPath(); ctx.moveTo(pts[0] * sX, pts[1] * sY);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * sX, pts[i + 1] * sY);
    ctx.stroke();
  });
  // Draw geofences
  state_geofences.forEach(gf => {
    const col = gf.type === 'hazard' ? 'rgba(255,45,85,0.5)' : gf.type === 'restricted' ? 'rgba(255,204,0,0.5)' : 'rgba(0,255,157,0.5)';
    ctx.beginPath(); ctx.arc(gf.cx * sX, gf.cy * sY, gf.radius * Math.min(sX, sY), 0, Math.PI * 2);
    ctx.fillStyle = col.replace('0.5', '0.12'); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = col.replace('0.5', '0.8'); ctx.font = '10px Share Tech Mono'; ctx.textAlign = 'center';
    ctx.fillText(gf.name.slice(0, 18), gf.cx * sX, gf.cy * sY + gf.radius * Math.min(sX, sY) + 14);
  });
  // Workers
  state.workers.forEach(w => {
    const col = statusColor(w.status);
    ctx.beginPath(); ctx.arc(w.x * sX, w.y * sY, 5, 0, Math.PI * 2);
    ctx.fillStyle = col; ctx.fill();
  });
}

function openAddGeofenceModal() { document.getElementById('modal-add-geofence')?.classList.add('open'); }
async function addGeofence() {
  const name = document.getElementById('gf-name')?.value; const zone = document.getElementById('gf-zone')?.value;
  const type = document.getElementById('gf-type')?.value; const radius = parseInt(document.getElementById('gf-radius')?.value || 60);
  if (!name) { showToast('Name required', true); return; }
  const gf = { id: 'gf-' + Date.now(), name, zone, type, radius, cx: 300, cy: 200, active: true };
  if (!state.backendOnline) { showToast('Backend offline — cannot add geofence.', true); return; }
  const res = await API.addGeofence(gf);
  if (res?.geofence) state_geofences.unshift(res.geofence);
  renderGeofenceTable(); drawGeofenceMap();
  closeModal('modal-add-geofence'); showToast('Geofence “' + name + '” added');
}

/* ══ ADMIN SETTINGS ═════════════════════════════════════════════ */
async function loadAdminSettings() {
  let settings;
  if (state.backendOnline) {
    settings = await API.getSettings();
  }
  if (!settings) return;
  state.settings = settings;
  // Update top badge
  const badge = document.querySelector('.mine-badge');
  if (badge) {
    const name = settings.mineName || 'Mine Not Configured';
    const lvl = settings.mineLevel ? `Level ${settings.mineLevel}` : 'Level —';
    badge.textContent = `${name} · ${lvl} · ${state.backendOnline ? 'LIVE' : 'OFFLINE'}`;
  }
  document.getElementById('cfg-mine-name').value = settings.mineName || '';
  if (document.getElementById('cfg-mine-lat')) document.getElementById('cfg-mine-lat').value = (settings.mineLat ?? '');
  if (document.getElementById('cfg-mine-lng')) document.getElementById('cfg-mine-lng').value = (settings.mineLng ?? '');
  document.getElementById('cfg-shift-a').value = settings.shiftA || '';
  document.getElementById('cfg-shift-b').value = settings.shiftB || '';
  document.getElementById('cfg-max-workers').value = settings.maxWorkersUnderground || 50;
  document.getElementById('cfg-lora-interval').value = settings.loraInterval || 30;
  document.getElementById('cfg-auto-evac').checked = !!settings.autoEvacuation;
  const t = settings.alertThresholds || {};
  document.getElementById('thr-ch4-warn').value = t.ch4_warn || 0.5;
  document.getElementById('thr-ch4-crit').value = t.ch4_crit || 1.0;
  document.getElementById('thr-co-warn').value = t.co_warn || 25;
  document.getElementById('thr-co-crit').value = t.co_crit || 50;
  document.getElementById('thr-o2-low').value = t.o2_low || 19.5;
  document.getElementById('thr-temp-high').value = t.temp_high || 35;
  document.getElementById('thr-hr-high').value = t.hr_high || 130;
  document.getElementById('thr-battery-low').value = t.battery_low || 15;
  // System status
  const ss = document.getElementById('admin-sys-status'); if (ss) {
    ss.innerHTML = [
      { label: 'Backend', val: state.backendOnline ? 'ONLINE' : 'OFFLINE', col: state.backendOnline ? 'var(--safe)' : 'var(--danger)' },
      { label: 'Workers', val: state.workers.length + ' tracked', col: 'var(--text)' },
      { label: 'Anchors', val: state.anchors.filter(a => a.status === 'online').length + '/' + state.anchors.length, col: 'var(--accent)' },
      { label: 'Active Alerts', val: state.alerts.filter(a => a.level === 'critical' || a.level === 'emergency').length, col: 'var(--warning)' },
      { label: 'MQTT', val: settings.mqtt ? 'LIVE' : 'OFF', col: settings.mqtt ? 'var(--safe)' : 'var(--danger)' },
    ].map(s => `<div class="zone-row"><span class="zone-label">${s.label}</span><span class="zone-status" style="color:${s.col}">${s.val}</span></div>`).join('');
  }
}

async function saveAdminSettings() {
  const body = {
    mineName: document.getElementById('cfg-mine-name')?.value,
    mineLat: parseFloat(document.getElementById('cfg-mine-lat')?.value || ''),
    mineLng: parseFloat(document.getElementById('cfg-mine-lng')?.value || ''),
    shiftA: document.getElementById('cfg-shift-a')?.value,
    shiftB: document.getElementById('cfg-shift-b')?.value,
    maxWorkersUnderground: parseInt(document.getElementById('cfg-max-workers')?.value || 50),
    loraInterval: parseInt(document.getElementById('cfg-lora-interval')?.value || 30),
    autoEvacuation: document.getElementById('cfg-auto-evac')?.checked,
    alertThresholds: {
      ch4_warn: parseFloat(document.getElementById('thr-ch4-warn')?.value || 0.5),
      ch4_crit: parseFloat(document.getElementById('thr-ch4-crit')?.value || 1.0),
      co_warn: parseInt(document.getElementById('thr-co-warn')?.value || 25),
      co_crit: parseInt(document.getElementById('thr-co-crit')?.value || 50),
      o2_low: parseFloat(document.getElementById('thr-o2-low')?.value || 19.5),
      temp_high: parseInt(document.getElementById('thr-temp-high')?.value || 35),
      hr_high: parseInt(document.getElementById('thr-hr-high')?.value || 130),
      battery_low: parseInt(document.getElementById('thr-battery-low')?.value || 15),
    }
  };
  if (state.backendOnline) {
    await API.putSettings(body);
  }
  showToast('✓ Settings saved');
}

function exportAllAlerts() {
  const hdr = ['ID', 'Level', 'Title', 'Description', 'Worker', 'Zone', 'Time'];
  const rows = state.alerts.map(a => [a.id, a.level, a.title, (a.desc || '').replace(/,/g, ';'), a.worker_id || '', a.zone || '', a.created_at || a.time || ''].join(','));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([[hdr.join(','), ...rows].join('\n')], { type: 'text/csv' }));
  a.download = 'alerts_' + new Date().toISOString().slice(0, 10) + '.csv'; a.click();
  showToast('Alerts CSV exported ✓');
}

async function clearOldAlerts() {
  state.alerts = state.alerts.filter(a => {
    const age = (Date.now() - new Date(a.created_at || 0).getTime()) / 3600000;
    return age < 24;
  });
  renderAlertsList(); renderAlertFeed(); updateAlertBadge();
  showToast('Old alerts cleared ✓');
}

function confirmClearDB() {
  if (confirm('This admin action is only for LOCAL DEMO.\n\nIt will reset all worker/alert data to demo values.\nNEVER use on a live mine system.\n\nContinue?')) {
    showToast('🔄 For demo reset: run `npm run demo-setup` (this recreates mineguard.db with sample miners).');
  }
}

/* ══ WORKER DETAIL MODAL ═══════════════════════════════ */
let _selectedWorkerId = null;

function openWorkerDetail(workerId) {
  const w = state.workers.find(x => x.id === workerId);
  if (!w) return;
  _selectedWorkerId = workerId;
  const rc = riskColor(w.risk);
  const title = document.getElementById('wd-title');
  const body = document.getElementById('wd-body');
  if (title) title.textContent = `👷 ${w.name} (${w.id})`;
  if (body) body.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:4px 0">
      <div class="form-group" style="margin:0">
        <label>Zone / Tunnel</label>
        <div style="color:var(--accent);font-weight:600">${w.zone} / ${w.tunnel}</div>
      </div>
      <div class="form-group" style="margin:0">
        <label>Depth</label>
        <div style="color:var(--text);font-weight:600">${w.depth || 0} m</div>
      </div>
      <div class="form-group" style="margin:0">
        <label>Status</label>
        <span class="status-tag ${w.status}">${workerStatusLabel(w)}</span>
      </div>
      <div class="form-group" style="margin:0">
        <label>Protocol</label>
        <div style="color:var(--text-sec)">${w.protocol || 'LoRaWAN'}</div>
      </div>
    </div>
    <div style="margin-top:14px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center">
        ${[['CH₄', (w.ch4 || 0).toFixed(2) + '%', (w.ch4 || 0) >= 1.0 ? 'var(--danger)' : (w.ch4 || 0) >= 0.5 ? 'var(--warning)' : 'var(--safe)'],
    ['CO', (w.co || 0) + 'ppm', (w.co || 0) >= 50 ? 'var(--danger)' : (w.co || 0) >= 25 ? 'var(--warning)' : 'var(--safe)'],
    ['O₂', (w.o2 || 20.9) + '%', (w.o2 || 20.9) < 19.5 ? 'var(--danger)' : 'var(--safe)'],
    ['Temp', (w.temp || 22) + '°C', (w.temp || 22) > 35 ? 'var(--warning)' : 'var(--text-sec)'],
    ['Heart Rate', (w.heart_rate || 72) + ' bpm', (w.heart_rate || 72) > 120 ? 'var(--warning)' : 'var(--safe)'],
    ['Risk Score', w.risk + '/10', rc],
    ['Battery', (w.battery || 0) + '%', (w.battery || 0) < 20 ? 'var(--danger)' : (w.battery || 0) < 40 ? 'var(--warning)' : 'var(--safe)'],
    ['Motion', w.motion ? '✓ Moving' : '⏸ Still', w.motion ? 'var(--safe)' : 'var(--warning)'],
    ].map(([l, v, c]) => `<div><div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${l}</div><div style="font-size:16px;font-weight:700;color:${c};font-family:var(--font-mono)">${v}</div></div>`).join('')}
      </div>
    </div>
    <div style="margin-top:12px;padding:8px 12px;background:rgba(255,45,85,0.05);border:1px solid rgba(255,45,85,0.2);border-radius:6px;font-size:11px;color:var(--text-muted)">
      ⚠️ Last seen: ${w.last_seen || '—'} · RSSI: ${w.rssi || '—'} dBm · Panic: ${w.panic ? 'YES 🆘' : 'No'} · Fall: ${w.fall ? 'YES ⚠️' : 'No'}
    </div>
  `;
  document.getElementById('modal-worker-detail')?.classList.add('open');
}

async function triggerWorkerSOS() {
  if (!_selectedWorkerId) { showToast('No worker selected', true); return; }
  if (!state.backendOnline) { showToast('⚠ Backend offline', true); return; }
  const w = state.workers.find(x => x.id === _selectedWorkerId);
  const confirmed = confirm(`Send SOS/emergency signal for ${w?.name || _selectedWorkerId}?\n\nThis will trigger an emergency alert on the dashboard.`);
  if (!confirmed) return;
  try {
    const res = await API.sendSOS(_selectedWorkerId);
    if (res?.ok) {
      showToast('🆘 SOS sent for ' + (w?.name || _selectedWorkerId));
      closeModal('modal-worker-detail');
    } else {
      showToast('❌ SOS failed: ' + (res?.error || 'Unknown'), true);
    }
  } catch (e) { showToast('Error: ' + e.message, true); }
}

async function pingNode() {
  if (!_selectedWorkerId) return;
  if (!state.backendOnline) { showToast('⚠ Backend offline', true); return; }
  try {
    const res = await API.pingWorker(_selectedWorkerId);
    if (res?.ok) {
      showToast('📶 Connection Test signal (Ping) sent to ' + _selectedWorkerId);
    } else {
      showToast('❌ Ping failed', true);
    }
  } catch (e) { showToast('Error: ' + e.message, true); }
}

/* ══ ESCALATION PANEL ════════════════════════════════ */
function renderEscalationPanel() {
  let panel = document.getElementById('escalation-panel');
  const entries = Object.entries(state.escalations);
  if (!entries.length) {
    if (panel) panel.style.display = 'none';
    return;
  }
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'escalation-panel';
    panel.style.cssText = 'position:fixed;bottom:90px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:340px';
    document.body.appendChild(panel);
  }
  panel.style.display = 'flex';
  panel.innerHTML = entries.map(([wid, e]) => {
    const stageColors = { warning: '#ffcc00', critical: '#ff6b35', panic: '#ff2d55' };
    const stageIcons  = { warning: '⚠️', critical: '🚨', panic: '🋝 PANIC' };
    const col = stageColors[e.stage] || '#fff';
    const pct = e.countdown > 0 ? (e.countdown / (e.stage === 'warning' ? 10 : 20) * 100).toFixed(0) : 0;
    return `
      <div style="background:rgba(5,10,16,0.97);border:2px solid ${col};border-radius:10px;padding:12px 16px;box-shadow:0 0 20px ${col}44">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="color:${col};font-weight:700;font-size:13px;font-family:monospace">${stageIcons[e.stage] || ''} ${e.stage.toUpperCase()} ESCALATION</span>
          <button onclick="cancelEscalationUI('${wid}')" style="background:transparent;border:1px solid ${col}44;color:${col};border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px">✓ Resolved</button>
        </div>
        <div style="color:#e8f2fa;font-size:12px;margin-bottom:6px">${e.workerName} &mdash; ${e.zone}</div>
        ${e.countdown > 0 ? `<div style="margin-bottom:4px">
          <div style="background:rgba(255,255,255,0.1);border-radius:4px;height:6px">
            <div style="height:100%;border-radius:4px;background:${col};width:${pct}%;transition:width 1s linear"></div>
          </div>
          <div style="color:${col};font-size:11px;font-family:monospace;margin-top:3px">⏱ Escalates in ${e.countdown}s</div>
        </div>` : '<div style="color:#ff2d55;font-size:11px;font-family:monospace">🚨 MAX ESCALATION REACHED</div>'}
      </div>`;
  }).join('');
}

async function cancelEscalationUI(workerId) {
  if (state.escalations[workerId]?.intervalId) clearInterval(state.escalations[workerId].intervalId);
  delete state.escalations[workerId];
  renderEscalationPanel();
  if (state.backendOnline) {
    try { await fetch('/api/workers/' + workerId + '/escalate/cancel', { method: 'POST' }); } catch (e) {}
  }
  showToast('✓ Escalation cancelled for ' + workerId);
}

function playEscalationTone(stage) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const freqs = { warning: [660, 700], critical: [800, 880], panic: [1000, 1200] };
    const [f1, f2] = freqs[stage] || [660, 700];
    osc.frequency.setValueAtTime(f1, ctx.currentTime);
    osc.frequency.setValueAtTime(f2, ctx.currentTime + 0.15);
    osc.frequency.setValueAtTime(f1, ctx.currentTime + 0.3);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + (stage === 'panic' ? 1.5 : 0.8));
    osc.start(); osc.stop(ctx.currentTime + (stage === 'panic' ? 1.5 : 0.8));
  } catch (e) {}
}

/* ══ SENSOR FUSION TOAST ════════════════════════════ */
function showFusionToast(alert) {
  const container = document.getElementById('fusion-toast-container') || (() => {
    const el = document.createElement('div');
    el.id = 'fusion-toast-container';
    el.style.cssText = 'position:fixed;top:70px;right:20px;z-index:9998;display:flex;flex-direction:column;gap:8px;max-width:360px';
    document.body.appendChild(el);
    return el;
  })();
  const toast = document.createElement('div');
  const col = alert.level === 'emergency' ? '#ff2d55' : '#ff6b35';
  toast.style.cssText = `background:rgba(5,10,16,0.97);border:2px solid ${col};border-radius:10px;padding:12px 16px;box-shadow:0 0 24px ${col}55;animation:fadeIn 0.3s ease`;
  toast.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start">
      <span style="font-size:22px">🔗</span>
      <div>
        <div style="color:${col};font-weight:700;font-size:12px;letter-spacing:1px;margin-bottom:4px">SENSOR FUSION ALERT</div>
        <div style="color:#e8f2fa;font-size:12px;font-weight:600;margin-bottom:4px">${alert.title}</div>
        <div style="color:#7a9cb5;font-size:11px">${(alert.desc || '').slice(0, 120)}</div>
      </div>
    </div>`;
  container.prepend(toast);
  setTimeout(() => toast.remove(), 12000);
}

/* ══ AI CHAT (Claude-powered) ══════════════════════════ */
async function sendAIChat(userMsg) {
  if (!userMsg?.trim()) return;
  if (!state.backendOnline) { showToast('⚠ Backend offline — AI unavailable', true); return; }
  const chatLog = document.getElementById('ai-chat-log');
  const input = document.getElementById('ai-chat-input');
  if (input) input.value = '';

  // Add user message
  state.aiHistory.push({ role: 'user', content: userMsg });
  if (chatLog) {
    chatLog.innerHTML += `<div style="display:flex;justify-content:flex-end;margin-bottom:12px"><div style="background:rgba(0,212,255,0.12);border:1px solid rgba(0,212,255,0.25);border-radius:12px 12px 2px 12px;padding:10px 14px;max-width:80%;font-size:13px;color:#e8f2fa">${userMsg}</div></div>`;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // Show typing indicator
  const typingId = 'typing-' + Date.now();
  if (chatLog) {
    chatLog.innerHTML += `<div id="${typingId}" style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><div style="width:32px;height:32px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.3);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px">🤖</div><div style="color:#7a9cb5;font-size:12px;font-family:monospace">●●● Analyzing mine data...</div></div>`;
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.aiHistory })
    });
    const data = await res.json();
    document.getElementById(typingId)?.remove();

    if (data.error) {
      if (chatLog) chatLog.innerHTML += `<div style="color:#ff6b35;padding:8px 12px;font-size:12px">⚠️ AI Error: ${data.error}</div>`;
      return;
    }

    const reply = data.content?.[0]?.text || 'No response.';
    state.aiHistory.push({ role: 'assistant', content: reply });
    // Keep history manageable
    if (state.aiHistory.length > 20) state.aiHistory = state.aiHistory.slice(-20);

    if (chatLog) {
      // Render markdown-like formatting
      const formatted = reply
        .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#00d4ff">$1</strong>')
        .replace(/\*(.+?)\*/g, '<em style="color:#ffcc00">$1</em>')
        .replace(/`(.+?)`/g, '<code style="background:rgba(0,212,255,0.1);padding:1px 4px;border-radius:3px;font-family:monospace">$1</code>')
        .replace(/^- (.+)/gm, '• $1')
        .replace(/\n/g, '<br>');
      chatLog.innerHTML += `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">
        <div style="width:32px;height:32px;background:rgba(0,212,255,0.15);border:1px solid rgba(0,212,255,0.3);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">🤖</div>
        <div style="background:rgba(0,20,35,0.8);border:1px solid rgba(0,212,255,0.15);border-radius:2px 12px 12px 12px;padding:12px 14px;max-width:85%;font-size:13px;line-height:1.6;color:#c8dce8">${formatted}</div>
      </div>`;
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  } catch (err) {
    document.getElementById(typingId)?.remove();
    if (chatLog) chatLog.innerHTML += `<div style="color:#ff6b35;padding:8px 12px;font-size:12px">❌ Connection error: ${err.message}</div>`;
  }
}

function handleAIChatKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const input = document.getElementById('ai-chat-input');
    if (input?.value.trim()) sendAIChat(input.value.trim());
  }
}

function clearAIChat() {
  state.aiHistory = [];
  const log = document.getElementById('ai-chat-log');
  if (log) log.innerHTML = `<div style="color:#3d5a72;font-size:12px;padding:20px;text-align:center">🤖 SafeMine AI (Claude) ready. Powered by real-time mine telemetry.<br><br>Try: “What’s the current risk status?” or “Explain what CH4 1.2% means”</div>`;
}
