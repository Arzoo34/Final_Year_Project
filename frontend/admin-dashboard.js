// ============================================================
//  MineGuard Pro — admin-dashboard.js
//  Admin Dashboard, Emergency Comms, Optimization Engine UI
// ============================================================

/* ── State ──────────────────────────────────────────────────── */
let _admDashData  = null;
let _optimData    = null;
let _admRefreshTimer = null;

/* ── Page Navigation Hook ───────────────────────────────────── */
// Called from app.js navigateTo() — integrate in app.js showPage()
function onAdminDashShow() {
  loadAdminDash();
  loadCommsLog();
  // Auto-refresh every 15s while on page
  clearInterval(_admRefreshTimer);
  _admRefreshTimer = setInterval(() => {
    if (document.getElementById('page-admindash')?.classList.contains('active')) loadAdminDash();
  }, 15000);
}
function onOptimShow() {
  runOptimizationNow();
}

/* ═══════════════════════════════════════════════════════════
   ADMIN DASHBOARD
═══════════════════════════════════════════════════════════ */
async function loadAdminDash() {
  try {
    const res = await fetch('/api/admin/dashboard');
    if (!res.ok) throw new Error('API error');
    _admDashData = await res.json();
    renderAdminDash(_admDashData);
  } catch (e) {
    console.warn('[AdminDash] Load failed:', e.message);
  }
}

function renderAdminDash(d) {
  if (!d) return;
  const ov = d.overview || {};

  // KPI bar
  _setTxt('adm-kpi-total',  ov.totalWorkers ?? '--');
  _setTxt('adm-kpi-emerg',  ov.emergency ?? 0);
  _setTxt('adm-kpi-crit',   ov.critical ?? 0);
  _setTxt('adm-kpi-safety', (ov.safetyScore ?? '--') + '%');
  _setTxt('adm-kpi-alerts', (d.activeAlerts || []).length);
  _setTxt('adm-kpi-optim',  d.optimSummary ? d.optimSummary.globalRisk.toFixed(1) : '--');

  // Safety ring
  const score = ov.safetyScore ?? 0;
  const arc = document.getElementById('adm-ring-arc');
  const circumference = 289;
  const offset = circumference - (score / 100) * circumference;
  if (arc) {
    arc.style.strokeDashoffset = offset;
    arc.style.stroke = score >= 70 ? '#00ff9d' : score >= 40 ? '#ffcc00' : '#ff2d55';
  }
  _setTxt('adm-ring-val', score + '%');
  const rv = document.getElementById('adm-ring-val');
  if (rv) rv.style.fill = score >= 70 ? '#00ff9d' : score >= 40 ? '#ffcc00' : '#ff2d55';

  _setTxt('adm-stat-emergency', ov.emergency ?? 0);
  _setTxt('adm-stat-critical',  ov.critical  ?? 0);
  _setTxt('adm-stat-warning',   ov.warning   ?? 0);
  _setTxt('adm-stat-online',    ov.online    ?? 0);
  _setTxt('adm-last-updated', '· ' + new Date().toLocaleTimeString());

  // Update emergency badge in sidebar
  const badge = document.getElementById('adm-emergency-badge');
  if (badge) {
    badge.style.display = (ov.emergency > 0) ? 'inline-flex' : 'none';
    badge.textContent = ov.emergency;
  }

  // Gas readings
  if (d.gas) {
    const pfg = d.gas.peakFlammableGas != null && d.gas.peakFlammableGas !== undefined
      ? d.gas.peakFlammableGas
      : ((d.gas.peakCH4 || 0) + (d.gas.peakCO || 0));
    _setTxt('adm-gas-ch4', Number(pfg).toFixed(1) + ' ppm');
    _setTxt('adm-gas-co', `${(d.gas.peakCH4 ?? 0).toFixed(2)}% / ${d.gas.peakCO ?? 0}`);
    _setTxt('adm-gas-o2',  (d.gas.minO2  ?? 21).toFixed(1) + '%');
    const ch4el = document.getElementById('adm-gas-ch4');
    if (ch4el) ch4el.style.color = pfg > 200 ? '#ff2d55' : pfg > 100 ? '#ffcc00' : '#00ff9d';
    const o2el = document.getElementById('adm-gas-o2');
    if (o2el) o2el.style.color = d.gas.minO2 < 17 ? '#ff2d55' : d.gas.minO2 < 19 ? '#ffcc00' : '#00d4ff';
  }

  // Zone bars
  renderZoneBars(d.zones || []);

  // Workers list
  renderAdmWorkers(d.workers || []);

  // Alerts list
  renderAdmAlerts(d.recentAlerts || []);

  // Optimization summary
  if (d.optimSummary) renderAdmOptimSummary(d.optimSummary);

  // Contact config
  if (d.contactConfig) renderContactBadge(d.contactConfig);

  // Comms log
  if (d.recentCalls) renderCommsLog(d.recentCalls, 'adm-comms-log');

  // Evac routes
  loadEvacRoutes();
}

