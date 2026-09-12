'use strict';

// Simple backend dummy engine:
// - Updates worker telemetry every 3 seconds (drift + occasional scenario events)
// - Updates anchors every 15 seconds
// - Calls back into server pipeline so risk/status/alerts are calculated there

// ── NEW: Dynamic O2 calculation module (o2Calculation.js) ────
// Replaces static random-walk O2 with a physics-inspired model
// based on worker count + MQ2 gas level. The original evolveGas()
// O2 logic is PRESERVED below for comparison; only the outgoing
// payload value is overridden via calculateOxygenLevel().
const { calculateOxygenLevel, getO2Status } = require('./o2Calculation');

function jitter(base, spread) {
  return +(base + (Math.random() - 0.5) * spread * 2).toFixed(3);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ── Worker roster (must match seeded worker IDs) ──────────────
const WORKERS = [
  { id: 'MNR-001', name: 'Rahul Sharma',     zone: 'Zone A', tunnel: 'T1', depth: 30, x: 170, y: 90,  protocol: 'LoRaWAN' },
  { id: 'MNR-002', name: 'Priya Verma',      zone: 'Zone B', tunnel: 'T2', depth: 55, x: 280, y: 160, protocol: 'UWB'      },
  { id: 'MNR-003', name: 'Amit Singh',       zone: 'Zone C', tunnel: 'T3', depth: 75, x: 460, y: 210, protocol: 'BLE'      },
  { id: 'MNR-004', name: 'Neha Gupta',       zone: 'Zone A', tunnel: 'T1', depth: 35, x: 170, y: 130, protocol: 'LoRaWAN'  },
  { id: 'MNR-005', name: 'Fatima Khan',      zone: 'Zone B', tunnel: 'T2', depth: 60, x: 350, y: 160, protocol: 'UWB'      },
  { id: 'MNR-006', name: 'Vikram Patel',     zone: 'Zone A', tunnel: 'T4', depth: 90, x: 350, y: 310, protocol: 'RFID'     },
  { id: 'MNR-007', name: 'Aisha Sheikh',     zone: 'Zone C', tunnel: 'T3', depth: 80, x: 530, y: 250, protocol: 'LoRaWAN'  },
  { id: 'MNR-008', name: 'Rohit Yadav',      zone: 'Zone D', tunnel: 'T5', depth: 105, x: 680, y: 280, protocol: 'UWB'     },
  { id: 'MNR-009', name: 'Karan Mehta',      zone: 'Zone D', tunnel: 'T6', depth: 120, x: 750, y: 340, protocol: 'BLE'     },
  { id: 'MNR-010', name: 'Sneha Iyer',       zone: 'Zone B', tunnel: 'T2', depth: 58, x: 230, y: 160, protocol: 'LoRaWAN'  },
  { id: 'MNR-011', name: 'Arjun Reddy',      zone: 'Zone E', tunnel: 'T6', depth: 125, x: 820, y: 380, protocol: 'UWB'     },
  { id: 'MNR-012', name: 'Imran Ali',        zone: 'Zone F', tunnel: 'T4', depth: 95, x: 500, y: 310, protocol: 'RFID'     },
];

const anchors = [
  { id: 'ANC-T1-A', tunnel: 'T1', x: 150, y: 50,  depth: 30, baseRssi: -62 },
  { id: 'ANC-T1-B', tunnel: 'T1', x: 150, y: 110, depth: 30, baseRssi: -68 },
  { id: 'ANC-T2-A', tunnel: 'T2', x: 200, y: 130, depth: 55, baseRssi: -71 },
  { id: 'ANC-T2-B', tunnel: 'T2', x: 310, y: 130, depth: 55, baseRssi: -74 },
  { id: 'ANC-T3-A', tunnel: 'T3', x: 340, y: 200, depth: 75, baseRssi: -74 },
  { id: 'ANC-T3-B', tunnel: 'T3', x: 460, y: 200, depth: 75, baseRssi: -69 },
  { id: 'ANC-T4-A', tunnel: 'T4', x: 460, y: 270, depth: 90, baseRssi: -80 },
  { id: 'ANC-T5-A', tunnel: 'T5', x: 580, y: 310, depth: 105, baseRssi: -72 },
  { id: 'ANC-T6-A', tunnel: 'T6', x: 690, y: 380, depth: 125, baseRssi: -88 },
  { id: 'ANC-T6-B', tunnel: 'T6', x: 800, y: 380, depth: 125, baseRssi: -91 },
];

function createInitialWorkerState() {
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
      panic: 0,
      fall: 0,
      motion: 1,
      rssi: jitter(-72, 6),
      // Slow drift accumulators
      _ch4Dir: 1,
      _coDir: 1,
      _o2Dir: -1,
      _panicInjected: false,
    };
  });

  // Start with a slightly elevated worker like the old simulator
  state['MNR-003'].ch4 = 0.68;
  state['MNR-003'].co = 28;
  state['MNR-003'].o2 = 19.8;
  state['MNR-003'].panic = 0;

  return state;
}

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

  // Temperature slow drift 22–38°C
  s.temp = clamp(jitter(s.temp, 0.3), 22, 38);

  // Heart rate variation
  s.heart_rate = clamp(Math.round(jitter(s.heart_rate, 2)), 58, 140);

  // Battery slowly drains
  s.battery = clamp(s.battery - 0.002, 5, 100);

  // RSSI varies slightly
  s.rssi = clamp(Math.round(jitter(s.rssi, 2)), -98, -45);

  // Small random position drift
  s.x = clamp(s.x + jitter(0, 0.5), 50, 870);
  s.y = clamp(s.y + jitter(0, 0.3), 30, 450);
}

