// ============================================================
//  MineGuard Pro — LoRa Helmet Simulator  v2.0
//  Simulates 12 smart helmets + 10 anchor nodes via MQTT
//  Includes realistic emergency scenario injection
// ============================================================

'use strict';

require('dotenv').config();
const mqtt = require('mqtt');

const MQTT_URL = process.env.MQTT_BROKER || 'mqtt://127.0.0.1:1883';

console.log(`[LoRa Sim] Connecting to ${MQTT_URL}...`);
const client = mqtt.connect(MQTT_URL, {
  clientId: 'mineguard-lora-sim',
  reconnectPeriod: 3000,
});

// ── Miner base state ─────────────────────────────────────────
const miners = [
  { id: 'MNR-001', name: 'James Okafor', zone: 'Zone A', tunnel: 'T1', x: 120, y: 80, depth: 45, ch4: 0.10, co: 8, o2: 20.6, temp: 24, hr: 76, bat: 88, protocol: 'LoRaWAN' },
  { id: 'MNR-002', name: 'Sarah Mensah', zone: 'Zone B', tunnel: 'T2', x: 240, y: 160, depth: 62, ch4: 0.60, co: 28, o2: 20.1, temp: 31, hr: 94, bat: 72, protocol: 'UWB' },
  { id: 'MNR-003', name: 'Kwame Asante', zone: 'Zone C', tunnel: 'T3', x: 380, y: 220, depth: 78, ch4: 1.20, co: 55, o2: 19.4, temp: 36, hr: 112, bat: 61, protocol: 'LoRaWAN' },
  { id: 'MNR-004', name: 'Amara Diallo', zone: 'Zone A', tunnel: 'T1', x: 95, y: 55, depth: 38, ch4: 0.00, co: 3, o2: 20.9, temp: 23, hr: 68, bat: 95, protocol: 'BLE' },
  { id: 'MNR-005', name: 'Chidi Obi', zone: 'Zone D', tunnel: 'T4', x: 510, y: 290, depth: 95, ch4: 0.30, co: 15, o2: 20.5, temp: 28, hr: 82, bat: 44, protocol: 'LoRaWAN' },
  { id: 'MNR-006', name: 'Fatima Al-Rashid', zone: 'Zone B', tunnel: 'T2', x: 275, y: 145, depth: 58, ch4: 0.40, co: 22, o2: 20.2, temp: 30, hr: 88, bat: 79, protocol: 'RFID' },
  { id: 'MNR-007', name: 'Emmanuel Sarpong', zone: 'Zone E', tunnel: 'T5', x: 620, y: 340, depth: 112, ch4: 0.00, co: 5, o2: 20.8, temp: 25, hr: 71, bat: 91, protocol: 'LoRaWAN' },
  { id: 'MNR-008', name: 'Aisha Kamara', zone: 'Zone C', tunnel: 'T3', x: 420, y: 195, depth: 82, ch4: 0.90, co: 42, o2: 19.7, temp: 33, hr: 103, bat: 55, protocol: 'UWB' },
  { id: 'MNR-009', name: 'Kofi Boateng', zone: 'Zone A', tunnel: 'T1', x: 145, y: 90, depth: 48, ch4: 0.00, co: 4, o2: 20.9, temp: 22, hr: 65, bat: 100, protocol: 'BLE' },
  { id: 'MNR-010', name: 'Ishmael Dankwa', zone: 'Zone F', tunnel: 'T6', x: 740, y: 410, depth: 130, ch4: 0.20, co: 10, o2: 20.7, temp: 26, hr: 78, bat: 67, protocol: 'LoRaWAN' },
  { id: 'MNR-011', name: 'Makena Waweru', zone: 'Zone B', tunnel: 'T2', x: 260, y: 175, depth: 65, ch4: 0.50, co: 20, o2: 20.3, temp: 29, hr: 85, bat: 83, protocol: 'RFID' },
  { id: 'MNR-012', name: 'Nana Yaw Poku', zone: 'Zone D', tunnel: 'T4', x: 490, y: 310, depth: 98, ch4: 0.10, co: 7, o2: 20.8, temp: 27, hr: 74, bat: 58, protocol: 'LoRaWAN' },
];

// ── Anchor nodes (repeater infrastructure) ───────────────────
const anchors = [
  { id: 'ANC-001', tunnel: 'T1', x: 170, y: 60, depth: 30 },
  { id: 'ANC-002', tunnel: 'T1', x: 170, y: 120, depth: 50 },
  { id: 'ANC-003', tunnel: 'T2', x: 290, y: 160, depth: 62 },
  { id: 'ANC-004', tunnel: 'T2', x: 380, y: 160, depth: 68 },
  { id: 'ANC-005', tunnel: 'T3', x: 450, y: 220, depth: 78 },
  { id: 'ANC-006', tunnel: 'T3', x: 560, y: 250, depth: 85 },
  { id: 'ANC-007', tunnel: 'T4', x: 400, y: 310, depth: 92 },
  { id: 'ANC-008', tunnel: 'T4', x: 600, y: 310, depth: 100 },
  { id: 'ANC-009', tunnel: 'T5', x: 720, y: 300, depth: 110 },
  { id: 'ANC-010', tunnel: 'T6', x: 800, y: 390, depth: 125 },
];

