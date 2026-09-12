
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');
const rateLimit = require('express-rate-limit');
const { v4: uuid } = require('uuid');
const db = require('./db');
const mqtt = require('mqtt');
const { startSimulator } = require('./simulator');
const { startDummyEngine } = require('./dummy-engine');
const { runFullOptimization, calcOptimizedRisk, dijkstraEvacRoute, optimizeVentilation, optimizeWorkerDistribution, predictFatigue } = require('./optimizer');
const { sendSMS, triggerCall, notifyAdmin, getCallLog, getAdminConfig, ADMIN_PHONE } = require('./emergency-contact');
// NEW: Dynamic O2 calculation based on worker count + gas level
// See backend/o2Calculation.js for the full model and comparison to the old logic
const { calculateOxygenLevel, getO2Status } = require('./o2Calculation');

// Default to simplified dummy mode. To use MQTT-based flow, set `DUMMY_MODE=false`.
const DUMMY_MODE = process.env.DUMMY_MODE !== 'false';

// ── Embedded MQTT Broker (Aedes) ─────────────────────────────
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883');
let aedes = null;
let tcpBroker = null;
if (!DUMMY_MODE) {
  aedes = require('aedes')();
  tcpBroker = net.createServer(aedes.handle);

  tcpBroker.listen(MQTT_PORT, () => {
    console.log(`[MQTT Broker] 🟢 Built-in broker running on port ${MQTT_PORT}`);
  });
  aedes.on('client', c => console.log(`[MQTT] Connected:    ${c.id}`));
  aedes.on('clientDisconnect', c => console.log(`[MQTT] Disconnected: ${c.id}`));
  aedes.on('error', e => console.error('[MQTT] Error:', e.message));
}

// ── Express + HTTP + WebSocket ────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = parseInt(process.env.PORT || '3001', 10);

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`
[Server] Port ${PORT} is already in use — another process is listening (often an older SafeMine "npm start").

  Fix (pick one):
  • Close the other terminal running the backend, then start again.
  • Windows — find PID:  netstat -ano | findstr :${PORT}
            then:       taskkill /PID <pid> /F
  • Other port — CMD:    set PORT=3002&& npm start
              PowerShell:  $env:PORT=3002; npm start
    Then open http://localhost:3002 (same port as the backend).
`);
    process.exit(1);
    return;
  }
  console.error('[Server] HTTP error:', err);
  process.exit(1);
});

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 60_000, max: 300 }));

// ── Broadcast to all WS clients ───────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ── Sensor Health Monitoring System ─────────────────────────────
// Detect:
// - No telemetry received (sensor disconnected / wire issue)
// - Wrong/stuck values (e.g., CH4 stuck at 0 or temp impossible)
// - Sudden unrealistic jumps (potential sensor glitch)
//
// Also creates system alerts + maintains a sensor fault list table
// for the maintenance dashboard.
const sensorHealth = {}; // workerId -> in-memory counters (resets on server restart)
const SENSOR_HEALTH = {
  OFFLINE_WARN_SEC: parseInt(process.env.SENSOR_OFFLINE_WARN_SEC || '10', 10),
  OFFLINE_CRIT_SEC: parseInt(process.env.SENSOR_OFFLINE_CRIT_SEC || '30', 10),
  STUCK_READINGS_WARN: parseInt(process.env.SENSOR_STUCK_READINGS_WARN || '5', 10),
  STUCK_READINGS_CRIT: parseInt(process.env.SENSOR_STUCK_READINGS_CRIT || '10', 10),
  ALERT_TTL_MS: parseInt(process.env.SENSOR_ALERT_TTL_MS || process.env.ALERT_TTL_MS || '60000', 10),
  // Domain assumptions (can be overridden via env)
  CH4_MAX: parseFloat(process.env.CH4_MAX || '5'), // % (0..5%)
  CH4_JUMP_WARN: parseFloat(process.env.CH4_JUMP_WARN || '1.0'), // % delta
  CH4_JUMP_CRIT: parseFloat(process.env.CH4_JUMP_CRIT || '1.6'), // % delta
  CO_MAX: parseFloat(process.env.CO_MAX || '500'), // ppm
  O2_MIN: parseFloat(process.env.O2_MIN || '0'), // %
  O2_MAX: parseFloat(process.env.O2_MAX || '25'), // %
  TEMP_MIN: parseFloat(process.env.TEMP_MIN || '-20'), // °C
  TEMP_MAX: parseFloat(process.env.TEMP_MAX || '80'), // °C
  TEMP_JUMP_WARN: parseFloat(process.env.TEMP_JUMP_WARN || '15'), // °C delta
  TEMP_JUMP_CRIT: parseFloat(process.env.TEMP_JUMP_CRIT || '25'), // °C delta
};

