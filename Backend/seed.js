

'use strict';

const path = require('path');
const fs = require('fs');
const DB_PATH = path.join(__dirname, 'mineguard.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    zone TEXT DEFAULT 'Zone A', tunnel TEXT DEFAULT 'T1',
    x REAL DEFAULT 0, y REAL DEFAULT 0, depth REAL DEFAULT 0,
    ch4 REAL DEFAULT 0, co REAL DEFAULT 0, o2 REAL DEFAULT 20.9,
    temp REAL DEFAULT 22, heart_rate INTEGER DEFAULT 72,
    battery INTEGER DEFAULT 100, panic INTEGER DEFAULT 0,
    fall INTEGER DEFAULT 0, motion INTEGER DEFAULT 1,
    rssi INTEGER DEFAULT -80, risk REAL DEFAULT 0,
    status TEXT DEFAULT 'online', last_seen TEXT,
    protocol TEXT DEFAULT 'LoRaWAN'
  );
  CREATE TABLE IF NOT EXISTS telemetry (
    id TEXT PRIMARY KEY, worker_id TEXT, zone TEXT, tunnel TEXT,
    x REAL, y REAL, depth REAL, ch4 REAL, co REAL, o2 REAL,
    temp REAL, heart_rate INTEGER, battery INTEGER,
    panic INTEGER, fall INTEGER, rssi INTEGER, risk REAL, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY, level TEXT NOT NULL, title TEXT NOT NULL,
    desc TEXT, worker_id TEXT DEFAULT '', zone TEXT DEFAULT '', created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS anchors (
    id TEXT PRIMARY KEY, tunnel TEXT, x REAL, y REAL, depth REAL,
    rssi INTEGER, status TEXT DEFAULT 'online', last_seen TEXT
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY, type TEXT, description TEXT, zone TEXT,
    severity TEXT DEFAULT 'medium', reporter TEXT,
    status TEXT DEFAULT 'open', created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS evacuations (
    id TEXT PRIMARY KEY, zone TEXT, reason TEXT, initiated_by TEXT,
    status TEXT DEFAULT 'active', created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS geofences (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT,
    type TEXT,
    radius REAL,
    cx REAL,
    cy REAL,
    active INTEGER DEFAULT 1,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS refuges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT,
    tunnel TEXT,
    x REAL,
    y REAL,
    capacity INTEGER,
    supplies INTEGER,
    status TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS drones (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zone TEXT,
    status TEXT,
    battery INTEGER,
    feed TEXT,
    lastInspection TEXT
  );
`;

const now = new Date().toISOString();

// Mine site GPS center (adjust to your real mine location)
const MINE_LAT = 5.5600;   // ← change to your mine's real latitude
const MINE_LNG = -0.2000;  // ← change to your mine's real longitude

// Each worker gets a slightly offset GPS position so they appear on Surface Map
// (Real systems receive this from helmet GPS; here we spread them around the mine site)
const workers = [ 
  // id, name, zone, tunnel, x, y, depth, ch4, co, o2, temp, heart_rate, battery, panic, fall, motion, rssi, risk, status, last_seen, protocol, lat, lng
  ['MNR-001', 'Rahul Sharma',  'Zone A', 'T1', 170, 90,  30, 0.10, 8,  20.6, 24, 76, 88, 0, 0, 1, -72, 1.2, 'online',  now, 'LoRaWAN', MINE_LAT + 0.0005, MINE_LNG + 0.0003],
  ['MNR-002', 'Priya Verma',   'Zone B', 'T2', 280, 160, 55, 0.60, 28, 20.1, 31, 94, 72, 0, 0, 1, -79, 4.8, 'warning', now, 'UWB',    MINE_LAT - 0.0002, MINE_LNG + 0.0008],
  ['MNR-003', 'Amit Singh',    'Zone C', 'T3', 460, 210, 75, 1.20, 55, 19.4, 36, 112,61, 0, 0, 1, -85, 7.9, 'critical',now, 'BLE',    MINE_LAT + 0.0010, MINE_LNG - 0.0005],
  ['MNR-004', 'Neha Gupta',    'Zone A', 'T1', 170, 130, 35, 0.00, 3,  20.9, 23, 68, 95, 0, 0, 1, -68, 0.6, 'online',  now, 'LoRaWAN', MINE_LAT + 0.0003, MINE_LNG - 0.0002],
  ['MNR-005', 'Fatima Khan',   'Zone B', 'T2', 350, 160, 60, 0.30, 15, 20.5, 28, 82, 44, 0, 0, 1, -88, 2.1, 'online',  now, 'UWB',    MINE_LAT - 0.0008, MINE_LNG + 0.0004],
  ['MNR-006', 'Vikram Patel',  'Zone A', 'T4', 350, 310, 90, 0.40, 22, 20.2, 30, 88, 79, 0, 0, 1, -75, 3.4, 'warning', now, 'RFID',   MINE_LAT - 0.0004, MINE_LNG + 0.0010],
  ['MNR-007', 'Aisha Sheikh',  'Zone C', 'T3', 530, 250, 80, 0.00, 5,  20.8, 25, 71, 91, 0, 0, 1, -70, 0.8, 'online',  now, 'LoRaWAN', MINE_LAT + 0.0015, MINE_LNG + 0.0002],
  ['MNR-008', 'Rohit Yadav',   'Zone D', 'T5', 680, 280,105, 0.90, 42, 19.7, 33, 103,55, 0, 0, 0, -83, 6.2, 'critical',now, 'UWB',    MINE_LAT + 0.0008, MINE_LNG - 0.0007],
  ['MNR-009', 'Karan Mehta',   'Zone D', 'T6', 750, 340,120, 0.00, 4,  20.9, 22, 65, 100,0, 0, 1, -65, 0.4, 'online',  now, 'BLE',    MINE_LAT + 0.0001, MINE_LNG + 0.0001],
  ['MNR-010', 'Sneha Iyer',    'Zone B', 'T2', 230, 160, 58, 0.20, 10, 20.7, 26, 78, 67, 0, 0, 1, -90, 1.5, 'online',  now, 'LoRaWAN', MINE_LAT - 0.0012, MINE_LNG - 0.0009],
  ['MNR-011', 'Arjun Reddy',   'Zone E', 'T6', 820, 380,125, 0.50, 20, 20.3, 29, 85, 83, 0, 0, 1, -77, 3.0, 'warning', now, 'UWB',    MINE_LAT - 0.0006, MINE_LNG + 0.0007],
  ['MNR-012', 'Imran Ali',     'Zone F', 'T4', 500, 310, 95, 0.10, 7,  20.8, 27, 74, 58, 0, 0, 1, -86, 1.0, 'online',  now, 'RFID',   MINE_LAT - 0.0009, MINE_LNG - 0.0003],
];

const anchors = [
  ['ANC-T1-A', 'T1', 50, 50, 30, -65, 'online', now],
  ['ANC-T1-B', 'T1', 150, 50, 30, -62, 'online', now],
  ['ANC-T2-A', 'T2', 200, 130, 55, -68, 'online', now],
  ['ANC-T2-B', 'T2', 310, 130, 55, -71, 'online', now],
  ['ANC-T3-A', 'T3', 340, 200, 75, -74, 'online', now],
  ['ANC-T3-B', 'T3', 460, 200, 75, -69, 'warning', now],
  ['ANC-T4-A', 'T4', 460, 270, 90, -80, 'online', now],
  ['ANC-T5-A', 'T5', 580, 310, 105, -72, 'online', now],
  ['ANC-T6-A', 'T6', 690, 380, 125, -88, 'online', now],
  ['ANC-T6-B', 'T6', 800, 380, 125, -91, 'warning', now],
];

const alerts = [
  ['alr-001', 'critical', 'Methane Critical — Zone C', 'MNR-003: CH4 at 1.2% — explosive risk', 'MNR-003', 'Zone C', new Date(Date.now() - 5 * 60000).toISOString()],
  ['alr-002', 'critical', 'CO Toxic Level — Zone C', 'MNR-003: CO at 55 ppm — evacuation recommended', 'MNR-003', 'Zone C', new Date(Date.now() - 5 * 60000).toISOString()],
  ['alr-003', 'critical', 'Low Oxygen — Zone C', 'MNR-003: O2 at 19.4% — breathing hazard', 'MNR-003', 'Zone C', new Date(Date.now() - 6 * 60000).toISOString()],
  ['alr-004', 'warning', 'CO Elevated — Zone B', 'MNR-002: CO at 28 ppm', 'MNR-002', 'Zone B', new Date(Date.now() - 15 * 60000).toISOString()],
  ['alr-005', 'warning', 'Worker Stationary', 'MNR-008: No motion detected for 5+ minutes', 'MNR-008', 'Zone C', new Date(Date.now() - 20 * 60000).toISOString()],
  ['alr-006', 'warning', 'Low Battery — MNR-005', 'MNR-005: 44% battery remaining', 'MNR-005', 'Zone D', new Date(Date.now() - 45 * 60000).toISOString()],
];

const incidents = [
  ['INC-001', 'Gas Leak', 'Methane buildup near stope T3-B. Fan #3 activated.', 'Zone C', 'high', 'Auto-System', 'open', new Date(Date.now() - 30 * 60000).toISOString()],
  ['INC-002', 'Equipment Fault', 'Anchor ANC-T3-B intermittent signal.', 'Zone C', 'medium', 'Control Room', 'open', new Date(Date.now() - 2 * 3600000).toISOString()],
  ['INC-003', 'Minor Injury', 'MNR-006 hand laceration. First aid given.', 'Zone B', 'low', 'MNR-006', 'resolved', new Date(Date.now() - 5 * 3600000).toISOString()],
];

async function seed() {
  console.log('[Seed] Initializing sql.js...');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    sqlDb = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('[Seed] Loaded existing database');
  } else {
    sqlDb = new SQL.Database();
    console.log('[Seed] Created new database');
  }

  // Apply schema
  sqlDb.run(SCHEMA);

  function run(sql, params) {
    try { sqlDb.run(sql, params); }
    catch (e) { console.error('[Seed] row error:', e.message); }
  }

  function save() {
    const data = sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  // Add lat/lng columns to workers table if not present
  try { sqlDb.run(`ALTER TABLE workers ADD COLUMN lat REAL DEFAULT 0`); } catch (e) { }
  try { sqlDb.run(`ALTER TABLE workers ADD COLUMN lng REAL DEFAULT 0`); } catch (e) { }
  try { sqlDb.run(`ALTER TABLE workers ADD COLUMN flammable_gas REAL DEFAULT 0`); } catch (e) { }
  try { sqlDb.run(`ALTER TABLE telemetry ADD COLUMN flammable_gas REAL DEFAULT 0`); } catch (e) { }

  // Workers
  for (const w of workers) {
    const fg = (w[7] || 0) + (w[8] || 0);
    run(`INSERT OR REPLACE INTO workers
      (id,name,zone,tunnel,x,y,depth,ch4,co,o2,temp,heart_rate,battery,
       panic,fall,motion,rssi,risk,status,last_seen,protocol,lat,lng,flammable_gas)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...w, fg]);
  }
  console.log(`[Seed] ✅ ${workers.length} miners inserted`);

  // Anchors
  for (const a of anchors) {
    run(`INSERT OR REPLACE INTO anchors (id,tunnel,x,y,depth,rssi,status,last_seen) VALUES (?,?,?,?,?,?,?,?)`, a);
  }
  console.log(`[Seed] ✅ ${anchors.length} anchors inserted`);

  // Alerts
  for (const a of alerts) {
    run(`INSERT OR REPLACE INTO alerts (id,level,title,desc,worker_id,zone,created_at) VALUES (?,?,?,?,?,?,?)`, a);
  }
  console.log(`[Seed] ✅ ${alerts.length} alerts inserted`);

  // Incidents
  for (const i of incidents) {
    run(`INSERT OR REPLACE INTO incidents (id,type,description,zone,severity,reporter,status,created_at) VALUES (?,?,?,?,?,?,?,?)`, i);
  }
  console.log(`[Seed] ✅ ${incidents.length} incidents inserted`);

  // ── Mine GPS Settings (CRITICAL — fixes Surface Map blank screen) ──
  const mineSettings = JSON.stringify({
    mineName: 'SafeMine Site',
    mineLat: MINE_LAT,
    mineLng: MINE_LNG,
    alertEmail: '',
    smsGateway: '',
    ch4Warn: 0.5,
    ch4Crit: 1.0,
    coWarn: 25,
    coCrit: 50,
    o2Low: 19.5,
    tempHigh: 35,
    updatedAt: now,
  });
  run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sys', ?)`, [mineSettings]);
  console.log(`[Seed] ✅ Mine GPS settings saved — Lat:${MINE_LAT} Lng:${MINE_LNG}`);

  // ── Default Geofences (aligned with tunnel canvas layout 900x520) ──────────
  const geofences = [
    // Zone C / T3 — known methane danger area
    ['gf-zone-c-hazard', 'Zone C Methane Zone', 'Zone C', 'hazard', 55, 400, 210, 1, now],
    // T4 deep section — machinery/drill zone
    ['gf-t4-machinery', 'Deep Drill Zone T4', 'Zone D', 'machinery', 50, 520, 310, 1, now],
    // T6 deepest — high-risk restricted
    ['gf-t6-restricted', 'T6 Restricted Entry', 'Zone F', 'restricted', 45, 750, 380, 1, now],
    // T2 junction — safe muster point
    ['gf-t2-muster', 'T2 Muster Point', 'Zone B', 'safe', 40, 280, 160, 1, now],
    // Main shaft entry — access control safe zone
    ['gf-shaft-entry', 'Shaft Entry Safe', 'Zone A', 'safe', 35, 170, 70, 1, now],
    // T5 — restricted zone near machinery
    ['gf-t5-restricted', 'T5 Equipment Bay', 'Zone E', 'restricted', 45, 650, 290, 1, now],
  ];
  for (const g of geofences) {
    run(`INSERT OR REPLACE INTO geofences (id,name,zone,type,radius,cx,cy,active,created_at) VALUES (?,?,?,?,?,?,?,?,?)`, g);
  }
  console.log(`[Seed] ✅ ${geofences.length} default geofences inserted`);

  save();
  console.log(`\n✅ Database seeded and saved to: ${DB_PATH}\n`);
}

seed().catch(e => {
  console.error('[Seed] FATAL:', e.message);
  process.exit(1);
});