function jitter(v, pct = 0.03) { return +(v + (Math.random() - 0.5) * v * pct).toFixed(2); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let tick = 0;
let emergencyMode = false;
let emergencyMiner = null;
let emergencyTick = 0;

// ── Emergency scenario: slow gas escalation in Zone C ────────
function runEmergencyScenario() {
  const zoneC = miners.filter(m => m.zone === 'Zone C');
  if (!zoneC.length) return;
  emergencyMiner = zoneC[0];
  emergencyMode = true;
  emergencyTick = 0;
  console.log('\n[LoRa Sim] ⚠️  SCENARIO: Methane leak escalation starting in Zone C...\n');
}

client.on('connect', () => {
  console.log('[LoRa Sim] ✅ Connected — broadcasting helmet telemetry every 3s');
  console.log('[LoRa Sim] 📡 12 helmets · 10 anchor nodes active');
  console.log('[LoRa Sim] 🚨 Emergency scenario: Zone C gas escalation starts in 60s\n');

  // ── Helmet telemetry loop (every 3s, round-robin) ───────────
  setInterval(() => {
    tick++;
    const miner = miners[tick % miners.length];

    // Emergency drift for Zone C miners
    if (emergencyMode && miner.zone === 'Zone C') {
      emergencyTick++;
      miner.ch4 = clamp(miner.ch4 + 0.04, 0, 2.0);
      miner.co = clamp(miner.co + 2.5, 0, 100);
      miner.temp = clamp(miner.temp + 0.3, 18, 55);
      miner.o2 = clamp(miner.o2 - 0.02, 16, 21);
      // Trigger panic after ~20 ticks of escalation
      if (emergencyTick > 20 && miner.id === 'MNR-003' && !miner._panicked) {
        miner._panicked = true;
        miner.panic = 1;
        console.log(`[LoRa Sim] 🆘 MNR-003 PANIC BUTTON TRIGGERED!`);
      }
    } else {
      // Normal jitter
      miner.ch4 = clamp(jitter(miner.ch4, 0.05), 0, 2.0);
      miner.co = clamp(jitter(miner.co, 0.04), 0, 100);
      miner.o2 = clamp(jitter(miner.o2, 0.005), 18, 21);
      miner.temp = clamp(jitter(miner.temp, 0.02), 18, 45);
    }

    miner.hr = clamp(Math.round(jitter(miner.hr, 0.03)), 40, 160);
    miner.bat = clamp(+(miner.bat - 0.005).toFixed(2), 5, 100);
    miner.x = clamp(+(miner.x + (Math.random() - 0.5) * 3).toFixed(1), 0, 900);
    miner.y = clamp(+(miner.y + (Math.random() - 0.5) * 3).toFixed(1), 0, 500);

    const rssi = Math.round(-70 - Math.random() * 25);

    const payload = {
      name: miner.name,
      zone: miner.zone,
      tunnel: miner.tunnel,
      x: miner.x,
      y: miner.y,
      depth: miner.depth,
      ch4: +miner.ch4.toFixed(3),
      co: +miner.co.toFixed(1),
      o2: +miner.o2.toFixed(2),
      temp: +miner.temp.toFixed(1),
      heart_rate: miner.hr,
      battery: +miner.bat.toFixed(1),
      panic: miner.panic || 0,
      fall: miner.fall || 0,
      motion: miner.motion !== undefined ? miner.motion : 1,
      rssi,
      protocol: miner.protocol,
      ts: Date.now(),
    };

    const topic = `mineguard/helmet/${miner.id}`;
    client.publish(topic, JSON.stringify(payload), { qos: 0 });

    // Log only anomalous readings
    const alerts = [];
    if (payload.ch4 >= 1.0) alerts.push(`💨CH₄:${payload.ch4}%!`);
    if (payload.co >= 50) alerts.push(`🟤CO:${payload.co}ppm!`);
    if (payload.o2 <= 19.5) alerts.push(`🔵O₂:${payload.o2}%!`);
    if (payload.panic) alerts.push(`🆘PANIC!`);

    if (alerts.length) {
      console.log(`[LoRa Sim] ⚠️  ${miner.id} (${miner.zone}) ${alerts.join(' ')}`);
    }
  }, 3000);

  // ── Anchor heartbeat loop (every 15s) ──────────────────────
  setInterval(() => {
    anchors.forEach(a => {
      const rssi = Math.round(-65 - Math.random() * 20);
      const payload = {
        tunnel: a.tunnel,
        x: a.x,
        y: a.y,
        depth: a.depth,
        rssi,
        status: 'online',
        snr: +(5 + Math.random() * 8).toFixed(1),
        ts: Date.now(),
      };
      client.publish(`mineguard/anchor/${a.id}`, JSON.stringify(payload), { qos: 0 });
    });
  }, 15000);

  // ── Start emergency scenario after 60s ────────────────────
  setTimeout(runEmergencyScenario, 60_000);
});

client.on('error', err => console.error('[LoRa Sim] Error:', err.message));
client.on('offline', () => console.warn('[LoRa Sim] Offline — retrying...'));

process.on('SIGINT', () => {
  console.log('\n[LoRa Sim] Shutting down...');
  client.end();
  process.exit(0);
});