function _safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _parseIso(t) {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function getSensorState(workerId) {
  if (!sensorHealth[workerId]) {
    sensorHealth[workerId] = {
      lastPacketAt: null,
      last: { ch4: null, co: null, o2: null, temp: null },
      ch4ZeroStreak: 0,
      ch4MaxStreak: 0,
      ch4JumpStreak: 0,
      tempJumpStreak: 0,
      lastAlertAt: {}, // key -> timestamp
      lastOfflineLevel: null, // 'warning'|'critical'
    };
  }
  return sensorHealth[workerId];
}

function shouldThrottle(st, key) {
  const last = st.lastAlertAt[key];
  if (!last) return false;
  return Date.now() - last < SENSOR_HEALTH.ALERT_TTL_MS;
}

function createSystemSensorAlert({ worker, level, title, desc, sensorKey }) {
  if (!worker) return;
  const st = getSensorState(worker.id);
  const key = `${sensorKey || 'sensor'}::${level}::${title}`;
  if (shouldThrottle(st, key)) return;
  st.lastAlertAt[key] = Date.now();

  const id = uuid();
  db.prepare(`
    INSERT INTO alerts (id,level,title,desc,worker_id,zone,type,priority,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, level, title, desc || '', worker.id, worker.zone || '', 'SENSOR_FAILURE', (level === 'critical' ? 'critical' : 'warning'), new Date().toISOString());

  // Maintenance dashboard data (fault list)
  const sensorFaultId = `SFAULT::${worker.id}::${sensorKey || 'telemetry'}`;
  const nowIso = new Date().toISOString();
  const existing = db.prepare('SELECT repair_status FROM sensor_faults WHERE id=?').get(sensorFaultId);
  const repairStatus = existing?.repair_status === 'resolved' ? 'required' : (existing?.repair_status || 'required');
  const firstDetectedAt = existing?.first_detected_at || nowIso;
  db.prepare(`
    INSERT OR REPLACE INTO sensor_faults
      (id,worker_id,sensor,severity,first_detected_at,last_detected_at,last_active_at,repair_status,notes,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    sensorFaultId,
    worker.id,
    sensorKey || 'telemetry',
    level,
    firstDetectedAt,
    nowIso,
    worker.last_seen || nowIso,
    repairStatus,
    '',
    nowIso
  );

  broadcast('NEW_ALERT', { id, level, title, desc, worker_id: worker.id, zone: worker.zone, type: 'SENSOR_FAILURE', priority: (level === 'critical' ? 'critical' : 'warning') });
}

// ── WebSocket connection → send snapshot ─────────────────────
wss.on('connection', ws => {
  console.log('[WS] Browser client connected');
  const workers = db.prepare('SELECT * FROM workers').all();
  ws.send(JSON.stringify({ type: 'SNAPSHOT', payload: { workers }, ts: Date.now() }));
  ws.on('close', () => console.log('[WS] Client disconnected'));
});

// ── MQTT Client (connects to our embedded broker) ─────────────
let mqttClient = null;

function connectMQTT() {
  setTimeout(() => {
    try {
      mqttClient = mqtt.connect(`mqtt://127.0.0.1:${MQTT_PORT}`, {
        clientId: 'mineguard-server', reconnectPeriod: 3000, connectTimeout: 8000,
      });
      mqttClient.on('connect', () => {
        console.log('[MQTT Client] ✅ Connected to broker');
        mqttClient.subscribe('mineguard/helmet/#');
        mqttClient.subscribe('mineguard/wristband/#');
        mqttClient.subscribe('mineguard/anchor/#');
      });

      mqttClient.on('message', (topic, message) => {
        try {
          const parts = topic.split('/');
          const msgType = parts[1]; // helmet or anchor
          const nodeId = parts[2];
          const payload = JSON.parse(message.toString());

          if (msgType === 'helmet') {
            handleHelmetUpdate(nodeId, payload);
          } else if (msgType === 'wristband') {
            handleWristbandUpdate(nodeId, payload);
          } else if (msgType === 'anchor') {
            handleAnchorUpdate(nodeId, payload);
          }
        } catch (err) {
          console.error('[MQTT] Parse error:', err.message);
        }
      });

      mqttClient.on('error', err => console.warn('[MQTT] Error:', err.message));
      mqttClient.on('offline', () => console.warn('[MQTT] Offline…'));
    } catch (err) {
      console.warn('[MQTT] Cannot connect:', err.message);
    }
  }, 500);
}

if (!DUMMY_MODE) connectMQTT();

// ── Send downlink message to a physical node ──────────────────
function sendNodeDownlink(workerId, payload) {
  if (!mqttClient || !mqttClient.connected) return;
  const topic = `mineguard/helmet/${workerId}/downlink`;
  mqttClient.publish(topic, JSON.stringify({
    ...payload,
    ts: Date.now(),
    system: 'SafeMine'
  }), { qos: 1 });
  console.log(`[MQTT Downlink] ${workerId} → ${payload.type}: ${payload.msg || ''}`);
}

// ── Process incoming helmet telemetry packet ──────────────────
function handleHelmetUpdate(workerId, p) {
  const now = new Date().toISOString();
  const st = getSensorState(workerId);

  // Preserve existing GPS (if incoming packet doesn't provide it) and grab previous readings for clamping.
  const existing = db.prepare('SELECT lat,lng,ch4,co,o2,temp,heart_rate,battery,motion,rssi,status,risk,wristband_battery,wristband_status,helmet_status FROM workers WHERE id=?').get(workerId) || {};

  // If we previously marked telemetry as failed, and we just received a new packet,
  // automatically move telemetry fault into "resolved".
  st.lastOfflineLevel = null;
  {
    const telemetryFaultId = `SFAULT::${workerId}::telemetry`;
    const row = db.prepare('SELECT repair_status FROM sensor_faults WHERE id=?').get(telemetryFaultId);
    if (row && row.repair_status !== 'resolved') {
      db.prepare(`
        UPDATE sensor_faults
        SET repair_status='resolved', last_active_at=?, updated_at=?
        WHERE id=?
      `).run(now, now, telemetryFaultId);
    }
  }

  // Normalize incoming sensor values (raw, before clamping)
  const ch4Raw = _safeNum(p.ch4) ?? 0;          // %
  const coRaw = _safeNum(p.co) ?? 0;            // ppm
  const o2Raw = _safeNum(p.o2) ?? 20.9;        // %
  const tempRaw = _safeNum(p.temp) ?? 22;      // °C

  // ── NEW INTEGRATION POINT (O2 dynamic calculation) ──────
  // Count all currently tracked workers to feed respiration model.
  // getO2Status() also returns a label ('SAFE'|'WARNING'|'DANGER')
  // and a hex color for frontend rendering.
  // NOTE: We only override o2Raw when the incoming value is the
  // default fallback (20.9), meaning the sensor itself didn't
  // supply a real reading. Real sensor values always take priority.
  const _workerCount = db.prepare('SELECT COUNT(*) as cnt FROM workers').get()?.cnt ?? 0;
  const _dynamicO2   = calculateOxygenLevel(_workerCount, ch4Raw);
  const _o2Status    = getO2Status(_dynamicO2);
  // Replace o2Raw with calculated value
  // Original: const o2Raw = _safeNum(p.o2) ?? 20.9;
  const o2Final = _safeNum(p.o2) !== null ? o2Raw : _dynamicO2;

  const heartRate = _safeNum(p.heart_rate) ?? 72;
  const battery = _safeNum(p.battery) ?? 100;
  const panic = _safeNum(p.panic) ?? 0;
  const fall = _safeNum(p.fall) ?? 0;
  const motion = _safeNum(p.motion) ?? 1;

  // Update in-memory streak counters (based on raw inputs)
  if (Math.abs(ch4Raw) < 1e-6) st.ch4ZeroStreak++; else st.ch4ZeroStreak = 0;
  if (ch4Raw >= SENSOR_HEALTH.CH4_MAX - 1e-6) st.ch4MaxStreak++; else st.ch4MaxStreak = 0;

  const lastCh4ForJump = st.last.ch4 ?? _safeNum(existing.ch4) ?? ch4Raw;
  const ch4Delta = Math.abs(ch4Raw - lastCh4ForJump);
  if (ch4Delta >= SENSOR_HEALTH.CH4_JUMP_WARN) st.ch4JumpStreak++; else st.ch4JumpStreak = 0;

  const lastTempForJump = st.last.temp ?? _safeNum(existing.temp) ?? tempRaw;
  const tempDelta = Math.abs(tempRaw - lastTempForJump);
  if (tempDelta >= SENSOR_HEALTH.TEMP_JUMP_WARN) st.tempJumpStreak++; else st.tempJumpStreak = 0;

  // Range clamp invalid readings so spurious safety alerts don't fire.
  // We still keep the raw streak counters for failure detection.
  let ch4 = ch4Raw, co = coRaw, o2 = o2Final, temp = tempRaw;
  const clampFallback = (key, fallback) => {
    const n = _safeNum(existing[key]);
    return n === null ? fallback : n;
  };

  const sensorFaultNow = []; // list of faults to report for this update

  // Range checks
  if (ch4Raw < 0 || ch4Raw > SENSOR_HEALTH.CH4_MAX) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'critical',
      title: `SENSOR_FAILURE: CH4 sensor returned invalid value`,
      desc: `${workerId}: CH4=${ch4Raw}% outside expected range 0..${SENSOR_HEALTH.CH4_MAX}%`
    });
    ch4 = clampFallback('ch4', 0);
  }
  if (coRaw < 0 || coRaw > SENSOR_HEALTH.CO_MAX) {
    sensorFaultNow.push({
      sensorKey: 'co',
      level: 'warning',
      title: `SENSOR_FAILURE: CO sensor returned invalid value`,
      desc: `${workerId}: CO=${coRaw}ppm outside expected range 0..${SENSOR_HEALTH.CO_MAX}ppm`
    });
    co = clampFallback('co', 0);
  }
  if (o2Raw < SENSOR_HEALTH.O2_MIN || o2Raw > SENSOR_HEALTH.O2_MAX) {
    sensorFaultNow.push({
      sensorKey: 'o2',
      level: 'critical',
      title: `SENSOR_FAILURE: O2 sensor returned invalid value`,
      desc: `${workerId}: O2=${o2Raw}% outside expected range ${SENSOR_HEALTH.O2_MIN}..${SENSOR_HEALTH.O2_MAX}%`
    });
    // Fall back to dynamically calculated O2 rather than hardcoded 20.9
    o2 = _dynamicO2;
  }
  if (tempRaw < SENSOR_HEALTH.TEMP_MIN || tempRaw > SENSOR_HEALTH.TEMP_MAX) {
    sensorFaultNow.push({
      sensorKey: 'temp',
      level: 'critical',
      title: `SENSOR_FAILURE: Temp sensor impossible reading`,
      desc: `${workerId}: Temp=${tempRaw}°C outside expected range ${SENSOR_HEALTH.TEMP_MIN}..${SENSOR_HEALTH.TEMP_MAX}°C`
    });
    temp = clampFallback('temp', 22);
  }

  // Stuck / not responding detection (CH4)
  if (st.ch4ZeroStreak >= SENSOR_HEALTH.STUCK_READINGS_CRIT) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'critical',
      title: `SENSOR_FAILURE: CH4 sensor not responding (stuck at 0)`,
      desc: `${workerId}: CH4 remained at 0% for ${st.ch4ZeroStreak} consecutive packets`
    });
  } else if (st.ch4ZeroStreak >= SENSOR_HEALTH.STUCK_READINGS_WARN) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'warning',
      title: `SENSOR_FAILURE: CH4 sensor not responding (stuck at 0)`,
      desc: `${workerId}: CH4 remained at 0% for ${st.ch4ZeroStreak} consecutive packets`
    });
  }

  if (st.ch4MaxStreak >= SENSOR_HEALTH.STUCK_READINGS_CRIT) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'critical',
      title: `SENSOR_FAILURE: CH4 sensor not responding (stuck at max)`,
      desc: `${workerId}: CH4 remained at ~${SENSOR_HEALTH.CH4_MAX}% for ${st.ch4MaxStreak} consecutive packets`
    });
  } else if (st.ch4MaxStreak >= SENSOR_HEALTH.STUCK_READINGS_WARN) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'warning',
      title: `SENSOR_FAILURE: CH4 sensor not responding (stuck at max)`,
      desc: `${workerId}: CH4 remained at ~${SENSOR_HEALTH.CH4_MAX}% for ${st.ch4MaxStreak} consecutive packets`
    });
  }

  // Sudden unrealistic jumps (CH4 + Temp)
  if (st.ch4JumpStreak >= 3) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'critical',
      title: `SENSOR_FAILURE: CH4 sensor unstable (sudden jumps)`,
      desc: `${workerId}: CH4 jumped by ${ch4Delta.toFixed(2)}% in successive packets`
    });
  } else if (st.ch4JumpStreak >= 2) {
    sensorFaultNow.push({
      sensorKey: 'ch4',
      level: 'warning',
      title: `SENSOR_FAILURE: CH4 sensor unstable (sudden jumps)`,
      desc: `${workerId}: CH4 jumped by ${ch4Delta.toFixed(2)}% in successive packets`
    });
  }

  if (st.tempJumpStreak >= 3) {
    sensorFaultNow.push({
      sensorKey: 'temp',
      level: 'critical',
      title: `SENSOR_FAILURE: Temp sensor unstable (sudden jumps)`,
      desc: `${workerId}: Temp changed by ${tempDelta.toFixed(1)}°C in successive packets`
    });
  } else if (st.tempJumpStreak >= 2) {
    sensorFaultNow.push({
      sensorKey: 'temp',
      level: 'warning',
      title: `SENSOR_FAILURE: Temp sensor unstable (sudden jumps)`,
      desc: `${workerId}: Temp changed by ${tempDelta.toFixed(1)}°C in successive packets`
    });
  }

  // Pick the overall severity for UI coloring.
  const hasCritical = sensorFaultNow.some(f => f.level === 'critical');
  const hasWarning = sensorFaultNow.some(f => f.level === 'warning');
  const sensorStatus = hasCritical ? 'sensor_fault_critical' : (hasWarning ? 'sensor_fault_warning' : null);

  // Calculate risk based on clamped/sanitized values to avoid spurious hazards.
  const risk = calcRisk({
    ...p,
    ch4,
    co,
    o2,
    temp,
    heart_rate: heartRate,
    panic,
    fall,
    motion,
  });

  const statusNormal = getStatus({ panic, fall, motion }, risk);
  const status = sensorStatus || statusNormal;

  // gas_raw: raw MQ2 ADC value from ESP32 (0-4095). Null when using dummy engine.
  const gasRaw = (_safeNum(p.gas_raw) !== null) ? _safeNum(p.gas_raw) : null;
  // pressure: BMP180 reading in hPa. Null when sensor not available.
  const pressureHpa = (_safeNum(p.pressure) !== null) ? _safeNum(p.pressure) : null;

  const worker = {
    id: workerId,
    name: p.name ?? workerId,
    zone: p.zone ?? 'Unknown',
    tunnel: p.tunnel ?? 'T1',
    x: p.x ?? 0,
    y: p.y ?? 0,
    depth: p.depth ?? 0,
    ch4,
    co,
    o2,
    o2_label: getO2Status(o2).label,
    o2_color: getO2Status(o2).color,
    temp,
    heart_rate: heartRate,
    battery,
    panic,
    fall,
    motion,
    rssi: p.rssi ?? -80,
    risk,
    status,
    last_seen: now,
    protocol: p.protocol ?? 'LoRaWAN',
    lat: p.lat ?? existing.lat ?? 0,
    lng: p.lng ?? existing.lng ?? 0,
    helmet_status: 'online',
    wristband_status: existing.wristband_status ?? 'offline',
    wristband_battery: existing.wristband_battery ?? 100,
    // New fields from real ESP32 hardware
    gas_raw: gasRaw,
    pressure: pressureHpa,
  };

  // Device health: helmet marked online
  try {
    const prevHelmet = getDevice(workerId, 'helmet');
    const prevStatus = prevHelmet?.status || 'offline';
    upsertDevice(workerId, 'helmet', { battery: worker.battery, last_seen: now, status: 'online' });
    if (prevStatus !== 'online') {
      broadcast('DEVICE_STATUS_UPDATE', {
        deviceId: getDeviceId(workerId, 'helmet'),
        type: 'helmet',
        status: 'online',
        last_seen: now,
      });
    }
  } catch (e) {
    console.warn('[DeviceHealth] helmet upsert failed:', e.message);
  }

  // Upsert worker
  db.prepare(`
    INSERT INTO workers (id,name,zone,tunnel,x,y,depth,ch4,co,o2,temp,heart_rate,battery,wristband_battery,helmet_status,wristband_status,panic,fall,motion,rssi,risk,status,last_seen,protocol,lat,lng)
    VALUES (@id,@name,@zone,@tunnel,@x,@y,@depth,@ch4,@co,@o2,@temp,@heart_rate,@battery,@wristband_battery,@helmet_status,@wristband_status,@panic,@fall,@motion,@rssi,@risk,@status,@last_seen,@protocol,@lat,@lng)
    ON CONFLICT(id) DO UPDATE SET
      zone=excluded.zone,tunnel=excluded.tunnel,x=excluded.x,y=excluded.y,depth=excluded.depth,
      ch4=excluded.ch4,co=excluded.co,o2=excluded.o2,temp=excluded.temp,
      heart_rate=excluded.heart_rate,battery=excluded.battery,wristband_battery=excluded.wristband_battery,
      helmet_status=excluded.helmet_status,wristband_status=excluded.wristband_status,
      panic=excluded.panic,fall=excluded.fall,motion=excluded.motion,
      rssi=excluded.rssi,risk=excluded.risk,status=excluded.status,
      last_seen=excluded.last_seen,protocol=excluded.protocol,
      lat=excluded.lat,lng=excluded.lng
  `).run(worker);

  // Log telemetry (sanitized for safe operations)
  db.prepare(`
    INSERT INTO telemetry (id,worker_id,zone,tunnel,x,y,depth,ch4,co,o2,temp,heart_rate,battery,panic,fall,rssi,risk,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(uuid(), workerId, worker.zone, worker.tunnel, worker.x, worker.y, worker.depth,
    worker.ch4, worker.co, worker.o2, worker.temp, worker.heart_rate,
    worker.battery, worker.panic, worker.fall, worker.rssi, worker.risk, now);

  // Auto-generate safety alerts (uses sanitized values)
  checkSafetyThresholds(worker);

  // Report sensor faults (multi-level reporting) to DB + WS
  if (sensorFaultNow.length) {
    sensorFaultNow.forEach(f => {
      createSystemSensorAlert({
        worker,
        level: f.level,
        title: f.title,
        desc: f.desc,
        sensorKey: f.sensorKey,
      });
    });
  }

  // Push live update to dashboard
  broadcast('WORKER_UPDATE', worker);

  // Update last raw sensor values for jump/stuck detection
  st.last = { ch4: ch4Raw, co: coRaw, o2: o2Raw, temp: tempRaw };
  st.lastPacketAt = Date.now();
}

function handleAnchorUpdate(anchorId, p) {
  db.prepare(`
    INSERT INTO anchors (id,tunnel,x,y,depth,rssi,status,last_seen)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET rssi=excluded.rssi,status=excluded.status,last_seen=excluded.last_seen
  `).run(anchorId, p.tunnel ?? 'T1', p.x ?? 0, p.y ?? 0, p.depth ?? 0,
    p.rssi ?? -70, p.status ?? 'online', new Date().toISOString());
  broadcast('ANCHOR_UPDATE', { id: anchorId, ...p });
}

// ── Smart Wristband support ────────────────────────────────
const DEVICE_OFFLINE_SEC = parseInt(process.env.DEVICE_OFFLINE_SEC || '15', 10);
const deviceHealthMem = {}; // workerId -> { wristOfflineReportedAt, bothOfflineReportedAt }

function getDeviceId(workerId, type) {
  return `${workerId}:${type}`;
}

function parseIsoMs(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function upsertDevice(workerId, type, { battery, last_seen, status }) {
  const id = getDeviceId(workerId, type);
  db.prepare(`
    INSERT INTO devices (id,worker_id,type,battery,last_seen,status)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      battery=excluded.battery,
      last_seen=excluded.last_seen,
      status=excluded.status
  `).run(id, workerId, type, battery ?? 100, last_seen, status ?? 'online');
}

function getDevice(workerId, type) {
  return db.prepare('SELECT * FROM devices WHERE worker_id=? AND type=?').get(workerId, type) || null;
}

function calcWristbandRisk(p) {
  // Minimal wristband-only risk estimation (used when helmet is missing)
  if (p.sos) return 10;
  let score = 0;
  if (p.movement === false) score += 3;
  if ((p.battery ?? 100) < 20) score += 2;
  if (typeof p.signal === 'number' && p.signal < -90) score += 2;
  if (typeof p.signal === 'number' && p.signal > -60) score += 0.5; // very strong signal is not an issue
  return Math.min(10, +score.toFixed(1));
}

function createDeviceStatusAlert({ worker, level, title, desc, type, priority }) {
  const id = uuid();
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,type,priority,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, level, title, desc || '', worker.id, worker.zone || '', type || '', priority || 'warning', new Date().toISOString());
  broadcast('NEW_ALERT', { id, level, title, desc, worker_id: worker.id, zone: worker.zone || '', type, priority });
}

function handleWristbandUpdate(workerId, p) {
  const now = new Date().toISOString();
  const battery = _safeNum(p.battery) ?? 100;
  const movement = !!p.movement;
  const sos = !!p.sos;
  const signal = _safeNum(p.signal);

  const prevWrist = getDevice(workerId, 'wristband');
  const prevWristStatus = prevWrist?.status || 'offline';
  upsertDevice(workerId, 'wristband', { battery, last_seen: now, status: 'online' });

  // Ensure worker exists (must work even when helmet data is missing).
  const existingWorker = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
  const workerRow = existingWorker || { id: workerId, name: workerId, zone: 'Zone A', tunnel: 'T1' };

  const helmetDev = getDevice(workerId, 'helmet');
  const helmetOnline = (helmetDev?.status === 'online');

  // Update worker wristband-related fields
  const motion = movement ? 1 : 0;
  const updateMotionRssiSql = `
    UPDATE workers SET
      wristband_battery=?,
      wristband_status='online',
      motion=?,
      rssi=?,
      last_seen=?,
      protocol=COALESCE(protocol,'LoRaWAN')
    WHERE id=?
  `;
  const updateRes = db.prepare(updateMotionRssiSql).run(battery, motion, signal ?? (workerRow.rssi ?? -80), now, workerId);

  // If there was no worker row, insert minimal worker defaults.
  if (!existingWorker) {
    db.prepare(`
      INSERT INTO workers (id,name,zone,tunnel,wristband_battery,wristband_status,motion,rssi,risk,status,last_seen,helmet_status,battery,protocol,lat,lng)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      workerId,
      workerRow.name,
      workerRow.zone || 'Zone A',
      workerRow.tunnel || 'T1',
      battery,
      'online',
      motion,
      signal ?? -80,
      0,
      helmetOnline ? 'online' : 'degraded_mode',
      now,
      'offline',
      100,
      workerRow.protocol || 'LoRaWAN',
      workerRow.lat || 0,
      workerRow.lng || 0
    );
  }

  const nowWorker = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId);

  // Status/risk mode selection
  if (sos) {
    db.prepare(`UPDATE workers SET status='emergency', risk=10 WHERE id=?`).run(workerId);
    if (prevWristStatus !== 'online') {
      // Device transitioned online; we still want SOS to be prominent.
      broadcast('DEVICE_STATUS_UPDATE', { deviceId: getDeviceId(workerId, 'wristband'), type: 'wristband', status: 'online', last_seen: now });
    }
    createDeviceStatusAlert({
      worker: { ...nowWorker, zone: nowWorker.zone },
      level: 'emergency',
      type: 'MANUAL_SOS',
      priority: 'critical',
      title: `🚨 MANUAL SOS TRIGGERED — ${nowWorker.name}`,
      desc: `Worker ${nowWorker.id} triggered SOS from wristband. Battery=${battery}%, Signal=${signal ?? '—'}, Movement=${movement ? 'moving' : 'stationary'}.`,
    });
    broadcast('WRISTBAND_UPDATE', { workerId, ...p, battery, movement, sos, signal, ts: Date.now() });
    return;
  }

  // When helmet is missing, we enter degraded mode and continue tracking via wristband.
  if (!helmetOnline) {
    if (nowWorker?.status !== 'emergency') {
      const risk = calcWristbandRisk({ battery, movement, sos, signal });
      db.prepare(`UPDATE workers SET status='degraded_mode', risk=? WHERE id=?`).run(risk, workerId);
    }
  }

  // Device status transition event
  const updatedDev = getDevice(workerId, 'wristband');
  if (prevWristStatus !== (updatedDev?.status || 'online')) {
    broadcast('DEVICE_STATUS_UPDATE', { deviceId: getDeviceId(workerId, 'wristband'), type: 'wristband', status: updatedDev.status, last_seen: now });
  }
  broadcast('WRISTBAND_UPDATE', { workerId, battery, movement, sos, signal, ts: Date.now() });
  // Push live update to dashboard
  broadcast('WORKER_UPDATE', db.prepare('SELECT * FROM workers WHERE id=?').get(workerId));
}