function renderZoneBars(zones) {
  const el = document.getElementById('adm-zone-bars');
  if (!el) return;
  if (!zones.length) { el.innerHTML = '<div style="color:var(--text-sec);font-size:0.65rem">No zone data</div>'; return; }
  const statusColors = { emergency: '#ff2d55', critical: '#ff6b35', warning: '#ffcc00', normal: '#00ff9d' };
  el.innerHTML = zones.map(z => {
    const col = statusColors[z.status] || '#00ff9d';
    const pct = Math.min(100, (z.risk / 10) * 100);
    return `<div class="zone-bar-row">
      <div class="zone-status-dot" style="background:${col}"></div>
      <div class="zone-bar-name">${z.zone}</div>
      <div class="zone-bar-track"><div class="zone-bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div class="zone-bar-risk" style="color:${col}">${z.risk.toFixed(1)}</div>
      <div style="font-size:0.6rem;color:var(--text-sec);min-width:28px">${z.workers}w</div>
    </div>`;
  }).join('');
}

function renderAdmWorkers(workers) {
  const el = document.getElementById('adm-workers-list');
  if (!el) return;
  const top = workers.slice(0, 12);
  const statusColors = { emergency: '#ff2d55', critical: '#ff6b35', warning: '#ffcc00', online: '#00ff9d' };
  el.innerHTML = top.map(w => {
    const col = statusColors[w.status] || '#00ff9d';
    const riskPct = Math.round((w.risk || 0) * 10);
    return `<div class="adm-worker-row">
      <div class="adm-worker-avatar" style="background:${col}22;border:1px solid ${col}44;color:${col}">
        ${w.id.replace('MNR-','')}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.7rem;font-weight:600;color:var(--text-pri);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${w.name}</div>
        <div style="font-size:0.62rem;color:var(--text-sec)">${w.zone} · ${w.tunnel}</div>
      </div>
      <div>
        <div style="font-size:0.6rem;color:var(--text-sec)">🔥 ${((w.flammableGas != null ? w.flammableGas : (w.flammable_gas != null ? w.flammable_gas : ((w.ch4||0)+(w.co||0))))).toFixed(1)} ppm</div>
        <div style="font-size:0.6rem;color:var(--text-sec)">🫁 O₂ ${(w.o2 != null ? Number(w.o2).toFixed(1) : '—')}%</div>
      </div>
      <div class="adm-risk-pill" style="background:${col}22;color:${col};border:1px solid ${col}44">
        ${(w.risk||0).toFixed(1)}
      </div>
      ${w.status === 'emergency' || w.status === 'critical'
        ? `<button onclick="adminCallForWorker('${w.id}','${w.name}','${w.zone}')"
            style="font-size:0.6rem;padding:3px 6px;background:rgba(255,45,85,0.15);border:1px solid var(--danger);color:var(--danger);border-radius:4px;cursor:pointer;white-space:nowrap"
            title="Alert admin about this worker">📞 Alert</button>`
        : ''}
    </div>`;
  }).join('');
}

