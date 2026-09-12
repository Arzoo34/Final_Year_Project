// ============================================================
//  MineGuard Pro — Built-in Live Data Simulator
//  Publishes realistic telemetry via MQTT → server processes it
//  Runs automatically when server starts
// ============================================================
'use strict';

const mqtt = require('mqtt');

// NEW: Dynamic O2 calculation module (mirrors dummy-engine.js integration)
// Replaces the static O2 random walk with a worker+gas based model.
const { calculateOxygenLevel, getO2Status } = require('./o2Calculation');

// ── Mine Worker Roster ────────────────────────────────────────
const WORKERS = [ 
  { id: 'MNR-001', name: 'Rahul Sharma',    zone: 'Zone A', tunnel: 'T1', x: 170, y: 90,  depth: 30,  protocol: 'LoRaWAN' },
  { id: 'MNR-002', name: 'Priya Verma',     zone: 'Zone B', tunnel: 'T2', x: 280, y: 160, depth: 55,  protocol: 'UWB'     },
  { id: 'MNR-003', name: 'Amit Singh',      zone: 'Zone C', tunnel: 'T3', x: 460, y: 210, depth: 75,  protocol: 'BLE'     },
  { id: 'MNR-004', name: 'Neha Gupta',      zone: 'Zone A', tunnel: 'T1', x: 170, y: 130, depth: 35,  protocol: 'LoRaWAN' },
  { id: 'MNR-005', name: 'Fatima Khan',     zone: 'Zone B', tunnel: 'T2', x: 350, y: 160, depth: 60,  protocol: 'UWB'     },
  { id: 'MNR-006', name: 'Vikram Patel',    zone: 'Zone A', tunnel: 'T4', x: 350, y: 310, depth: 90,  protocol: 'RFID'    },
  { id: 'MNR-007', name: 'Aisha Sheikh',    zone: 'Zone C', tunnel: 'T3', x: 530, y: 250, depth: 80,  protocol: 'LoRaWAN' },
  { id: 'MNR-008', name: 'Rohit Yadav',     zone: 'Zone D', tunnel: 'T5', x: 680, y: 280, depth: 105, protocol: 'UWB'     },
  { id: 'MNR-009', name: 'Karan Mehta',     zone: 'Zone D', tunnel: 'T6', x: 750, y: 340, depth: 120, protocol: 'BLE'     },
  { id: 'MNR-010', name: 'Sneha Iyer',      zone: 'Zone B', tunnel: 'T2', x: 230, y: 160, depth: 58,  protocol: 'LoRaWAN' },
  { id: 'MNR-011', name: 'Arjun Reddy',     zone: 'Zone E', tunnel: 'T6', x: 820, y: 380, depth: 125, protocol: 'UWB'     },
  { id: 'MNR-012', name: 'Imran Ali',       zone: 'Zone F', tunnel: 'T4', x: 500, y: 310, depth: 95,  protocol: 'RFID'    },
];

// ── Worker live state ─────────────────────────────────────────
const state = {};
WORKERS.forEach(w => {
  state[w.id] = {
    ...w,
    ch4: jitter(0.08, 0.04),
    co: jitter(8, 4),
    o2: jitter(20.7, 0.1),
    temp: jitter(24, 1),
    heart_rate: jitter(72, 5),
    battery: jitter(85, 5),
    panic: 0, fall: 0, motion: 1,
    rssi: jitter(-72, 6),
    // Slow drift accumulators
    _ch4Dir: 1, _coDir: 1, _o2Dir: -1,
  };
});

// ── One worker has elevated gas (Zone C drama) ────────────────
state['MNR-003'].ch4 = 0.68;
state['MNR-003'].co  = 28;
state['MNR-003'].o2  = 19.8;

// ── Anchors ───────────────────────────────────────────────────
const ANCHORS = [
  { id: 'ANC-T1-A', tunnel: 'T1', x: 150, y: 50,  depth: 30,  rssi: -62 },
  { id: 'ANC-T1-B', tunnel: 'T1', x: 150, y: 110, depth: 30,  rssi: -68 },
  { id: 'ANC-T2-A', tunnel: 'T2', x: 200, y: 130, depth: 55,  rssi: -71 },
  { id: 'ANC-T2-B', tunnel: 'T2', x: 310, y: 130, depth: 55,  rssi: -74 },
  { id: 'ANC-T3-A', tunnel: 'T3', x: 340, y: 200, depth: 75,  rssi: -74 },
  { id: 'ANC-T3-B', tunnel: 'T3', x: 460, y: 200, depth: 75,  rssi: -69 },
  { id: 'ANC-T4-A', tunnel: 'T4', x: 460, y: 270, depth: 90,  rssi: -80 },
  { id: 'ANC-T5-A', tunnel: 'T5', x: 580, y: 310, depth: 105, rssi: -72 },
  { id: 'ANC-T6-A', tunnel: 'T6', x: 690, y: 380, depth: 125, rssi: -88 },
  { id: 'ANC-T6-B', tunnel: 'T6', x: 800, y: 380, depth: 125, rssi: -91 },
];