function checkDeviceHealth() {
  const nowMs = Date.now();
  const warnMs = DEVICE_OFFLINE_SEC * 1000;
  const workers = db.prepare('SELECT id,name,zone,status,helmet_status,wristband_status,wristband_battery FROM workers').all() || [];

  workers.forEach(w => {
    const helmet = getDevice(w.id, 'helmet');
    const wrist = getDevice(w.id, 'wristband');

    const helmetLastMs = parseIsoMs(helmet?.last_seen);
    const wristLastMs = parseIsoMs(wrist?.last_seen);

    const helmetOnlineDesired = helmetLastMs !== null && (nowMs - helmetLastMs) <= warnMs;
    const wristOnlineDesired = wristLastMs !== null && (nowMs - wristLastMs) <= warnMs;

    const helmetDesiredStatus = helmetOnlineDesired ? 'online' : 'offline';
    const wristDesiredStatus = wristOnlineDesired ? 'online' : 'offline';

    // Initialize memory
    if (!deviceHealthMem[w.id]) deviceHealthMem[w.id] = { wristOfflineReported: false, bothOfflineReported: false };

    const prevHelmetStatus = helmet?.status || w.helmet_status || 'offline';
    const prevWristStatus = wrist?.status || w.wristband_status || 'offline';

    // Update devices + worker statuses when they change
    if (prevHelmetStatus !== helmetDesiredStatus) {
      if (helmet) {
        upsertDevice(w.id, 'helmet', { battery: helmet.battery, last_seen: helmet.last_seen, status: helmetDesiredStatus });
      }
      db.prepare(`UPDATE workers SET helmet_status=? WHERE id=?`).run(helmetDesiredStatus, w.id);
      broadcast('DEVICE_STATUS_UPDATE', { deviceId: getDeviceId(w.id, 'helmet'), type: 'helmet', status: helmetDesiredStatus, last_seen: helmet?.last_seen || null });
    }

    if (prevWristStatus !== wristDesiredStatus) {
      if (wrist) {
        upsertDevice(w.id, 'wristband', { battery: wrist.battery, last_seen: wrist.last_seen, status: wristDesiredStatus });
      }
      db.prepare(`UPDATE workers SET wristband_status=? WHERE id=?`).run(wristDesiredStatus, w.id);
      broadcast('DEVICE_STATUS_UPDATE', { deviceId: getDeviceId(w.id, 'wristband'), type: 'wristband', status: wristDesiredStatus, last_seen: wrist?.last_seen || null });

      // Generate DEVICE_OFFLINE alert once per offline transition
      if (wristDesiredStatus === 'offline' && prevWristStatus === 'online') {
        if (!deviceHealthMem[w.id].wristOfflineReported) {
          deviceHealthMem[w.id].wristOfflineReported = true;
          createDeviceStatusAlert({
            worker: db.prepare('SELECT * FROM workers WHERE id=?').get(w.id),
            level: 'warning',
            type: 'DEVICE_OFFLINE',
            priority: 'warning',
            title: `⚠ DEVICE_OFFLINE — Wristband for ${w.name}`,
            desc: `No wristband telemetry received for > ${DEVICE_OFFLINE_SEC}s.`,
          });
        }
      }
    }

    // Reset wrist offline report when it comes back online
    if (wristDesiredStatus === 'online' && deviceHealthMem[w.id].wristOfflineReported) {
      deviceHealthMem[w.id].wristOfflineReported = false;
    }

    // Overall worker mode logic
    const worker = db.prepare('SELECT * FROM workers WHERE id=?').get(w.id);
    const helmetOnline = helmetOnlineDesired;
    const wristOnline = wristOnlineDesired;

    if (worker?.status !== 'emergency') {
      if (wristOnline && !helmetOnline) {
        db.prepare(`UPDATE workers SET status='degraded_mode' WHERE id=?`).run(w.id);
      } else if (!wristOnline && !helmetOnline) {
        db.prepare(`UPDATE workers SET status='offline', risk=10 WHERE id=?`).run(w.id);
        if (!deviceHealthMem[w.id].bothOfflineReported) {
          deviceHealthMem[w.id].bothOfflineReported = true;
          createDeviceStatusAlert({
            worker: { ...worker, zone: worker.zone },
            level: 'emergency',
            type: 'DEVICE_OFFLINE',
            priority: 'critical',
            title: `🚨 EMERGENCY — No helmet & wristband telemetry (${w.name})`,
            desc: `Both helmet and wristband missing for > ${DEVICE_OFFLINE_SEC}s. Immediate rescue/verification required.`,
          });
        }
      } else if (helmetOnline && wristOnline) {
        deviceHealthMem[w.id].bothOfflineReported = false;
        if (worker.status === 'offline' || worker.status === 'degraded_mode') {
          db.prepare(`UPDATE workers SET status='online', risk=0 WHERE id=?`).run(w.id);
        }
      }
    }
  });
}