function renderAdmAlerts(alerts) {
  const el = document.getElementById('adm-alerts-list');
  if (!el) return;
  if (!alerts.length) { el.innerHTML = '<div style="color:var(--text-sec);font-size:0.65rem">No recent alerts</div>'; return; }
  const levelCol = { emergency: '#ff2d55', critical: '#ff6b35', warning: '#ffcc00', info: '#00d4ff' };
  el.innerHTML = alerts.slice(0, 10).map(a => {
    const col = levelCol[a.level] || '#00d4ff';
    const t = a.created_at ? new Date(a.created_at).toLocaleTimeString() : '';
    return `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,212,255,0.05);align-items:flex-start">
      <div style="width:6px;height:6px;border-radius:50%;background:${col};margin-top:5px;flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.68rem;font-weight:600;color:${col}">${a.title || ''}</div>
        <div style="font-size:0.62rem;color:var(--text-sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${a.desc || ''}</div>
      </div>
      <div style="font-size:0.6rem;color:var(--text-sec);flex-shrink:0">${t}</div>
    </div>`;
  }).join('');
}

function renderAdmOptimSummary(optim) {
  const scoreEl = document.getElementById('adm-optim-score');
  const barEl   = document.getElementById('adm-optim-bar');
  const actEl   = document.getElementById('adm-optim-actions');
  if (scoreEl) scoreEl.textContent = (optim.safetyScore ?? '--') + '%';
  if (scoreEl) scoreEl.style.color = (optim.safetyScore >= 70) ? 'var(--success)' : (optim.safetyScore >= 40) ? 'var(--warning)' : 'var(--danger)';
  if (barEl) {
    barEl.style.width = (optim.safetyScore ?? 0) + '%';
    barEl.style.background = (optim.safetyScore >= 70) ? 'var(--success)' : (optim.safetyScore >= 40) ? 'var(--warning)' : 'var(--danger)';
  }
  if (actEl && optim.topActions?.length) {
    actEl.innerHTML = optim.topActions.map(a => `
      <div class="optim-action-item ${a.urgency}">
        <span class="optim-action-urgency ${a.urgency}">${a.urgency}</span>
        <div><div class="optim-action-msg">${a.message}</div><div class="optim-action-detail">${a.detail || ''}</div></div>
      </div>`).join('');
  } else if (actEl) {
    actEl.innerHTML = '<div style="color:var(--success);font-size:0.65rem">✓ All systems nominal</div>';
  }
}