// ── Helpers ───────────────────────────────────────────────────
function jitter(base, spread) {
  return +(base + (Math.random() - 0.5) * spread * 2).toFixed(3);
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ── Gas drift simulation ──────────────────────────────────────
function evolveGas(s) {
  // CH4 slow random walk 0–0.4% normally, can spike
  s.ch4 = clamp(s.ch4 + jitter(0, 0.015) * s._ch4Dir, 0, 1.5);
  if (s.ch4 > 0.45 || s.ch4 < 0.02) s._ch4Dir *= -1;

  // CO random walk 5–40 ppm normally
  s.co = clamp(s.co + jitter(0, 0.6) * s._coDir, 3, 80);
  if (s.co > 35 || s.co < 4) s._coDir *= -1;

  // O2 stays around 20.4–20.9%
  s.o2 = clamp(s.o2 + jitter(0, 0.02) * s._o2Dir, 19.2, 21.0);
  if (s.o2 < 20.2 || s.o2 > 20.9) s._o2Dir *= -1;

  // Temperature slow drift 22–32°C
  s.temp = clamp(jitter(s.temp, 0.3), 22, 38);

  // Heart rate variation 65–95 bpm normally
  s.heart_rate = clamp(Math.round(jitter(s.heart_rate, 2)), 58, 140);

  // Battery slowly drains
  s.battery = clamp(s.battery - 0.002, 5, 100);

  // RSSI varies slightly
  s.rssi = clamp(Math.round(jitter(s.rssi, 2)), -98, -45);

  // Small random position drift
  s.x = clamp(s.x + jitter(0, 0.5), 50, 870);
  s.y = clamp(s.y + jitter(0, 0.3), 30, 450);

  return s;
}

// ── Occasional dramatic events ────────────────────────────────
let eventCooldown = 0;
function maybeInjectEvent() {
  if (eventCooldown > 0) { eventCooldown--; return; }

  const rand = Math.random();
  if (rand < 0.04) { // 4% chance each tick: Zone C methane spike
    state['MNR-003'].ch4 = jitter(1.1, 0.15);
    state['MNR-003'].co  = jitter(55, 10);
    state['MNR-003'].risk = 8.5;
    eventCooldown = 20;
    console.log('[SIM] ⚠ Zone C methane spike injected');
  } else if (rand < 0.06) { // Zone C recovers
    state['MNR-003'].ch4 = jitter(0.3, 0.05);
    state['MNR-003'].co  = jitter(15, 5);
  }
}

// ── Start simulator ───────────────────────────────────────────
function startSimulator(mqttPort) {
  const port = mqttPort || parseInt(process.env.MQTT_PORT || '1883');
  let client = null;
  let retries = 0;

  function connect() {
    console.log(`[SIM] Connecting to MQTT broker on port ${port}...`);
    client = mqtt.connect(`mqtt://127.0.0.1:${port}`, {
      clientId: `mineguard-sim-${Date.now()}`,
      reconnectPeriod: 0,
      connectTimeout: 5000,
    });

    client.on('connect', () => {
      console.log('[SIM] ✅ Simulator connected — broadcasting live telemetry every 3s');
      retries = 0;
      startPublishing(client);
    });

    client.on('error', err => {
      if (retries < 20) {
        retries++;
        console.log(`[SIM] Waiting for MQTT broker... (attempt ${retries})`);
        setTimeout(connect, 1500);
      }
    });

    client.on('close', () => {
      if (retries < 20) {
        retries++;
        setTimeout(connect, 2000);
      }
    });
  }

  // Wait 2s for the MQTT broker to be ready before connecting
  setTimeout(connect, 2000);
}

function startPublishing(client) {
  // Total active workers for the O2 respiration model
  const activeWorkerCount = WORKERS.length;

  // Publish worker telemetry every 3 seconds
  setInterval(() => {
    maybeInjectEvent();

    WORKERS.forEach(w => {
      const s = state[w.id];
      evolveGas(s);

      // ── NEW INTEGRATION POINT ───────────────────────────────
      // calculateOxygenLevel() produces a dynamic O2 value based on:
      //   (1) total active workers → respiration consumption
      //   (2) current MQ2/CH4 reading → gas displacement
      // This REPLACES the static s.o2 random-walk value in the
      // MQTT payload. Original: o2: +s.o2.toFixed(2)
      const dynamicO2 = calculateOxygenLevel(activeWorkerCount, s.ch4);
      const o2Status  = getO2Status(dynamicO2);

      const payload = {
        name: w.name,
        zone: w.zone,
        tunnel: w.tunnel,
        x: +s.x.toFixed(1),
        y: +s.y.toFixed(1),
        depth: w.depth,
        ch4: +s.ch4.toFixed(3),
        co: +s.co.toFixed(1),
        // NEW: dynamic O2 replaces static random walk
        // Original was: o2: +s.o2.toFixed(2)
        o2: dynamicO2,
        o2_label: o2Status.label,  // 'SAFE' | 'WARNING' | 'DANGER'
        o2_color: o2Status.color,  // hex color for UI
        temp: +s.temp.toFixed(1),
        heart_rate: s.heart_rate,
        battery: +s.battery.toFixed(1),
        panic: s.panic,
        fall: s.fall,
        motion: s.motion,
        rssi: s.rssi,
        protocol: w.protocol,
        ts: Date.now(),
      };

      client.publish(
        `mineguard/helmet/${w.id}`,
        JSON.stringify(payload),
        { qos: 0, retain: false }
      );
    });
  }, 3000);

  // Publish anchor heartbeats every 15 seconds
  setInterval(() => {
    ANCHORS.forEach(a => {
      const payload = {
        tunnel: a.tunnel,
        x: a.x, y: a.y, depth: a.depth,
        rssi: a.rssi + Math.round((Math.random() - 0.5) * 4),
        status: Math.random() > 0.07 ? 'online' : 'warning',
        ts: Date.now(),
      };
      client.publish(`mineguard/anchor/${a.id}`, JSON.stringify(payload), { qos: 0 });
    });
    console.log('[SIM] 📡 Anchor heartbeats sent');
  }, 15000);

  console.log('[SIM] 🟢 Live simulation running — 12 miners, 10 anchors, 3s cadence');
}

module.exports = { startSimulator };