// ── Sensor offline detection (no telemetry received) ─────────────
function checkSensorNoData() {
  const nowMs = Date.now();
  const warnMs = SENSOR_HEALTH.OFFLINE_WARN_SEC * 1000;
  const critMs = SENSOR_HEALTH.OFFLINE_CRIT_SEC * 1000;

  const workers = db.prepare('SELECT id,name,zone FROM workers').all();
  workers.forEach(w => {
    const helmetDev = getDevice(w.id, 'helmet');
    const lastMs = parseIsoMs(helmetDev?.last_seen);
    if (lastMs === null) return; // no helmet device data recorded yet

    const ageMs = nowMs - lastMs;
    let desired = null; // 'warning'|'critical'
    if (ageMs >= critMs) desired = 'critical';
    else if (ageMs >= warnMs) desired = 'warning';

    const st = getSensorState(w.id);
    if (!desired) {
      // Telemetry is back; actual status will be refreshed on next handleHelmetUpdate.
      st.lastOfflineLevel = null;
      return;
    }

    if (st.lastOfflineLevel === desired) return; // already reported this stage
    st.lastOfflineLevel = desired;

    createSystemSensorAlert({
      worker: { ...w, last_seen: helmetDev.last_seen },
      level: desired === 'critical' ? 'critical' : 'warning',
      sensorKey: 'telemetry',
      title: desired === 'critical'
        ? `SENSOR_FAILURE: Telemetry not received (disconnected)`
        : `SENSOR_FAILURE: Telemetry not received (warning)`,
      desc: `${w.id}: no telemetry update for ~${Math.floor(ageMs / 1000)}s (last seen: ${helmetDev.last_seen})`,
    });
  });
}

// ── Safety risk score 0-10 ────────────────────────────────────
function calcRisk(p) {
  let score = 0;
  if ((p.ch4 ?? 0) > 1.0) score += 3.0;  // > 1% methane
  if ((p.ch4 ?? 0) > 0.5) score += 1.5;
  if ((p.co ?? 0) > 50) score += 2.5;  // > 50 ppm CO
  if ((p.co ?? 0) > 25) score += 1.0;
  if ((p.o2 ?? 20.9) < 19.5) score += 2.0; // low oxygen
  if ((p.o2 ?? 20.9) < 18) score += 1.5;
  if ((p.temp ?? 22) > 35) score += 1.0;
  if (p.panic) score += 4.0;
  if (p.fall) score += 3.0;
  if ((p.heart_rate ?? 72) > 120 || (p.heart_rate ?? 72) < 45) score += 1.5;
  return Math.min(10, +score.toFixed(1));
}

function getStatus(p, risk) {
  if (p.panic || p.fall) return 'emergency';
  if (risk >= 7) return 'critical';
  if (risk >= 4) return 'warning';
  if ((p.motion ?? 1) === 0) return 'stationary';
  return 'online';
}

// ── Threshold alert checker ───────────────────────────────────
function checkSafetyThresholds(w) {
  const alerts = [];
  const LIMITS = { ch4_warn: 0.5, ch4_crit: 1.0, co_warn: 25, co_crit: 50, o2_low: 19.5, temp_high: 35 };

  if (w.panic) alerts.push({ level: 'emergency', title: `PANIC — ${w.name}`, desc: `Worker ${w.id} pressed distress button in ${w.zone}`, worker_id: w.id });
  if (w.fall) alerts.push({ level: 'emergency', title: `FALL DETECTED — ${w.name}`, desc: `No motion after impact detected on ${w.id}`, worker_id: w.id });
  if (w.ch4 >= LIMITS.ch4_crit) alerts.push({ level: 'critical', title: `Methane Critical (CH₄)`, desc: `${w.id}: ${w.ch4}% — EXPLOSIVE RISK in ${w.zone}`, worker_id: w.id });
  if (w.ch4 >= LIMITS.ch4_warn && w.ch4 < LIMITS.ch4_crit) alerts.push({ level: 'warning', title: `Methane Elevated`, desc: `${w.id}: ${w.ch4}% in ${w.zone}`, worker_id: w.id });
  if (w.co >= LIMITS.co_crit) alerts.push({ level: 'critical', title: `CO Toxic Level`, desc: `${w.id}: ${w.co} ppm — EVACUATION REQUIRED`, worker_id: w.id });
  if (w.co >= LIMITS.co_warn && w.co < LIMITS.co_crit) alerts.push({ level: 'warning', title: `CO Elevated`, desc: `${w.id}: ${w.co} ppm in ${w.zone}`, worker_id: w.id });
  if (w.o2 <= LIMITS.o2_low) alerts.push({ level: 'critical', title: `Low Oxygen (O₂)`, desc: `${w.id}: ${w.o2}% — BREATHING HAZARD`, worker_id: w.id });
  if (w.temp >= LIMITS.temp_high) alerts.push({ level: 'warning', title: `High Temperature`, desc: `${w.id}: ${w.temp}°C in ${w.zone}`, worker_id: w.id });
  if ((w.battery ?? 100) < 15) alerts.push({ level: 'warning', title: `Low Battery`, desc: `${w.id}: ${w.battery}% battery`, worker_id: w.id });
  if (w.heart_rate > 130) alerts.push({ level: 'warning', title: `High Heart Rate`, desc: `${w.id}: ${w.heart_rate} bpm`, worker_id: w.id });

  // ── Early Warning Downlinks (Real Nodes) ──────────────────
  // Send notifications to the physical device BEFORE it reaches critical
  if (w.ch4 >= 0.4 && w.ch4 < LIMITS.ch4_warn) {
    sendNodeDownlink(w.id, { type: 'early-warning', msg: 'CH4 detected (rising)', beep: true, priority: 1 });
  }
  if (w.co >= 20 && w.co < LIMITS.co_warn) {
    sendNodeDownlink(w.id, { type: 'early-warning', msg: 'CO drift detected', beep: true, priority: 1 });
  }
  if (w.o2 < 20.2 && w.o2 > LIMITS.o2_low) {
    sendNodeDownlink(w.id, { type: 'early-warning', msg: 'O2 levels dropping', beep: true, priority: 1 });
  }

  // Critical alerts also trigger aggressive downlinks
  if (w.risk >= 7 || w.panic || w.fall) {
    sendNodeDownlink(w.id, { type: 'emergency', msg: 'EVACUATE IMMEDIATELY', beep: true, priority: 3 });
  }

  // Throttle admin notifications (max 1 call/SMS per worker per 5 min)
  if (!checkSafetyThresholds._lastNotify) checkSafetyThresholds._lastNotify = {};
  const nowNotify = Date.now();
  // Throttle alert creation to avoid repeated DB inserts every 3s while the condition persists.
  // Keyed by worker + alert title (good enough for this demo).
  if (!checkSafetyThresholds._lastAlert) checkSafetyThresholds._lastAlert = {};
  const now = Date.now();
  const ALERT_TTL_MS = parseInt(process.env.ALERT_TTL_MS || '60000'); // default 60s

  alerts.forEach(a => {
    const alertKey = `${w.id}::${a.level}::${a.title}`;
    if (checkSafetyThresholds._lastAlert[alertKey] && now - checkSafetyThresholds._lastAlert[alertKey] < ALERT_TTL_MS) {
      return;
    }
    checkSafetyThresholds._lastAlert[alertKey] = now;

    db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,type,priority,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), a.level, a.title, a.desc, a.worker_id ?? '', w.zone ?? '', a.type || '', a.priority || (a.level === 'emergency' || a.level === 'critical' ? 'critical' : 'warning'), new Date().toISOString());
    broadcast('NEW_ALERT', { ...a, type: a.type || '', priority: a.priority || (a.level === 'emergency' || a.level === 'critical' ? 'critical' : 'warning') });
    // Auto-notify admin for critical/emergency alerts (throttled per worker)
    if ((a.level === 'emergency' || a.level === 'critical') && ADMIN_PHONE) {
      const notifyKey = `${w.id}-${a.level}`;
      if (!checkSafetyThresholds._lastNotify[notifyKey] || nowNotify - checkSafetyThresholds._lastNotify[notifyKey] > 300000) {
        checkSafetyThresholds._lastNotify[notifyKey] = nowNotify;
        const allWorkers = db.prepare('SELECT * FROM workers').all();
        notifyAdmin(a, allWorkers).catch(e => console.error('[AutoNotify]', e.message));
      }
    }
  });

  // Run sensor fusion analysis (correlate multiple sensors)
  // Throttle: only run fusion every 30s per worker to avoid alert flood
  if (!checkSafetyThresholds._lastFusion) checkSafetyThresholds._lastFusion = {};
  const now2 = Date.now();
  if (!checkSafetyThresholds._lastFusion[w.id] || now2 - checkSafetyThresholds._lastFusion[w.id] > 30000) {
    checkSafetyThresholds._lastFusion[w.id] = now2;
    // Call fusion only after server is fully initialized
    if (typeof checkSensorFusion === 'function') checkSensorFusion(w);
  }

  // Auto-trigger escalation for workers with elevated risk that haven't responded
  if (w.risk >= 6 && !w.panic && !escalationTimers[w.id]) {
    if (!checkSafetyThresholds._lastEscalation) checkSafetyThresholds._lastEscalation = {};
    if (!checkSafetyThresholds._lastEscalation[w.id] || now2 - checkSafetyThresholds._lastEscalation[w.id] > 120000) {
      checkSafetyThresholds._lastEscalation[w.id] = now2;
      startEscalation(w);
    }
  }

  // Cancel escalation if worker returns to safe
  if (w.risk < 3 && !w.panic && !w.fall && escalationTimers[w.id]) {
    cancelEscalation(w.id);
  }
}

// ═══════════════════════════════════════════════════════════
//  Real Hardware Worker Tracking
// ═══════════════════════════════════════════════════════════
// When a real ESP32 device POSTs to /api/telemetry, we stamp
// its worker ID here. The dummy engine will skip that worker
// as long as real packets keep arriving (within REAL_HW_TTL_MS).
// If the device goes offline, dummy fills in after the TTL.
const realHardwareWorkers = new Map(); // workerId → lastRealDataMs
const REAL_HW_TTL_MS = 10000; // 10s without real data → back to dummy

function isRealHardwareWorker(workerId) {
  const last = realHardwareWorkers.get(workerId);
  return last !== undefined && (Date.now() - last) < REAL_HW_TTL_MS;
}

// ═══════════════════════════════════════════════════════════
//  REST API Routes
// ═══════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '1.0.0', system: 'SafeMine',
    mqtt: mqttClient?.connected || false,
    ts: new Date().toISOString(),
  });
});