/* ── Evacuation Routes ──────────────────────────────────────── */
async function loadEvacRoutes() {
  const el = document.getElementById('adm-evac-routes');
  if (!el) return;
  try {
    const res = await fetch('/api/optimization/report');
    if (!res.ok) throw new Error('Not ready');
    const data = await res.json();
    const routes = data.evacuationRoutes || [];
    if (!routes.length) {
      el.innerHTML = '<div style="color:var(--success);font-size:0.65rem">✓ No workers currently require evacuation routing</div>';
      return;
    }
    el.innerHTML = routes.map(r => {
      const route = r.route || {};
      const pathHtml = (route.path || []).map(n => `<span class="evac-route-node">${n.label}</span>`).join('<span class="evac-route-arrow">→</span>');
      const riskCol = r.risk >= 7 ? '#ff2d55' : r.risk >= 5 ? '#ff6b35' : '#ffcc00';
      return `<div class="evac-route-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <span style="font-size:0.7rem;font-weight:600;color:var(--text-pri)">${r.workerName}</span>
            <span style="font-size:0.62rem;color:var(--text-sec);margin-left:6px">${r.zone}</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span style="font-size:0.65rem;font-family:monospace;color:${riskCol}">Risk ${r.risk}/10</span>
            <span style="font-size:0.62rem;color:${route.safe ? 'var(--success)' : 'var(--danger)'}">${route.safe ? '✓ Safe route' : '⚠ Blocked'}</span>
          </div>
        </div>
        <div class="evac-route-path" style="margin-top:6px">
          <span class="evac-route-node" style="background:rgba(255,45,85,0.1);color:var(--danger)">📍 ${r.workerName.split(' ')[0]}</span>
          <span class="evac-route-arrow">→</span>
          ${pathHtml || '<span style="color:var(--text-sec);font-size:0.62rem">No route calculated</span>'}
        </div>
        <div style="font-size:0.6rem;color:var(--text-sec);margin-top:4px">
          🕐 Est. ${route.estimatedTime ?? '?'} min · 📍 → ${route.targetLabel || route.target || '?'}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div style="color:var(--text-sec);font-size:0.65rem">Run optimization first to see routes</div>';
  }
}

/* ═══════════════════════════════════════════════════════════
   CONTACT / CALL / SMS
═══════════════════════════════════════════════════════════ */
function renderContactBadge(cfg) {
  _setTxt('adm-contact-name',  cfg.adminName  || 'Mine Safety Manager');
  _setTxt('adm-contact-phone', cfg.adminPhone || 'Not configured');
  const modeEl = document.getElementById('adm-contact-mode');
  if (modeEl) {
    modeEl.textContent = cfg.mode === 'live' ? '🟢 LIVE (Twilio)' : '🟡 SIMULATED MODE';
    modeEl.className = 'contact-info-mode' + (cfg.mode === 'live' ? '' : ' sim');
  }
}

async function adminCall(type) {
  const workers = (window.state?.workers || []);
  const emergency = workers.filter(w => w.status === 'emergency');
  const critical  = workers.filter(w => w.status === 'critical');

  let msg = '';
  if (type === 'emergency') {
    const names = emergency.map(w => w.name).join(', ') || 'Unknown';
    const zones = [...new Set(emergency.map(w => w.zone))].join(', ') || 'Unknown Zone';
    msg = `EMERGENCY: ${emergency.length} workers in critical distress. Workers: ${names}. Zone: ${zones}. Immediate response required.`;
  } else {
    msg = `Mine status update: ${workers.length} miners underground. ${emergency.length} emergency, ${critical.length} critical. Safety score: ${_admDashData?.overview?.safetyScore ?? '--'}%.`;
  }

  showToast('📞 Calling admin...', false);
  try {
    const r = await fetch('/api/contact/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await r.json();
    const mode = data.status === 'simulated' ? '(simulated)' : '';
    showToast(`📞 Call initiated ${mode} — Status: ${data.status}`, false);
    await loadCommsLog();
  } catch (e) {
    showToast('❌ Call failed: ' + e.message, true);
  }
}

async function adminCallForWorker(workerId, workerName, zone) {
  const msg = `EMERGENCY ALERT: Worker ${workerName} (ID: ${workerId}) in ${zone} requires immediate assistance. Please check the SafeMine dashboard.`;
  showToast(`📞 Alerting admin about ${workerName}...`, false);
  try {
    const r = await fetch('/api/contact/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await r.json();
    showToast(`📞 Admin alerted about ${workerName} (${data.status})`, false);
    await loadCommsLog();
  } catch (e) {
    showToast('❌ Failed: ' + e.message, true);
  }
}

async function adminSMS(type) {
  const ov = _admDashData?.overview;
  const msg = type === 'quick'
    ? `SafeMine Quick Status: ${ov?.totalWorkers ?? '?'} miners underground. ${ov?.emergency ?? 0} emergency, ${ov?.critical ?? 0} critical. Safety: ${ov?.safetyScore ?? '--'}%. Check dashboard.`
    : document.getElementById('adm-sms-text')?.value || 'Update from SafeMine.';
  showToast('💬 Sending SMS...', false);
  try {
    const r = await fetch('/api/contact/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await r.json();
    const mode = data.status === 'simulated' ? ' (simulated — add Twilio keys to .env)' : '';
    showToast(`✅ SMS sent${mode}`, false);
    await loadCommsLog();
  } catch (e) {
    showToast('❌ SMS failed: ' + e.message, true);
  }
}

async function adminSMSCustom() {
  const text = document.getElementById('adm-sms-text')?.value?.trim();
  if (!text) { showToast('Enter a message first', true); return; }
  showToast('💬 Sending SMS...', false);
  try {
    const r = await fetch('/api/contact/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const data = await r.json();
    const mode = data.status === 'simulated' ? ' (simulated)' : '';
    showToast(`✅ SMS sent${mode}`, false);
    await loadCommsLog();
  } catch (e) {
    showToast('❌ SMS failed: ' + e.message, true);
  }
}

async function adminTestComms() {
  showToast('🧪 Sending test SMS to admin...', false);
  try {
    const r = await fetch('/api/contact/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sms' }),
    });
    const data = await r.json();
    showToast(`✅ Test sent — ${data.status}. Check console if simulated.`, false);
    await loadCommsLog();
  } catch (e) {
    showToast('❌ Test failed: ' + e.message, true);
  }
}

async function loadCommsLog() {
  try {
    const r = await fetch('/api/contact/log');
    const log = await r.json();
    renderCommsLog(log, 'adm-comms-log');
  } catch (e) { /* ignore */ }
}

function renderCommsLog(log, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!log || !log.length) {
    el.innerHTML = '<div style="color:var(--text-sec);font-size:0.65rem;padding:8px 0">No communications yet</div>';
    return;
  }
  const icons = { call: '📞', sms: '💬' };
  el.innerHTML = log.slice(0, 12).map(item => `
    <div class="comms-log-item">
      <span class="comms-log-icon">${icons[item.type] || '📡'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.68rem;color:var(--text-pri);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${item.type === 'call' ? 'Call' : 'SMS'} → ${item.to}
        </div>
        <div style="font-size:0.6rem;color:var(--text-sec);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${(item.message || '').slice(0, 60)}</div>
      </div>
      <div style="flex-shrink:0;text-align:right">
        <span class="comms-log-status ${item.status}">${item.status}</span>
        <div style="font-size:0.58rem;color:var(--text-sec);margin-top:2px">${item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : ''}</div>
      </div>
    </div>`).join('');
}

/* ═══════════════════════════════════════════════════════════
   OPTIMIZATION ENGINE UI
═══════════════════════════════════════════════════════════ */
async function runOptimizationNow() {
  const runEl = document.getElementById('optim-last-run');
  if (runEl) runEl.textContent = 'Running...';
  showToast('🧠 Running optimization engine...', false);

  try {
    const r = await fetch('/api/optimization/run', { method: 'POST' });
    if (!r.ok) throw new Error('Server error');
    const data = await r.json();
    _optimData = data.result;
    renderOptimizationPage(_optimData);
    if (runEl) runEl.textContent = 'Last run: ' + new Date().toLocaleTimeString();
    showToast('✅ Optimization complete — ' + (_optimData?.actionItems?.length || 0) + ' actions generated', false);
    // Also refresh admin dash summary
    if (_admDashData) {
      if (_optimData) renderAdmOptimSummary({
        safetyScore: _optimData.safetyScore,
        topActions: _optimData.actionItems.slice(0, 3),
      });
    }
  } catch (e) {
    showToast('❌ Optimization failed: ' + e.message, true);
    if (runEl) runEl.textContent = 'Failed';
  }
}

function renderOptimizationPage(data) {
  if (!data) return;

  // KPIs
  _setTxt('optim-kpi-safety',  (data.safetyScore ?? '--') + '%');
  _setTxt('optim-kpi-risk',    data.globalRisk?.toFixed(2) ?? '--');
  _setTxt('optim-kpi-actions', data.actionItems?.length ?? '--');
  _setTxt('optim-kpi-evac',    data.evacuationRoutes?.length ?? '--');

  // Color KPIs
  const sk = document.getElementById('optim-kpi-safety');
  if (sk) sk.style.color = data.safetyScore >= 70 ? 'var(--success)' : data.safetyScore >= 40 ? 'var(--warning)' : 'var(--danger)';

  // Action Items
  const actEl = document.getElementById('optim-actions');
  if (actEl) {
    if (!data.actionItems?.length) {
      actEl.innerHTML = '<div style="color:var(--success);font-size:0.68rem;padding:8px">✅ No immediate actions required — mine operating safely</div>';
    } else {
      actEl.innerHTML = data.actionItems.map(a => `
        <div class="optim-action-item ${a.urgency}" style="margin-bottom:6px">
          <div style="flex-shrink:0">
            <span class="optim-action-urgency ${a.urgency}">${a.urgency}</span>
            <div style="font-size:0.58rem;color:var(--text-sec);margin-top:2px">${a.type}</div>
          </div>
          <div>
            <div class="optim-action-msg">${a.message}</div>
            <div class="optim-action-detail">${a.detail || ''}</div>
          </div>
        </div>`).join('');
    }
  }

  // Ventilation Table
  const ventEl = document.getElementById('optim-vent-body');
  if (ventEl && data.ventilation) {
    ventEl.innerHTML = data.ventilation.map(v => {
      const fg = v.fg != null ? v.fg : ((v.ch4 || 0) + (v.co || 0));
      return `
      <tr>
        <td style="font-family:monospace;font-size:0.68rem">${v.zone}</td>
        <td style="color:${fg > 200 ? 'var(--danger)' : fg > 100 ? 'var(--warning)' : 'var(--success)'};font-family:monospace">${fg.toFixed(1)}</td>
        <td style="color:${v.ch4 >= 1.0 ? 'var(--danger)' : v.ch4 >= 0.5 ? 'var(--warning)' : 'var(--success)'}; font-family:monospace">${v.ch4.toFixed(2)}</td>
        <td style="color:${v.co >= 50 ? 'var(--danger)' : v.co >= 25 ? 'var(--warning)' : 'var(--success)'};font-family:monospace">${v.co}</td>
        <td style="color:${v.o2 < 17 ? 'var(--danger)' : v.o2 < 19 ? 'var(--warning)' : 'var(--success)'};font-family:monospace">${v.o2.toFixed(1)}</td>
        <td style="font-family:monospace;color:var(--accent)">${v.fanSpeedPct}%</td>
        <td><span class="vent-action-badge ${v.action}">${v.action.replace(/_/g,' ')}</span></td>
      </tr>`;
    }).join('');
  }

  // Fatigue
  const fatEl = document.getElementById('optim-fatigue');
  if (fatEl && data.fatigue) {
    fatEl.innerHTML = data.fatigue.map(f => {
      const recColors = { IMMEDIATE_RELIEF: 'var(--danger)', SCHEDULE_BREAK_NOW: 'var(--warning)', MONITOR_CLOSELY: 'var(--accent)', NOMINAL: 'var(--success)' };
      const recCol = recColors[f.recommendation] || 'var(--text-sec)';
      return `<div class="fatigue-row" style="background:${f.color}11;border:1px solid ${f.color}33">
        <div style="min-width:80px">
          <div style="font-size:0.7rem;font-weight:600;color:var(--text-pri)">${f.name.split(' ')[0]}</div>
          <div style="font-size:0.6rem;color:var(--text-sec)">${f.zone}</div>
        </div>
        <div class="fatigue-bar-wrap"><div class="fatigue-bar" style="width:${f.fatigueScore * 10}%;background:${f.color}"></div></div>
        <div style="font-family:monospace;font-size:0.68rem;color:${f.color};min-width:24px">${f.fatigueScore}</div>
        <div style="font-size:0.6rem;color:var(--text-sec);min-width:40px">${f.hoursUnderground}h</div>
        <span class="fatigue-rec" style="background:${recCol}22;color:${recCol}">${f.recommendation.replace(/_/g,' ')}</span>
      </div>`;
    }).join('');
  }

  // Worker Distribution
  const distEl = document.getElementById('optim-distribution');
  if (distEl && data.distribution) {
    const dist = data.distribution;
    const summ = dist.summary || {};
    const zones = summ.zoneBreakdown || {};
    let html = `<div style="margin-bottom:10px">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px">
        <div style="text-align:center;padding:6px;background:rgba(0,212,255,0.06);border-radius:6px">
          <div style="font-family:monospace;font-size:1rem;color:var(--accent)">${summ.totalWorkers??0}</div>
          <div style="font-size:0.58rem;color:var(--text-sec)">TOTAL</div>
        </div>
        <div style="text-align:center;padding:6px;background:rgba(255,204,0,0.06);border-radius:6px">
          <div style="font-family:monospace;font-size:1rem;color:var(--warning)">${summ.zonesAboveCapacity??0}</div>
          <div style="font-size:0.58rem;color:var(--text-sec)">OVER CAPACITY</div>
        </div>
        <div style="text-align:center;padding:6px;background:rgba(255,45,85,0.06);border-radius:6px">
          <div style="font-family:monospace;font-size:1rem;color:var(--danger)">${summ.zonesHighRisk??0}</div>
          <div style="font-size:0.58rem;color:var(--text-sec)">HIGH RISK ZONES</div>
        </div>
      </div>`;
    // Zone breakdown
    html += '<div style="margin-bottom:8px">' + Object.entries(zones).map(([z, count]) =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.68rem;border-bottom:1px solid rgba(0,212,255,0.04)">
        <span style="color:var(--text-pri)">${z}</span>
        <span style="font-family:monospace;color:var(--accent)">${count} miners</span>
      </div>`).join('') + '</div>';
    // Recommendations
    if (dist.recommendations?.length) {
      html += '<div style="font-size:0.62rem;color:var(--text-sec);margin-bottom:6px;text-transform:uppercase">Recommendations:</div>';
      html += dist.recommendations.map(r => {
        const uc = { IMMEDIATE: 'var(--danger)', HIGH: 'var(--warning)', MEDIUM: 'var(--accent)' };
        const col = uc[r.urgency] || 'var(--text-sec)';
        return `<div style="padding:7px 10px;border-radius:6px;border-left:3px solid ${col};background:${col}11;margin-bottom:5px;font-size:0.68rem">
          <div style="font-weight:600;color:${col}">${r.action}: ${r.fromZone}</div>
          <div style="color:var(--text-sec)">${r.issue} → Move ${r.moveCount} to ${r.suggestedZone}</div>
        </div>`;
      }).join('');
    } else {
      html += '<div style="color:var(--success);font-size:0.68rem">✅ Distribution is balanced</div>';
    }
    html += '</div>';
    distEl.innerHTML = html;
  }

  // Evacuation Routes (optim page)
  const evacEl = document.getElementById('optim-evac');
  if (evacEl) {
    const routes = data.evacuationRoutes || [];
    if (!routes.length) {
      evacEl.innerHTML = '<div style="color:var(--success);font-size:0.68rem">✅ No workers currently require evacuation</div>';
    } else {
      evacEl.innerHTML = routes.map(r => {
        const route = r.route || {};
        const pathHtml = (route.path || []).map(n =>
          `<span style="padding:2px 5px;border-radius:3px;background:rgba(0,212,255,0.1);color:var(--accent);font-size:0.62rem">${n.label}</span>`
        ).join('<span style="color:var(--text-sec);margin:0 2px">→</span>');
        const riskCol = r.risk >= 7 ? 'var(--danger)' : r.risk >= 5 ? '#ff6b35' : 'var(--warning)';
        return `<div style="padding:8px 10px;border-radius:7px;background:rgba(255,45,85,0.06);border:1px solid rgba(255,45,85,0.2);margin-bottom:7px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">
            <span style="font-size:0.7rem;font-weight:600;color:var(--text-pri)">${r.workerName}</span>
            <span style="font-size:0.65rem;font-family:monospace;color:${riskCol}">Risk ${r.risk}/10</span>
          </div>
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap">
            <span style="padding:2px 5px;border-radius:3px;background:rgba(255,45,85,0.15);color:var(--danger);font-size:0.62rem">📍 START</span>
            <span style="color:var(--text-sec);margin:0 2px">→</span>
            ${pathHtml || '<span style="color:var(--text-sec);font-size:0.62rem">Direct exit</span>'}
          </div>
          <div style="font-size:0.6rem;color:var(--text-sec);margin-top:5px">
            ⏱ ${route.estimatedTime ?? '?'} min · Target: ${route.targetLabel || 'Surface'}
            ${route.safe ? ' · <span style="color:var(--success)">✓ Clear path</span>' : ' · <span style="color:var(--danger)">⚠ Hazard on route</span>'}
          </div>
        </div>`;
      }).join('');
    }
  }

  // Risk Scores Comparison
  const riskEl = document.getElementById('optim-risk-scores');
  if (riskEl && data.workersOptimizedRisk) {
    riskEl.innerHTML = data.workersOptimizedRisk.map(w => {
      const orig = w.originalRisk || 0;
      const optm = w.optimizedRisk || 0;
      const diff = optm - orig;
      const diffCol = diff > 0.5 ? 'var(--danger)' : diff < -0.5 ? 'var(--success)' : 'var(--text-sec)';
      const diffStr = diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,212,255,0.05);font-size:0.68rem">
        <div style="min-width:80px;color:var(--text-pri)">${w.name.split(' ')[0]}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;gap:4px;align-items:center">
            <span style="color:var(--text-sec);font-size:0.6rem">Orig:</span>
            <span style="font-family:monospace;color:var(--warning)">${orig.toFixed(1)}</span>
            <span style="color:var(--text-sec)">→</span>
            <span style="font-family:monospace;font-weight:600;color:${optm >= 7 ? 'var(--danger)' : optm >= 4 ? 'var(--warning)' : 'var(--success)'}">${optm.toFixed(1)}</span>
            <span style="color:${diffCol};font-size:0.6rem">(${diffStr})</span>
          </div>
          <div style="height:3px;background:rgba(255,255,255,0.05);border-radius:2px;margin-top:2px;overflow:hidden">
            <div style="height:100%;width:${Math.min(100, optm * 10)}%;background:${optm >= 7 ? 'var(--danger)' : optm >= 4 ? 'var(--warning)' : 'var(--success)'};border-radius:2px"></div>
          </div>
        </div>
        <div style="font-size:0.6rem;color:var(--text-sec);min-width:40px">${w.zone}</div>
      </div>`;
    }).join('');
  }
}

/* ─── WebSocket handler for live optimization updates ─────── */
function handleOptimUpdate(payload) {
  // Update admin dash KPIs live
  if (payload.safetyScore !== undefined) {
    const sc = payload.safetyScore;
    _setTxt('adm-kpi-safety', sc + '%');
    _setTxt('adm-optim-score', sc + '%');
    const bar = document.getElementById('adm-optim-bar');
    if (bar) { bar.style.width = sc + '%'; bar.style.background = sc >= 70 ? 'var(--success)' : sc >= 40 ? 'var(--warning)' : 'var(--danger)'; }
    // Update ring
    const arc = document.getElementById('adm-ring-arc');
    if (arc) {
      arc.style.strokeDashoffset = 289 - (sc / 100) * 289;
      arc.style.stroke = sc >= 70 ? '#00ff9d' : sc >= 40 ? '#ffcc00' : '#ff2d55';
    }
    _setTxt('adm-ring-val', sc + '%');
  }
  if (payload.actionItems?.length) {
    renderAdmOptimSummary({ safetyScore: payload.safetyScore, topActions: payload.actionItems.slice(0,3) });
  }
}

function handleContactLogUpdate(payload) {
  if (!payload) return;
  renderCommsLog([payload, ...((window._commsLogCache) || [])].slice(0, 12), 'adm-comms-log');
  window._commsLogCache = [payload, ...((window._commsLogCache) || [])].slice(0, 50);
  showToast(`${payload.type === 'call' ? '📞' : '💬'} Admin ${payload.type} ${payload.status}`, false);
}

/* ─── Utility ──────────────────────────────────────────────── */
function _setTxt(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// Export so app.js can call these
window.loadAdminDash       = loadAdminDash;
window.loadEvacRoutes      = loadEvacRoutes;
window.runOptimizationNow  = runOptimizationNow;
window.adminCall           = adminCall;
window.adminCallForWorker  = adminCallForWorker;
window.adminSMS            = adminSMS;
window.adminSMSCustom      = adminSMSCustom;
window.adminTestComms      = adminTestComms;
window.onAdminDashShow     = onAdminDashShow;
window.onOptimShow         = onOptimShow;
window.handleOptimUpdate   = handleOptimUpdate;
window.handleContactLogUpdate = handleContactLogUpdate;