// ============================================================
//  MineGuard Pro — db.js
//  Pure sql.js (no native bindings needed, works on any PC)
// ============================================================

'use strict';

const path = require('path');
const fs   = require('fs');
const DB_PATH = path.join(__dirname, 'mineguard.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    zone TEXT DEFAULT 'Zone A', tunnel TEXT DEFAULT 'T1',
    shift TEXT DEFAULT 'A',
    x REAL DEFAULT 0, y REAL DEFAULT 0, depth REAL DEFAULT 0,
    ch4 REAL DEFAULT 0, co REAL DEFAULT 0, flammable_gas REAL DEFAULT 0, o2 REAL DEFAULT 20.9,
    temp REAL DEFAULT 22, heart_rate INTEGER DEFAULT 72,
    battery INTEGER DEFAULT 100,                -- helmet battery (legacy)
    wristband_battery INTEGER DEFAULT 100,  -- wristband battery
    helmet_status TEXT DEFAULT 'offline',
    wristband_status TEXT DEFAULT 'offline',
    panic INTEGER DEFAULT 0,
    fall INTEGER DEFAULT 0, motion INTEGER DEFAULT 1,
    rssi INTEGER DEFAULT -80, risk REAL DEFAULT 0,
    status TEXT DEFAULT 'online', last_seen TEXT,
    protocol TEXT DEFAULT 'LoRaWAN',
    lat REAL DEFAULT 0, lng REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS telemetry (
    id TEXT PRIMARY KEY, worker_id TEXT, zone TEXT, tunnel TEXT,
    x REAL, y REAL, depth REAL, ch4 REAL, co REAL, flammable_gas REAL, o2 REAL,
    temp REAL, heart_rate INTEGER, battery INTEGER,
    panic INTEGER, fall INTEGER, rssi INTEGER, risk REAL, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    desc TEXT,
    worker_id TEXT DEFAULT '',
    zone TEXT DEFAULT '',
    type TEXT DEFAULT '',
    priority TEXT DEFAULT 'warning',
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    type TEXT NOT NULL, -- "helmet" | "wristband"
    battery INTEGER DEFAULT 100,
    last_seen TEXT,
    status TEXT DEFAULT 'offline'
  );
  -- Sensor health / maintenance: track faulty sensors across time
  CREATE TABLE IF NOT EXISTS sensor_faults (
    id TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    sensor TEXT NOT NULL,              -- e.g. ch4, temp, telemetry
    severity TEXT NOT NULL,           -- warning | critical
    first_detected_at TEXT,
    last_detected_at TEXT,
    last_active_at TEXT,             -- last time we saw valid telemetry
    repair_status TEXT DEFAULT 'required',  -- required | in_progress | resolved
    notes TEXT DEFAULT '',
    updated_at TEXT
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

  -- Persistent system settings (JSON string)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- Site configuration objects (no demo fallbacks; managed via API)
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

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT DEFAULT '',
    role TEXT DEFAULT 'operator',
    created_at TEXT
  );
`;

// ── In-memory store while sql.js loads ───────────────────────
let _sqlDb = null;
let _ready = false;

/** Resolve after sql.js is loaded, on-disk DB opened, and schema applied. */
let _resolveReady;
let _rejectReady;
const ready = new Promise((resolve, reject) => {
  _resolveReady = resolve;
  _rejectReady = reject;
});

// Save db to disk
function saveDB() {
  if (!_sqlDb) return;
  try {
    const data = _sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) { /* ignore */ }
}

// Execute a query safely
function execQuery(sql, params) {
  if (!_sqlDb) return [];
  try {
    const stmt = _sqlDb.prepare(sql);
    if (params && params.length > 0) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.error('[DB] Query error:', e.message, '\nSQL:', sql.slice(0, 100));
    return [];
  }
}

function execRun(sql, params) {
  if (!_sqlDb) return;
  try {
    if (params && params.length > 0) {
      _sqlDb.run(sql, params);
    } else {
      _sqlDb.run(sql);
    }
    saveDB();
  } catch (e) {
    console.error('[DB] Run error:', e.message, '\nSQL:', sql.slice(0, 100));
  }
}

// ── Proxy object that behaves like better-sqlite3 ─────────────
const db = {
  prepare(sql) {
    const trimmed = sql.trim();

    return {
      // Handle named params (@key) → convert to positional (?)
      _toPositional(s, obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { sql: s, params: obj || [] };
        const params = [];
        const converted = s.replace(/@(\w+)/g, (_, key) => {
          params.push(obj[key] !== undefined ? obj[key] : null);
          return '?';
        });
        return { sql: converted, params };
      },

      all(...args) {
        const arg = args[0];
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const { sql: s, params } = this._toPositional(trimmed, arg);
          return execQuery(s, params);
        }
        return execQuery(trimmed, args.length ? (Array.isArray(args[0]) ? args[0] : args) : []);
      },

      get(...args) {
        const arg = args[0];
        let rows;
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const { sql: s, params } = this._toPositional(trimmed, arg);
          rows = execQuery(s, params);
        } else {
          rows = execQuery(trimmed, args.length ? (Array.isArray(args[0]) ? args[0] : args) : []);
        }
        return rows[0] || null;
      },

      run(...args) {
        const arg = args[0];
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          const { sql: s, params } = this._toPositional(trimmed, arg);
          execRun(s, params);
        } else {
          execRun(trimmed, args.length ? (Array.isArray(args[0]) ? args[0] : args) : []);
        }
        return { changes: 1 };
      }
    };
  },

  exec(sql) {
    if (!_sqlDb) return;
    try { _sqlDb.run(sql); saveDB(); } catch (e) { /* table exists */ }
  },

  pragma() {},  // no-op for compatibility
  close() { saveDB(); },
  transaction(fn) { return (...args) => { fn(...args); saveDB(); }; },
};

// ── Async init — starts immediately ──────────────────────────
(async () => {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
      const buf = fs.readFileSync(DB_PATH);
      _sqlDb = new SQL.Database(buf);
      console.log('[DB] ✅ Loaded existing database from disk');
    } else {
      _sqlDb = new SQL.Database();
      console.log('[DB] ✅ Created new database');
    }

    // Apply schema
    _sqlDb.run(SCHEMA);
    // Legacy DBs: add lat/lng if missing (no-op if already present)
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN lat REAL DEFAULT 0'); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN lng REAL DEFAULT 0'); } catch (e) { /* exists */ }
    // Backward compatibility for Smart Wristband + alert metadata
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN wristband_battery INTEGER DEFAULT 100'); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN helmet_status TEXT DEFAULT \'offline\''); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN wristband_status TEXT DEFAULT \'offline\''); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN shift TEXT DEFAULT \'A\''); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE workers ADD COLUMN flammable_gas REAL DEFAULT 0'); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE telemetry ADD COLUMN flammable_gas REAL DEFAULT 0'); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE alerts ADD COLUMN type TEXT DEFAULT \'\''); } catch (e) { /* exists */ }
    try { _sqlDb.run('ALTER TABLE alerts ADD COLUMN priority TEXT DEFAULT \'warning\''); } catch (e) { /* exists */ }
    // Devices table is created with IF NOT EXISTS; only ensure schema doesn't crash on re-run.
    try { _sqlDb.run(SCHEMA); } catch (e) { /* ignore */ }
    try {
      _sqlDb.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name TEXT DEFAULT '',
        role TEXT DEFAULT 'operator',
        created_at TEXT
      )`);
    } catch (e) { /* exists */ }
    saveDB();
    _ready = true;
    console.log('[DB] ✅ Schema ready — SafeMine DB online');
    _resolveReady();

  } catch (e) {
    console.error('[DB] ❌ FATAL: Could not initialize database:', e.message);
    console.error('[DB] Make sure sql.js is installed: npm install sql.js');
    _rejectReady(e);
  }
})();

db.ready = ready;

module.exports = db;