function makeSpikeController() {
  // For the "simple" engine we focus on methane spikes in Zone C.
  let eventCooldown = 0;
  let spikeTicks = 0;

  function maybeInjectEvent(s) {
    if (eventCooldown > 0) {
      eventCooldown--;
      return;
    }

    // 4% chance each tick: Zone C methane spike
    const rand = Math.random();
    if (rand < 0.04) {
      eventCooldown = 20;
      spikeTicks = 0;
      s.ch4 = jitter(1.1, 0.15);
      s.co = jitter(55, 10);
      s.o2 = jitter(19.0, 0.2);
      s._panicInjected = false;
      return;
    }

    // 6% chance: recover back a bit when not spiking
    if (rand < 0.06) {
      s.ch4 = jitter(0.3, 0.05);
      s.co = jitter(15, 5);
      s.o2 = clamp(jitter(20.0, 0.1), 19.2, 21.0);
    }
  }

  function maybeInjectPanicOnSpike(s) {
    // If currently in a high CH4 band, slowly (over a few ticks) trigger panic once.
    if (s.ch4 >= 0.9 && !s._panicInjected) {
      spikeTicks++;
      if (spikeTicks > 10 && Math.random() < 0.15) {
        s.panic = 1;
        s._panicInjected = true;
      }
    } else {
      // recover panic
      s.panic = 0;
      spikeTicks = 0;
    }
  }

  return { maybeInjectEvent, maybeInjectPanicOnSpike };
}

function startDummyEngine({
  intervalMs = 3000,
  anchorsIntervalMs = 15000,
  onHelmet,
  onWristband,
  onAnchor,
} = {}) {
  if (typeof onHelmet !== 'function') throw new Error('startDummyEngine: onHelmet callback is required');
  if (typeof onAnchor !== 'function') throw new Error('startDummyEngine: onAnchor callback is required');

  const state = createInitialWorkerState();
  const spikeController = makeSpikeController();

  function tickWorkers() {
    // ── NEW: Count active workers for O2 consumption model ───
    // Object.keys(state).length gives the total worker count
    // in the dummy-engine pool. In real mode, server.js would
    // use Object.keys(workers).length from the DB instead.
    const activeWorkerCount = Object.keys(state).length;

    // Update each worker and call the server's ingest pipeline
    WORKERS.forEach(w => {
      const s = state[w.id];

      if (w.zone === 'Zone C') {
        spikeController.maybeInjectEvent(s);
      }

      // ORIGINAL O2 logic (random walk) — kept intact for comparison.
      // evolveGas() still updates s.o2 internally; it is not used
      // in the outgoing payload (see below), but remains available
      // for reference / fallback if the new module is disabled.
      evolveGas(s);

      if (w.zone === 'Zone C') {
        spikeController.maybeInjectPanicOnSpike(s);
      }

      // ── NEW INTEGRATION POINT ────────────────────────────────
      // calculateOxygenLevel() produces a dynamic O2 value based
      // on:  (1) total active workers  →  respiration consumption
      //      (2) current MQ2/CH4 gas reading  →  gas displacement
      // This REPLACES the static s.o2 value in the outgoing payload.
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
        // NEW: dynamic O2 replaces static evolveGas() o2 value
        o2: dynamicO2,
        o2_label: o2Status.label,
        o2_color: o2Status.color,
        temp: +s.temp.toFixed(1),
        heart_rate: s.heart_rate,
        battery: +s.battery.toFixed(1),
        panic: s.panic,
        fall: s.fall,
        motion: s.motion,
        rssi: s.rssi,
        protocol: w.protocol,
        // Simulated raw MQ2 ADC reading (0-4095 scale).
        // Formula mirrors ESP32: gas = ch4 / 10000.0 => gas_raw = ch4 * 10000
        // Clamped to 0-4095 (12-bit ADC). Add jitter to simulate noise.
        gas_raw: Math.round(clamp(s.ch4 * 10000 + jitter(0, 20), 0, 4095)),
        // Simulated BMP180 barometric pressure (hPa). Varies slightly by depth.
        pressure: +(1013.25 - (w.depth * 0.12) + jitter(0, 0.5)).toFixed(1),
        ts: Date.now(),
      };

      onHelmet(w.id, payload);

      // Wristband is a minimal, independent fallback.
      if (typeof onWristband === 'function') {
        onWristband(w.id, {
          battery: Math.max(5, Math.min(100, Math.round(s.battery))),
          movement: !!s.motion,
          sos: false,
          signal: s.rssi,
          ts: Date.now(),
        });
      }
    });
  }

  function tickAnchors() {
    anchors.forEach(a => {
      const payload = {
        tunnel: a.tunnel,
        x: a.x,
        y: a.y,
        depth: a.depth,
        rssi: a.baseRssi + Math.round((Math.random() - 0.5) * 4),
        status: Math.random() > 0.07 ? 'online' : 'warning',
        ts: Date.now(),
      };
      onAnchor(a.id, payload);
    });
  }

  // Immediate tick so the UI gets updates quickly
  tickWorkers();
  tickAnchors();

  setInterval(tickWorkers, intervalMs);
  setInterval(tickAnchors, anchorsIntervalMs);

  console.log(`[DummyEngine] Running: workers every ${intervalMs}ms, anchors every ${anchorsIntervalMs}ms`);
}

module.exports = { startDummyEngine };