// ══════════════════════════════════════════════════════════════
// HARDWARE DIRECT INTEGRATION — ESP32 / Dhanalakshimi Helmet
// The ESP32 firmware POSTs JSON to: POST /api/telemetry
// This endpoint accepts the raw hardware packet, normalizes it,
// and feeds it directly into the same pipeline as MQTT helmets.
// ══════════════════════════════════════════════════════════════
app.post('/api/telemetry', (req, res) => {
  try {
    const d = req.body;
    if (!d || typeof d !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // ── Resolve worker ID ─────────────────────────────────────
    const workerId = d.device_id || d.id || d.worker_id ||
      ('HW-' + (req.ip || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(-6));

    // ── Mark this worker as a real hardware device ────────────
    // This prevents the dummy engine from overwriting ESP32 data.
    // Stamp is refreshed every time a real packet arrives.
    realHardwareWorkers.set(workerId, Date.now());
    console.log(`[RealHW] ✅ ESP32 packet from ${workerId} — dummy engine will skip this worker`);

    // ── Normalize all possible ESP32 field names ──────────────
    const packet = {
      name: d.name || d.worker_name || workerId,
      zone: d.zone || 'Zone A',
      tunnel: d.tunnel || 'T1',
      x: d.x ?? d.pos_x ?? 0,
      y: d.y ?? d.pos_y ?? 0,
      depth: d.depth ?? d.z ?? d.depth_m ?? 0,
      // Gas sensors — accept both Dhanalakshimi names and generic names
      ch4: d.ch4 ?? d.methane ?? d.gas_ch4 ?? d.mq4 ?? 0,
      co: d.co ?? d.carbon_mono ?? d.gas_co ?? d.mq7 ?? 0,
      o2: d.o2 ?? d.oxygen ?? d.spo2 ?? 20.9,
      temp: d.temp ?? d.temperature ?? d.ambient ?? 22,
      // Raw MQ2 ADC reading from ESP32 (0-4095) — used as Flammable Gas sensor
      gas_raw: d.gas_raw ?? d.raw_gas ?? d.mq2_raw ?? null,
      // BMP180 barometric pressure (hPa)
      pressure: d.pressure ?? d.baro ?? d.bmp_pressure ?? null,
      // Health vitals
      heart_rate: d.heart_rate ?? d.hr ?? d.bpm ?? d.pulse ?? 72,
      // Safety flags
      panic: d.panic ?? d.sos ?? d.button ?? d.distress ?? 0,
      fall: d.fall ?? d.fall_detected ?? d.impact ?? 0,
      motion: d.motion ?? (d.fall ? 0 : 1),
      // GPS / positioning
      lat: d.lat ?? d.latitude ?? 0,
      lng: d.lng ?? d.longitude ?? 0,
      // Hardware info
      battery: d.battery ?? d.bat ?? d.vbat ?? 100,
      rssi: d.rssi ?? d.signal ?? d.lora_rssi ?? -80,
      protocol: d.protocol || 'HTTP-Direct',
    };

    // ── Feed into the same helmet pipeline as MQTT ────────────
    handleHelmetUpdate(workerId, packet);

    console.log(`[HTTP Telemetry] ✅ ${workerId} → GasRaw:${packet.gas_raw} O2:${packet.o2} Pressure:${packet.pressure} HR:${packet.heart_rate}`);

    res.json({
      ok: true,
      worker_id: workerId,
      received: new Date().toISOString(),
      status: 'ingested',
    });
  } catch (err) {
    console.error('[HTTP Telemetry] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Smart Wristband HTTP ingest (minimal telemetry + manual SOS)
// POST /api/wristband
// Body example: { worker_id:"MNR-001", battery:90, movement:true, sos:false, signal:-78 }
app.post('/api/wristband', (req, res) => {
  try {
    const d = req.body;
    if (!d || typeof d !== 'object') return res.status(400).json({ error: 'Invalid JSON body' });
    const workerId = d.worker_id || d.id || d.device_id;
    if (!workerId) return res.status(400).json({ error: 'worker_id required' });
    handleWristbandUpdate(workerId, d);
    res.json({ ok: true, worker_id: workerId, received: new Date().toISOString(), status: 'ingested' });
  } catch (err) {
    console.error('[Wristband] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/telemetry — returns recent telemetry (existing behaviour kept below)

// Workers ──────────────────────────────────────────────────
app.get('/api/workers', (req, res) => {
  res.json(db.prepare('SELECT * FROM workers ORDER BY risk DESC').all());
});

app.get('/api/workers/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json(w);
});

app.post('/api/workers', (req, res) => {
  const { id, name, zone = 'Zone A', tunnel = 'T1', protocol = 'LoRaWAN', shift = 'A' } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  db.prepare(`
    INSERT INTO workers (id,name,zone,tunnel,shift,x,y,depth,ch4,co,o2,temp,heart_rate,battery,wristband_battery,helmet_status,wristband_status,panic,fall,motion,rssi,risk,status,last_seen,protocol)
    VALUES (?,?,?,?,?,0,0,0,0,0,20.9,22,72,100,100,'offline','offline',0,0,1,-80,0,'online',?,?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, name, zone, tunnel, shift, new Date().toISOString(), protocol);
  broadcast('WORKER_ADDED', { id, name, zone, tunnel });
  res.status(201).json({ ok: true, id });
});

app.delete('/api/workers/:id', (req, res) => {
  db.prepare('DELETE FROM workers WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/workers/:id/ping', (req, res) => {
  const { id } = req.params;
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(id);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  sendNodeDownlink(id, { type: 'ping', msg: 'Connection Test', beep: true });
  res.json({ ok: true, message: `Ping sent to ${w.name}` });
});

// Telemetry (time-series) ──────────────────────────────────
app.get('/api/telemetry', (req, res) => {
  const { worker_id, hours = 24, limit = 500 } = req.query;
  let q = `SELECT * FROM telemetry WHERE created_at > datetime('now','-${parseInt(hours)} hours')`;
  const p = [];
  if (worker_id) { q += ' AND worker_id=?'; p.push(worker_id); }
  q += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
  res.json(db.prepare(q).all(...p));
});

// Alerts ───────────────────────────────────────────────────
app.get('/api/alerts', (req, res) => {
  const { level, type, limit = 100 } = req.query;
  let q = 'SELECT * FROM alerts';
  const p = [];
  const where = [];
  if (level) { where.push('level=?'); p.push(level); }
  if (type) { where.push('type=?'); p.push(type); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
  res.json(db.prepare(q).all(...p));
});

app.post('/api/alerts', (req, res) => {
  const { level, title, desc, worker_id = '', zone = '' } = req.body;
  if (!level || !title) return res.status(400).json({ error: 'level and title required' });
  const id = uuid();
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, level, title, desc || '', worker_id, zone, new Date().toISOString());
  broadcast('NEW_ALERT', { id, level, title, desc, worker_id, zone });
  res.status(201).json({ ok: true, id });
});

app.delete('/api/alerts/:id', (req, res) => {
  db.prepare('DELETE FROM alerts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Sensor Faults / Maintenance ────────────────────────────────
// Tracks faulty sensors (including disconnected telemetry) and repair status.
app.get('/api/sensor-faults', (req, res) => {
  const { unresolvedOnly = 'true', limit = '200' } = req.query;
  const lim = parseInt(limit, 10);

  let q = `SELECT sf.*, w.name as worker_name, w.zone as worker_zone
           FROM sensor_faults sf
           LEFT JOIN workers w ON w.id=sf.worker_id`;
  const p = [];
  if (String(unresolvedOnly) !== 'false') {
    q += ' WHERE sf.repair_status != ?';
    p.push('resolved');
  }
  q += ' ORDER BY sf.last_detected_at DESC LIMIT ?';
  p.push(Number.isFinite(lim) ? lim : 200);

  res.json(db.prepare(q).all(...p));
});

app.post('/api/sensor-faults/:id/resolve', (req, res) => {
  const { notes } = req.body || {};
  const id = req.params.id;
  const row = db.prepare('SELECT id FROM sensor_faults WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Fault record not found' });

  const nowIso = new Date().toISOString();
  db.prepare(`
    UPDATE sensor_faults
    SET repair_status='resolved',
        notes=?,
        updated_at=?
    WHERE id=?
  `).run(notes || '', nowIso, id);

  res.json({ ok: true });
});

// Anchors ──────────────────────────────────────────────────
app.get('/api/anchors', (req, res) => {
  res.json(db.prepare('SELECT * FROM anchors ORDER BY tunnel').all());
});

// Incidents ────────────────────────────────────────────────
app.get('/api/incidents', (req, res) => {
  res.json(db.prepare('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 50').all());
});

app.post('/api/incidents', (req, res) => {
  const { type, description, zone, severity, reporter } = req.body;
  if (!type || !zone) return res.status(400).json({ error: 'type and zone required' });
  const id = `INC-${Date.now()}`;
  db.prepare(`INSERT INTO incidents (id,type,description,zone,severity,reporter,status,created_at) VALUES (?,?,?,?,?,?,'open',?)`)
    .run(id, type, description || '', zone, severity || 'medium', reporter || 'Control Room', new Date().toISOString());
  broadcast('NEW_INCIDENT', { id, type, zone, severity });
  res.status(201).json({ ok: true, id });
});

// Evacuations ──────────────────────────────────────────────
app.get('/api/evacuations', (req, res) => {
  res.json(db.prepare('SELECT * FROM evacuations ORDER BY created_at DESC LIMIT 20').all());
});

app.post('/api/evacuations', (req, res) => {
  const { zone, reason, initiated_by } = req.body;
  if (!zone) return res.status(400).json({ error: 'zone required' });
  const id = `EVA-${Date.now()}`;
  db.prepare(`INSERT INTO evacuations (id,zone,reason,initiated_by,status,created_at) VALUES (?,?,?,?,'active',?)`)
    .run(id, zone, reason || 'Manual order', initiated_by || 'Control Room', new Date().toISOString());
  broadcast('EVACUATION_ORDERED', { id, zone, reason });
  // Also push alert
  const alertId = uuid();
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(alertId, 'emergency', `🚨 EVACUATION ORDERED — ${zone}`, reason || 'Manual evacuation order', '', zone, new Date().toISOString());
  res.status(201).json({ ok: true, id });
});

// Stats / KPIs ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const totalWorkers = db.prepare('SELECT COUNT(*) as n FROM workers').get().n;
  const emergencies = db.prepare("SELECT COUNT(*) as n FROM workers WHERE status='emergency'").get().n;
  const criticals = db.prepare("SELECT COUNT(*) as n FROM workers WHERE status='critical'").get().n;
  const avgRisk = db.prepare('SELECT AVG(risk) as v FROM workers').get().v || 0;
  const activeAlerts = db.prepare("SELECT COUNT(*) as n FROM alerts WHERE created_at > datetime('now','-1 hour')").get().n;
  const ch4Sensors = db.prepare('SELECT COUNT(*) as n FROM workers WHERE ch4 > 0.5').get().n;
  const loraOnline = mqttClient?.connected || false;
  const zones = db.prepare("SELECT zone, COUNT(*) as count FROM workers GROUP BY zone").all();
  const settings = getSettingsJSON() || {};

  function parseShiftRange(s) {
    // "06:00-18:00" -> { startMin, endMin }
    if (!s || typeof s !== 'string' || !s.includes('-')) return null;
    const [a, b] = s.split('-').map(x => x.trim());
    const toMin = (t) => {
      const [hh, mm] = String(t).split(':').map(n => parseInt(n, 10));
      if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
      return hh * 60 + mm;
    };
    const startMin = toMin(a);
    const endMin = toMin(b);
    if (startMin === null || endMin === null) return null;
    return { startMin, endMin, raw: s };
  }

  function isInRange(nowMin, r) {
    if (!r) return false;
    if (r.startMin === r.endMin) return true;
    // Handles overnight ranges (e.g. 18:00-06:00)
    if (r.startMin < r.endMin) return nowMin >= r.startMin && nowMin < r.endMin;
    return nowMin >= r.startMin || nowMin < r.endMin;
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const shiftAR = parseShiftRange(settings.shiftA || '06:00-18:00');
  const shiftBR = parseShiftRange(settings.shiftB || '18:00-06:00');
  const currentShift = isInRange(nowMin, shiftAR) ? 'A' : (isInRange(nowMin, shiftBR) ? 'B' : 'A');
  const currentShiftRange = (currentShift === 'A' ? (shiftAR?.raw || '06:00-18:00') : (shiftBR?.raw || '18:00-06:00'));

  const shiftCounts = db.prepare("SELECT shift, COUNT(*) as n FROM workers GROUP BY shift").all() || [];
  const byShift = { A: 0, B: 0 };
  shiftCounts.forEach(r => { if (r.shift === 'A' || r.shift === 'B') byShift[r.shift] = r.n; });

  // Headcount "working" = assigned to shift AND not offline
  const activeShiftCounts = db.prepare("SELECT shift, COUNT(*) as n FROM workers WHERE status!='offline' GROUP BY shift").all() || [];
  const activeByShift = { A: 0, B: 0 };
  activeShiftCounts.forEach(r => { if (r.shift === 'A' || r.shift === 'B') activeByShift[r.shift] = r.n; });

  res.json({
    totalWorkers,
    emergencies,
    criticals,
    avgRisk: +avgRisk.toFixed(1),
    activeAlerts,
    ch4Sensors,
    loraOnline,
    zones,
    headcount: {
      byShift,
      activeByShift,
      currentShift,
      currentShiftRange,
      currentShiftActive: activeByShift[currentShift] || 0,
    },
  });
});

// AI Chat Proxy (Groq primary, Claude fallback) ─────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, systemContext } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });
  try {
    const fetch = require('node-fetch');

    // ── Build live mine context ──────────────────────────────────────
    const workers = db.prepare('SELECT * FROM workers ORDER BY risk DESC').all();
    const activeAlerts = db.prepare("SELECT * FROM alerts WHERE created_at > datetime('now','-1 hour') ORDER BY created_at DESC LIMIT 10").all();
    const geofences = db.prepare('SELECT * FROM geofences WHERE active=1').all() || [];
    const stats = {
      total: workers.length,
      emergency: workers.filter(w => w.status === 'emergency').length,
      critical: workers.filter(w => w.status === 'critical').length,
      maxCH4: workers.reduce((a, w) => Math.max(a, w.ch4 || 0), 0).toFixed(2),
      maxCO: workers.reduce((a, w) => Math.max(a, w.co || 0), 0),
      minO2: workers.reduce((a, w) => Math.min(a, w.o2 || 21), 21).toFixed(1),
    };
    // Detect which workers are inside danger geofences
    const workersInDangerZones = workers.filter(w =>
      geofences.some(gf => gf.type === 'hazard' &&
        Math.sqrt(Math.pow(w.x - gf.cx, 2) + Math.pow(w.y - gf.cy, 2)) <= gf.radius)
    );
    const liveContext = `
LIVE MINE STATUS (${new Date().toISOString()}):
- Miners: ${stats.total} total | ${stats.emergency} emergency | ${stats.critical} critical
- Peak CH4: ${stats.maxCH4}% | Peak CO: ${stats.maxCO}ppm | Min O2: ${stats.minO2}%
- MQTT: ${mqttClient?.connected ? 'LIVE' : 'OFFLINE'} | Active alerts (1h): ${activeAlerts.length}
- Danger geofences: ${geofences.filter(g => g.type === 'hazard').length} active | Workers inside: ${workersInDangerZones.length}
${workersInDangerZones.length ? '- GEOFENCE BREACHES: ' + workersInDangerZones.map(w => w.id + ' (' + w.name + ')').join(', ') : ''}
${activeAlerts.slice(0, 5).map(a => `  [${a.level.toUpperCase()}] ${a.title}: ${a.desc}`).join('\n')}

HIGH-RISK WORKERS:
${workers.filter(w => w.risk >= 4).slice(0, 6).map(w => `  ${w.id} (${w.name}): Risk ${w.risk}/10, CH4 ${(w.ch4 || 0).toFixed(2)}%, CO ${w.co || 0}ppm, O2 ${w.o2 || '?'}%, HR ${w.heart_rate || '?'}bpm, Zone: ${w.zone}, Status: ${w.status}`).join('\n') || '  None at elevated risk'}`;

    const systemPrompt = systemContext ||
      `You are SafeMine AI, an expert underground mine safety assistant embedded in SafeMine. You have deep expertise in:
- Mining safety: MSHA, MINER Act 2006, EU Directive 2004/54/EC, UK Coal Mines Regulation
- Gas hazards: CH4 (explosive >1%), CO (toxic >50ppm), O2 deficiency (<19.5%)
- LoRaWAN/UWB/BLE telemetry, MQTT, IoT sensor systems
- Worker health, fall detection, panic response, geofence breach response, evacuation
- Tunnel safety: ATEX equipment, sensor fusion, multi-stage alert escalation
Give concise, actionable guidance. Prioritize life-safety in emergencies.
${liveContext}`;

    const GROQ_KEY = process.env.GROQ_API_KEY;
    const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const AI_PROVIDER = process.env.AI_PROVIDER || (GROQ_KEY ? 'groq' : 'claude');

    if (AI_PROVIDER === 'groq' && GROQ_KEY) {
      console.log('[AI Chat] Using Groq (' + GROQ_MODEL + ')');
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: GROQ_MODEL, max_tokens: 1024,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.slice(-10).map(m => ({ role: m.role, content: m.content }))
          ]
        })
      });
      const data = await r.json();
      if (!r.ok) {
        console.error('[AI Chat] Groq error:', data.error?.message);
        return res.status(r.status >= 400 && r.status < 500 ? r.status : 502).json({
          error: data.error?.message || 'Groq request failed',
        });
      }
      const text = data.choices?.[0]?.message?.content || 'No response.';
      return res.json({ content: [{ type: 'text', text }], provider: 'groq' });
    }

    // ── Claude (Anthropic) ─ only when no Groq key or AI_PROVIDER=claude ──
    console.log('[AI Chat] Using Claude (claude-sonnet-4-20250514)');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 1000,
        system: systemPrompt,
        messages: messages.slice(-10).map(m => ({ role: m.role, content: m.content }))
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[AI Chat] Claude error:', data);
      return res.status(r.status).json({ error: data.error?.message || 'AI API error. Check your .env keys.' });
    }
    const text = data.content?.map(c => c.text || '').join('') || 'No response.';
    res.json({ content: [{ type: 'text', text }], provider: 'claude' });
  } catch (err) {
    console.error('[AI Chat] Error:', err.message);
    res.status(502).json({ error: 'AI chat error: ' + err.message });
  }
});

// Settings + Site Config (DB-backed, no demo defaults) ─────────
function getSettingsJSON() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('sys');
  if (!row?.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function putSettingsJSON(next) {
  const now = new Date().toISOString();
  const merged = { ...(getSettingsJSON() || {}), ...(next || {}), updatedAt: now };
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')
    .run('sys', JSON.stringify(merged));
  return merged;
}

app.get('/api/settings', (req, res) => {
  const settings = getSettingsJSON();
  res.json(settings || {});
});

app.put('/api/settings', (req, res) => {
  const settings = putSettingsJSON(req.body || {});
  broadcast('SETTINGS_UPDATED', settings);
  res.json({ ok: true, settings });
});

// Geofences ────────────────────────────────────────────────
app.get('/api/geofences', (req, res) => {
  const rows = db.prepare('SELECT * FROM geofences ORDER BY created_at DESC').all();
  res.json(rows || []);
});

app.post('/api/geofences', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = b.id || `gf-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO geofences (id,name,zone,type,radius,cx,cy,active,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(id, b.name, b.zone || '', b.type || 'hazard', b.radius ?? 0, b.cx ?? 0, b.cy ?? 0, b.active ? 1 : 0, b.created_at || now);
  const gf = db.prepare('SELECT * FROM geofences WHERE id=?').get(id);
  broadcast('GEOFENCE_ADDED', gf);
  res.status(201).json({ ok: true, geofence: gf });
});

app.delete('/api/geofences/:id', (req, res) => {
  db.prepare('DELETE FROM geofences WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Predictive Analytics ─────────────────────────────────────
app.get('/api/analytics/risk-forecast', (req, res) => {
  const workers = db.prepare('SELECT * FROM workers ORDER BY risk DESC').all();
  const forecast = workers.map(w => {
    const trend = w.ch4 > 0.8 ? 'rising' : w.ch4 > 0.4 ? 'stable' : 'safe';
    const prediction = w.risk >= 6 ? 'CRITICAL in <15min' : w.risk >= 4 ? 'WARNING likely' : 'STABLE';
    return {
      id: w.id, name: w.name, zone: w.zone, currentRisk: w.risk,
      ch4Trend: trend, prediction, fatigueScore: Math.min(10, (w.heart_rate - 60) / 8 + w.risk * 0.3)
    };
  });
  res.json({ forecast, generatedAt: new Date().toISOString() });
});

app.get('/api/analytics/gas-trend', async (req, res) => {
  const hours = parseInt(req.query.hours || 24);
  const rows = db.prepare(`SELECT zone, AVG(ch4) as avgCh4, MAX(ch4) as maxCh4, AVG(co) as avgCo, MIN(o2) as minO2, created_at
    FROM telemetry WHERE created_at > datetime('now','-${hours} hours')
    GROUP BY zone ORDER BY created_at DESC LIMIT 200`).all();
  res.json(rows);
});

// Refuge Chambers (DB-backed) ──────────────────────────────
app.get('/api/refuges', (req, res) => {
  const rows = db.prepare('SELECT * FROM refuges ORDER BY created_at DESC').all();
  res.json(rows || []);
});

app.post('/api/refuges', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const id = b.id || `ref-${Date.now()}`;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO refuges (id,name,zone,tunnel,x,y,capacity,supplies,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, b.name, b.zone || '', b.tunnel || '', b.x ?? 0, b.y ?? 0, b.capacity ?? 0, b.supplies ?? 0, b.status || 'ready', b.created_at || now);
  res.status(201).json({ ok: true, refuge: db.prepare('SELECT * FROM refuges WHERE id=?').get(id) });
});

app.get('/api/refuges/nearest/:workerId', (req, res) => {
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const refuges = db.prepare('SELECT * FROM refuges').all() || [];
  if (!refuges.length) return res.status(404).json({ error: 'No refuges configured' });
  const nearest = refuges.map(r => ({
    ...r,
    distance: Math.sqrt(Math.pow((r.x || 0) - w.x, 2) + Math.pow((r.y || 0) - w.y, 2)).toFixed(0)
  })).sort((a, b) => a.distance - b.distance)[0];
  res.json(nearest);
});

// Digital Twin Simulation (DISABLED in live-only mode) ──────
app.post('/api/simulation/run', (req, res) => {
  res.status(501).json({ error: 'Simulation is disabled in live-only mode.' });
});

// Multi-Stage Alert Escalation (Warning→Critical→Panic) ───────────────
const escalationTimers = {}; // workerId → { stage, timer, startedAt }

function startEscalation(worker) {
  const id = worker.id;
  if (escalationTimers[id]) return; // already escalating
  console.log(`[Escalation] Starting Warning stage for ${id} (${worker.name})`);
  escalationTimers[id] = { stage: 'warning', startedAt: Date.now() };
  broadcast('ESCALATION_STAGE', { workerId: id, workerName: worker.name, stage: 'warning', countdown: 10, zone: worker.zone });

  // Stage 1: Warning (0s) → Critical (10s)
  escalationTimers[id].timer1 = setTimeout(() => {
    if (!escalationTimers[id]) return;
    escalationTimers[id].stage = 'critical';
    console.log(`[Escalation] → CRITICAL stage for ${id}`);
    const alertId = uuid();
    db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`).
      run(alertId, 'critical', `⚠️ ESCALATED CRITICAL — ${worker.name}`, `Auto-escalated from Warning. ${worker.name} in ${worker.zone}: CH₄ ${(worker.ch4 || 0).toFixed(2)}%, CO ${worker.co || 0}ppm`, id, worker.zone || '', new Date().toISOString());
    broadcast('NEW_ALERT', { id: alertId, level: 'critical', title: `⚠️ ESCALATED CRITICAL — ${worker.name}`, desc: `CH₄ ${(worker.ch4 || 0).toFixed(2)}% CO ${worker.co || 0}ppm in ${worker.zone}` });
    broadcast('ESCALATION_STAGE', { workerId: id, workerName: worker.name, stage: 'critical', countdown: 20, zone: worker.zone });

    // Stage 2: Critical (10s) → Panic (20s)
    escalationTimers[id].timer2 = setTimeout(() => {
      if (!escalationTimers[id]) return;
      escalationTimers[id].stage = 'panic';
      console.log(`[Escalation] → PANIC stage for ${id}`);
      db.prepare('UPDATE workers SET panic=1, status=\'emergency\', risk=10 WHERE id=?').run(id);
      const alertId2 = uuid();
      db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`).
        run(alertId2, 'emergency', `🚨 PANIC ESCALATION — ${worker.name}`, `No response after 30s. IMMEDIATE RESCUE REQUIRED. ${worker.name} in ${worker.zone}`, id, worker.zone || '', new Date().toISOString());
      broadcast('NEW_ALERT', { id: alertId2, level: 'emergency', title: `🚨 PANIC — ${worker.name}`, desc: `No response after escalation. Rescue needed in ${worker.zone}` });
      broadcast('ESCALATION_STAGE', { workerId: id, workerName: worker.name, stage: 'panic', countdown: 0, zone: worker.zone });
      sendNodeDownlink(id, { type: 'emergency', msg: 'EVACUATE IMMEDIATELY', beep: true, priority: 3 });
      delete escalationTimers[id];
    }, 20000);
  }, 10000);
}

function cancelEscalation(workerId) {
  if (!escalationTimers[workerId]) return;
  clearTimeout(escalationTimers[workerId].timer1);
  clearTimeout(escalationTimers[workerId].timer2);
  delete escalationTimers[workerId];
  broadcast('ESCALATION_CANCELLED', { workerId });
  console.log(`[Escalation] Cancelled for ${workerId}`);
}

// Trigger escalation on demand or auto when threshold crossed
app.post('/api/workers/:id/escalate', (req, res) => {
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.id);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  startEscalation(w);
  res.json({ ok: true, message: `Escalation started for ${w.name}` });
});

app.post('/api/workers/:id/escalate/cancel', (req, res) => {
  cancelEscalation(req.params.id);
  res.json({ ok: true });
});

// Sensor Fusion — correlate gas + thermal + motion ────────────────────
function checkSensorFusion(worker) {
  const fusions = [];
  // Pattern 1: CH4 rising + CO elevated + person present → Gas leak with worker
  if ((worker.ch4 || 0) >= 0.5 && (worker.co || 0) >= 25) {
    fusions.push({ level: 'critical', title: `💨 SENSOR FUSION: Gas Accumulation — ${worker.zone}`, desc: `${worker.id}: CH₄ ${(worker.ch4 || 0).toFixed(2)}% + CO ${worker.co || 0}ppm simultaneously detected. Compound hazard — possible ventilation failure.` });
  }
  // Pattern 2: High temp + CO → Fire signature
  if ((worker.temp || 22) >= 38 && (worker.co || 0) >= 40) {
    fusions.push({ level: 'emergency', title: `🔥 SENSOR FUSION: Fire Signature — ${worker.zone}`, desc: `${worker.id}: Temp ${worker.temp}°C + CO ${worker.co || 0}ppm. Possible fire or hot equipment ignition in ${worker.zone}. EVACUATE.` });
  }
  // Pattern 3: O2 low + no motion → Worker incapacitated
  if ((worker.o2 || 21) < 19.5 && worker.motion === 0) {
    fusions.push({ level: 'emergency', title: `🪴 SENSOR FUSION: Worker Incapacitated — ${worker.name}`, desc: `${worker.id}: O₂ ${worker.o2 || '?'}% + STATIONARY. Worker may be unconscious from oxygen deficiency in ${worker.zone}.` });
    startEscalation(worker);
  }
  // Pattern 4: Panic + high CH4 → Explosive + distress
  if (worker.panic && (worker.ch4 || 0) >= 0.8) {
    fusions.push({ level: 'emergency', title: `☠️ SENSOR FUSION: PANIC in Gas Zone — ${worker.name}`, desc: `${worker.id}: Panic button pressed with CH₄ ${(worker.ch4 || 0).toFixed(2)}% — EXPLOSIVE RISK + DISTRESS in ${worker.zone}.` });
  }
  fusions.forEach(f => {
    const fid = uuid();
    db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`).
      run(fid, f.level, f.title, f.desc, worker.id, worker.zone || '', new Date().toISOString());
    broadcast('NEW_ALERT', { id: fid, level: f.level, title: f.title, desc: f.desc, worker_id: worker.id, zone: worker.zone, fusion: true });
    console.log(`[SensorFusion] ${f.level.toUpperCase()}: ${f.title}`);
  });
}

// Hook sensor fusion into helmet update pipeline
const _origHandleHelmet = handleHelmetUpdate;
// Patch: run fusion check after threshold check
// (fusion is called within checkSafetyThresholds extended below)
app.get('/api/escalations', (req, res) => {
  const active = Object.entries(escalationTimers).map(([id, e]) => ({ workerId: id, stage: e.stage, startedAt: e.startedAt }));
  res.json(active);
});

// Muster Report ────────────────────────────────────────────
app.get('/api/muster', (req, res) => {
  const workers = db.prepare('SELECT * FROM workers').all();
  const accounted = workers.filter(w => w.status !== 'offline').length;
  const missing = workers.filter(w => w.status === 'offline');
  const emergency = workers.filter(w => w.status === 'emergency');
  const byZone = {};
  workers.forEach(w => { if (!byZone[w.zone]) byZone[w.zone] = []; byZone[w.zone].push({ id: w.id, name: w.name, status: w.status }); });
  res.json({ total: workers.length, accounted, missing, emergency, byZone, generatedAt: new Date().toISOString() });
});

// SOS — Worker distress signal ─────────────────────────────
app.post('/api/sos/:workerId', (req, res) => {
  const { workerId } = req.params;
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const now = new Date().toISOString();
  // Mark worker as emergency + panic
  db.prepare('UPDATE workers SET panic=1, status=\'emergency\', risk=10 WHERE id=?').run(workerId);
  // Create emergency alert
  const alertId = uuid();
  const desc = `SOS distress signal received from ${w.name} in ${w.zone} at depth ${w.depth || 0}m`;
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(alertId, 'emergency', `🆘 SOS — ${w.name}`, desc, workerId, w.zone || '', now);
  broadcast('NEW_ALERT', { id: alertId, level: 'emergency', title: `🆘 SOS — ${w.name}`, desc, worker_id: workerId, zone: w.zone });
  broadcast('WORKER_UPDATE', { ...w, panic: 1, status: 'emergency', risk: 10 });
  console.log(`[SOS] 🆘 Emergency SOS from ${workerId} (${w.name}) in ${w.zone}`);
  res.json({ ok: true, alertId, message: `SOS signal broadcast for ${w.name}` });
});

// Broadcast Alert to Zone ──────────────────────────────────
app.post('/api/broadcast', (req, res) => {
  const { zone, message, level = 'warning', title } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const now = new Date().toISOString();
  const alertTitle = title || (zone === 'ALL' ? '📢 MINE-WIDE BROADCAST' : `📢 BROADCAST — ${zone}`);
  const alertId = uuid();
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(alertId, level, alertTitle, message, '', zone || 'ALL', now);
  broadcast('NEW_ALERT', { id: alertId, level, title: alertTitle, desc: message, worker_id: '', zone: zone || 'ALL' });
  broadcast('BROADCAST_MESSAGE', { zone: zone || 'ALL', message, level, title: alertTitle, ts: now });
  console.log(`[Broadcast] ${level.toUpperCase()} → ${zone || 'ALL'}: ${message}`);
  res.status(201).json({ ok: true, alertId });
});

// Simulate Emergency Event (for demo) ─────────────────────
app.post('/api/simulate/event', (req, res) => {
  const { type = 'gas_spike', workerId } = req.body;
  const workers = db.prepare('SELECT * FROM workers').all();
  if (!workers.length) return res.status(400).json({ error: 'No workers in database — start the LoRa simulator first' });
  const target = workerId
    ? workers.find(w => w.id === workerId)
    : workers[Math.floor(Math.random() * workers.length)];
  if (!target) return res.status(404).json({ error: 'Worker not found' });

  const now = new Date().toISOString();
  let updates = {};
  let alertTitle = '';
  let alertDesc = '';
  let alertLevel = 'critical';

  switch (type) {
    case 'panic':
      updates = { panic: 1, status: 'emergency', risk: 10 };
      alertTitle = `🆘 PANIC BUTTON — ${target.name}`;
      alertDesc = `${target.id} pressed emergency distress in ${target.zone}`;
      alertLevel = 'emergency';
      break;
    case 'fall':
      updates = { fall: 1, motion: 0, status: 'emergency', risk: 9 };
      alertTitle = `🫸 FALL DETECTED — ${target.name}`;
      alertDesc = `Accelerometer detected impact & no motion on ${target.id} in ${target.zone}`;
      alertLevel = 'emergency';
      break;
    case 'gas_spike':
      updates = { ch4: 1.35, co: 62, risk: 8.5, status: 'critical' };
      alertTitle = `💨 METHANE CRITICAL — ${target.zone}`;
      alertDesc = `${target.id}: CH₄ 1.35% (explosive!) CO 62ppm in ${target.zone}`;
      alertLevel = 'critical';
      break;
    case 'low_o2':
      updates = { o2: 17.8, risk: 7, status: 'critical' };
      alertTitle = `🫁 LOW OXYGEN — ${target.zone}`;
      alertDesc = `${target.id}: O₂ dropped to 17.8% — BREATHING HAZARD in ${target.zone}`;
      alertLevel = 'critical';
      break;
    case 'fire':
      updates = { temp: 48, co: 85, ch4: 0.8, risk: 10, status: 'emergency' };
      alertTitle = `🔥 FIRE DETECTED — ${target.zone}`;
      alertDesc = `Thermal spike ${target.zone}: ${target.id} temp 48°C, CO 85ppm — EVACUATE`;
      alertLevel = 'emergency';
      break;
    default:
      return res.status(400).json({ error: 'Unknown event type. Use: panic, fall, gas_spike, low_o2, fire' });
  }

  // Update worker record
  const setClauses = Object.keys(updates).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE workers SET ${setClauses} WHERE id=?`).run(...Object.values(updates), target.id);
  broadcast('WORKER_UPDATE', { ...target, ...updates, id: target.id });

  // Create alert
  const alertId = uuid();
  db.prepare(`INSERT INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(alertId, alertLevel, alertTitle, alertDesc, target.id, target.zone || '', now);
  broadcast('NEW_ALERT', { id: alertId, level: alertLevel, title: alertTitle, desc: alertDesc, worker_id: target.id, zone: target.zone });

  res.json({ ok: true, type, workerId: target.id, workerName: target.name, alertId });
});

// Drone monitoring (DB-backed, no simulated fleet) ──────────
app.get('/api/drones', (req, res) => {
  const rows = db.prepare('SELECT * FROM drones').all();
  res.json(rows || []);
});

app.post('/api/drones', (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.name) return res.status(400).json({ error: 'id and name required' });
  db.prepare(`
    INSERT OR REPLACE INTO drones (id,name,zone,status,battery,feed,lastInspection)
    VALUES (?,?,?,?,?,?,?)
  `).run(b.id, b.name, b.zone || '', b.status || 'standby', b.battery ?? 100, b.feed || 'unknown', b.lastInspection || new Date().toISOString());
  res.status(201).json({ ok: true, drone: db.prepare('SELECT * FROM drones WHERE id=?').get(b.id) });
});

app.post('/api/drones/:id/deploy', (req, res) => {
  const existing = db.prepare('SELECT * FROM drones WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Drone not found' });
  const zone = (req.body && req.body.zone) ? String(req.body.zone) : (existing.zone || '');
  db.prepare('UPDATE drones SET status=?, zone=?, lastInspection=? WHERE id=?')
    .run('active', zone, new Date().toISOString(), req.params.id);
  const d = db.prepare('SELECT * FROM drones WHERE id=?').get(req.params.id);
  broadcast('DRONE_DEPLOYED', d);
  res.json({ ok: true, drone: d });
});

// ══════════════════════════════════════════════════════════════
// OPTIMIZATION ENGINE API
// ══════════════════════════════════════════════════════════════
let lastOptimResult = null;
let optimRunCount = 0;

function runAndCacheOptimization() {
  try {
    const workers = db.prepare('SELECT * FROM workers').all();
    const geofences = db.prepare('SELECT * FROM geofences WHERE active=1').all() || [];
    if (!workers.length) return;
    // Update risk scores in DB using optimized algorithm
    workers.forEach(w => {
      const newRisk = calcOptimizedRisk(w);
      if (Math.abs(newRisk - (w.risk || 0)) > 0.1) {
        db.prepare('UPDATE workers SET risk=? WHERE id=?').run(newRisk, w.id);
      }
    });
    const freshWorkers = db.prepare('SELECT * FROM workers').all();
    lastOptimResult = runFullOptimization(freshWorkers, geofences);
    optimRunCount++;
    broadcast('OPTIMIZATION_UPDATE', {
      safetyScore: lastOptimResult.safetyScore,
      globalRisk: lastOptimResult.globalRisk,
      actionItems: lastOptimResult.actionItems.slice(0, 5),
      ventilation: lastOptimResult.ventilation,
      runCount: optimRunCount,
    });
    // Auto-notify admin if safety score drops below 50
    if (lastOptimResult.safetyScore < 50 && optimRunCount % 4 === 0) {
      const emergencyWorkers = freshWorkers.filter(w => w.status === 'emergency');
      if (emergencyWorkers.length > 0 && ADMIN_PHONE) {
        notifyAdmin({
          level: 'critical',
          title: `Mine Safety Score CRITICAL: ${lastOptimResult.safetyScore}%`,
          desc: `${emergencyWorkers.length} workers in emergency. Global risk: ${lastOptimResult.globalRisk}/10`,
        }, freshWorkers).catch(() => { });
      }
    }
  } catch (e) { console.error('[Optimizer] Error:', e.message); }
}

// Run optimization every 30s (configurable)
const OPTIM_INTERVAL = parseInt(process.env.OPTIMIZATION_INTERVAL || '30') * 1000;
setTimeout(() => {
  runAndCacheOptimization();
  setInterval(runAndCacheOptimization, OPTIM_INTERVAL);
}, 5000);

// Run sensor "no telemetry received" checks periodically.
const SENSOR_HEALTH_INTERVAL_MS = parseInt(process.env.SENSOR_HEALTH_INTERVAL_MS || '3000', 10);
setTimeout(() => {
  checkSensorNoData();
  setInterval(checkSensorNoData, SENSOR_HEALTH_INTERVAL_MS);
}, 5000);

// Run smart device health checks periodically (helmet + wristband).
const DEVICE_HEALTH_INTERVAL_MS = parseInt(process.env.DEVICE_HEALTH_INTERVAL_MS || '3000', 10);
setTimeout(() => {
  checkDeviceHealth();
  setInterval(checkDeviceHealth, DEVICE_HEALTH_INTERVAL_MS);
}, 5000);

app.get('/api/optimization/report', (req, res) => {
  if (!lastOptimResult) {
    // Run on demand if not yet cached
    const workers = db.prepare('SELECT * FROM workers').all();
    const geofences = db.prepare('SELECT * FROM geofences WHERE active=1').all() || [];
    if (!workers.length) return res.json({ error: 'No workers yet — start simulator' });
    lastOptimResult = runFullOptimization(workers, geofences);
  }
  res.json(lastOptimResult);
});

app.get('/api/optimization/ventilation', (req, res) => {
  const workers = db.prepare('SELECT * FROM workers').all();
  res.json(optimizeVentilation(workers));
});

app.get('/api/optimization/distribution', (req, res) => {
  const workers = db.prepare('SELECT * FROM workers').all();
  res.json(optimizeWorkerDistribution(workers));
});

app.get('/api/optimization/fatigue', (req, res) => {
  const workers = db.prepare('SELECT * FROM workers').all();
  res.json(predictFatigue(workers));
});

app.get('/api/optimization/evacuation/:workerId', (req, res) => {
  const w = db.prepare('SELECT * FROM workers WHERE id=?').get(req.params.workerId);
  if (!w) return res.status(404).json({ error: 'Worker not found' });
  const workers = db.prepare('SELECT * FROM workers').all();
  const geofences = db.prepare('SELECT * FROM geofences WHERE active=1').all() || [];
  res.json(dijkstraEvacRoute(w.x, w.y, workers, geofences));
});

app.post('/api/optimization/run', (req, res) => {
  runAndCacheOptimization();
  res.json({ ok: true, result: lastOptimResult });
});

// ══════════════════════════════════════════════════════════════
// EMERGENCY CONTACT / CALL & SMS API
// ══════════════════════════════════════════════════════════════
app.get('/api/contact/config', (req, res) => {
  res.json(getAdminConfig());
});

app.get('/api/contact/log', (req, res) => {
  res.json(getCallLog());
});

app.post('/api/contact/sms', async (req, res) => {
  const { message, phone } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const target = phone || ADMIN_PHONE;
  if (!target) return res.status(400).json({ error: 'No admin phone configured in .env (ADMIN_PHONE)' });
  const result = await sendSMS(target, message);
  broadcast('CONTACT_LOG_UPDATE', { type: 'sms', ...result });
  res.json(result);
});

app.post('/api/contact/call', async (req, res) => {
  const { message, phone } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const target = phone || ADMIN_PHONE;
  if (!target) return res.status(400).json({ error: 'No admin phone configured in .env (ADMIN_PHONE)' });
  const result = await triggerCall(target, message);
  broadcast('CONTACT_LOG_UPDATE', { type: 'call', ...result });
  res.json(result);
});

app.post('/api/contact/test', async (req, res) => {
  const { type = 'sms' } = req.body;
  const msg = 'TEST from SafeMine — your emergency alerts are working correctly.';
  const result = type === 'call'
    ? await triggerCall(ADMIN_PHONE, msg)
    : await sendSMS(ADMIN_PHONE, msg);
  broadcast('CONTACT_LOG_UPDATE', result);
  res.json(result);
});

// ══════════════════════════════════════════════════════════════
// ADMIN DASHBOARD API
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/dashboard', (req, res) => {
  try {
    const workers = db.prepare('SELECT * FROM workers').all();
    const alerts = db.prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20").all();
    const incidents = db.prepare("SELECT * FROM incidents ORDER BY created_at DESC LIMIT 10").all();
    const evacuations = db.prepare("SELECT * FROM evacuations ORDER BY created_at DESC LIMIT 5").all();
    const geofences = db.prepare('SELECT * FROM geofences WHERE active=1').all() || [];
    const drones = db.prepare('SELECT * FROM drones').all() || [];

    const emergency = workers.filter(w => w.status === 'emergency');
    const critical = workers.filter(w => w.status === 'critical');
    const warning = workers.filter(w => w.status === 'warning');
    const online = workers.filter(w => w.status === 'online');

    // Zone breakdown
    const zoneMap = {};
    workers.forEach(w => {
      if (!zoneMap[w.zone]) zoneMap[w.zone] = { zone: w.zone, workers: 0, risk: 0, status: 'normal' };
      zoneMap[w.zone].workers++;
      zoneMap[w.zone].risk = Math.max(zoneMap[w.zone].risk, w.risk || 0);
      if (w.status === 'emergency') zoneMap[w.zone].status = 'emergency';
      else if (w.status === 'critical' && zoneMap[w.zone].status !== 'emergency') zoneMap[w.zone].status = 'critical';
      else if (w.status === 'warning' && zoneMap[w.zone].status === 'normal') zoneMap[w.zone].status = 'warning';
    });

    // Gas peaks
    const peakCH4 = workers.reduce((a, w) => Math.max(a, w.ch4 || 0), 0);
    const peakCO = workers.reduce((a, w) => Math.max(a, w.co || 0), 0);
    const minO2 = workers.reduce((a, w) => Math.min(a, w.o2 || 21), 21);
    const avgRisk = workers.length ? (workers.reduce((a, w) => a + (w.risk || 0), 0) / workers.length) : 0;
    const safetyScore = Math.max(0, Math.round((1 - avgRisk / 10) * 100));

    const contactConfig = getAdminConfig();
    const recentCalls = getCallLog().slice(0, 10);
    const optimSummary = lastOptimResult ? {
      safetyScore: lastOptimResult.safetyScore,
      globalRisk: lastOptimResult.globalRisk,
      topActions: lastOptimResult.actionItems.slice(0, 3),
      ventilationHotspots: lastOptimResult.ventilation.filter(v => v.action !== 'NORMAL').length,
    } : null;

    res.json({
      overview: { totalWorkers: workers.length, emergency: emergency.length, critical: critical.length, warning: warning.length, online: online.length, safetyScore, avgRisk: +avgRisk.toFixed(2) },
      gas: { peakCH4: +peakCH4.toFixed(3), peakCO, minO2: +minO2.toFixed(1) },
      zones: Object.values(zoneMap),
      workers: workers.sort((a, b) => (b.risk || 0) - (a.risk || 0)),
      recentAlerts: alerts.slice(0, 10),
      activeAlerts: alerts.filter(a => !a.resolved).slice(0, 5),
      incidents: incidents.slice(0, 5),
      evacuations,
      drones,
      geofences,
      contactConfig,
      recentCalls,
      optimSummary,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-notify admin on new emergency alert (patch into alert creation)
app.post('/api/admin/notify', async (req, res) => {
  const { level, title, desc, workerId } = req.body;
  if (!level || !title) return res.status(400).json({ error: 'level and title required' });
  const workers = db.prepare('SELECT * FROM workers').all();
  const result = await notifyAdmin({ level, title, desc }, workers);
  res.json({ ok: true, result });
});

// Static frontend ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'index.html')));

// Start only after sql.js DB is ready (avoids empty /api/* on fast first requests)
db.ready.then(() => {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  🛡  SafeMine Backend v1.0                              ║
║                                                          ║
║  REST API  →  http://localhost:${PORT}/api                 ║
║  WebSocket →  ws://localhost:${PORT}                       ║
║  Frontend  →  http://localhost:${PORT}                     ║
║  MQTT      →  mqtt://localhost:${MQTT_PORT}            ║
╚══════════════════════════════════════════════════════════╝
  `);

    if (DUMMY_MODE) {
      console.log('[DummyEngine] ✅ Starting dummy telemetry loop (no MQTT).');
      startDummyEngine({
        intervalMs: 3000,
        anchorsIntervalMs: 15000,
        onHelmet: (workerId, payload) => {
          // Skip workers that are sending real ESP32 hardware data.
          // isRealHardwareWorker() returns true if a real packet arrived
          // within the last 10 seconds (REAL_HW_TTL_MS).
          if (isRealHardwareWorker(workerId)) {
            return; // Real device is active — do NOT overwrite with dummy data
          }
          handleHelmetUpdate(workerId, payload);
        },
        onWristband: (workerId, payload) => handleWristbandUpdate(workerId, payload),
        onAnchor: (anchorId, payload) => handleAnchorUpdate(anchorId, payload),
      });
    } else {
      // ── Start built-in live data simulator ────────────────────
      // Pushes realistic telemetry every 3s via MQTT for all 12 workers
      startSimulator(MQTT_PORT);
    }
  });
}).catch(err => {
  console.error('[Server] Cannot start — database failed:', err.message);
  process.exit(1);
});

module.exports = { app, broadcast };
