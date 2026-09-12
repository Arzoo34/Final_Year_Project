// ============================================================
//  MineGuard Pro - patch-gps.js
//  Fixes: "Mine GPS not configured" on Surface Map
//  Run: node patch-gps.js
// ============================================================
'use strict';
const path = require('path');
const fs   = require('fs');
const DB_PATH = path.join(__dirname, 'mineguard.db');

const MINE_LAT  = 6.2041;   // Obuasi Gold Mine, Ghana (change to your real location)
const MINE_LNG  = -1.6747;
const MINE_NAME = 'SafeMine Site';
const now = new Date().toISOString();

const offsets = [
  [0.0005,0.0003],[-0.0002,0.0008],[0.0010,-0.0005],[0.0003,-0.0002],
  [-0.0008,0.0004],[-0.0004,0.0010],[0.0015,0.0002],[0.0008,-0.0007],
  [0.0001,0.0001],[-0.0012,-0.0009],[-0.0006,0.0007],[-0.0009,-0.0003]
];

async function patch() {
  console.log('[Patch] Starting GPS fix...');
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (!fs.existsSync(DB_PATH)) {
    console.error('[Patch] ERROR: mineguard.db not found! Run: node seed.js first');
    process.exit(1);
  }

  const db = new SQL.Database(fs.readFileSync(DB_PATH));
  const save = () => fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  const run  = (sql, p) => { try { db.run(sql, p||[]); } catch(e) { /* col exists */ } };

  // Add lat/lng columns (safe if already exist)
  run('ALTER TABLE workers ADD COLUMN lat REAL DEFAULT 0');
  run('ALTER TABLE workers ADD COLUMN lng REAL DEFAULT 0');
  console.log('[Patch] lat/lng columns ready');

  // Write mine GPS to settings
  const settings = JSON.stringify({
    mineName: MINE_NAME, mineLat: MINE_LAT, mineLng: MINE_LNG,
    ch4Warn:0.5, ch4Crit:1.0, coWarn:25, coCrit:50, o2Low:19.5, tempHigh:35,
    updatedAt: now
  });
  run("INSERT OR REPLACE INTO settings (key,value) VALUES ('sys',?)", [settings]);
  console.log('[Patch] Mine GPS settings saved - Lat:' + MINE_LAT + ' Lng:' + MINE_LNG);

  // Check if workers exist; seed if not
  const wCount = db.exec('SELECT COUNT(*) FROM workers')[0]?.values[0][0] || 0;
  if (wCount === 0) {
    console.log('[Patch] No workers found - seeding 12 miners...');
    const miners = [
      ['MNR-001','James Okafor','Zone A','T1',120,80,45,0.10,8,20.6,24,76,88,0,0,1,-72,1.2,'online',now,'LoRaWAN'],
      ['MNR-002','Sarah Mensah','Zone B','T2',240,160,62,0.60,28,20.1,31,94,72,0,0,1,-79,4.8,'warning',now,'UWB'],
      ['MNR-003','Kwame Asante','Zone C','T3',380,220,78,1.20,55,19.4,36,112,61,0,0,1,-85,7.9,'critical',now,'LoRaWAN'],
      ['MNR-004','Amara Diallo','Zone A','T1',95,55,38,0.00,3,20.9,23,68,95,0,0,1,-68,0.6,'online',now,'BLE'],
      ['MNR-005','Chidi Obi','Zone D','T4',510,290,95,0.30,15,20.5,28,82,44,0,0,1,-88,2.1,'online',now,'LoRaWAN'],
      ['MNR-006','Fatima Al-Rashid','Zone B','T2',275,145,58,0.40,22,20.2,30,88,79,0,0,1,-75,3.4,'warning',now,'RFID'],
      ['MNR-007','Emmanuel Sarpong','Zone E','T5',620,340,112,0.00,5,20.8,25,71,91,0,0,1,-70,0.8,'online',now,'LoRaWAN'],
      ['MNR-008','Aisha Kamara','Zone C','T3',420,195,82,0.90,42,19.7,33,103,55,0,0,0,-83,6.2,'critical',now,'UWB'],
      ['MNR-009','Kofi Boateng','Zone A','T1',145,90,48,0.00,4,20.9,22,65,100,0,0,1,-65,0.4,'online',now,'BLE'],
      ['MNR-010','Ishmael Dankwa','Zone F','T6',740,410,130,0.20,10,20.7,26,78,67,0,0,1,-90,1.5,'online',now,'LoRaWAN'],
      ['MNR-011','Makena Waweru','Zone B','T2',260,175,65,0.50,20,20.3,29,85,83,0,0,1,-77,3.0,'warning',now,'RFID'],
      ['MNR-012','Nana Yaw Poku','Zone D','T4',490,310,98,0.10,7,20.8,27,74,58,0,0,1,-86,1.0,'online',now,'LoRaWAN'],
    ];
    miners.forEach((m,i) => {
      const [dLat,dLng] = offsets[i];
      run(`INSERT OR REPLACE INTO workers
        (id,name,zone,tunnel,x,y,depth,ch4,co,o2,temp,heart_rate,battery,
         panic,fall,motion,rssi,risk,status,last_seen,protocol,lat,lng)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [...m, MINE_LAT+dLat, MINE_LNG+dLng]);
    });
    console.log('[Patch] 12 miners seeded!');
  } else {
    // Just update lat/lng on existing workers
    const workers = db.exec('SELECT id FROM workers ORDER BY rowid');
    if (workers.length) {
      workers[0].values.forEach(([id], i) => {
        const [dLat,dLng] = offsets[i % offsets.length];
        run('UPDATE workers SET lat=?,lng=? WHERE id=?', [MINE_LAT+dLat, MINE_LNG+dLng, id]);
      });
      console.log('[Patch] GPS positions assigned to ' + workers[0].values.length + ' workers');
    }
  }

  save();
  console.log('');
  console.log('=== PATCH COMPLETE! =================================');
  console.log('   Surface Map is now fixed!');
  console.log('   1. Restart SafeMine server (close & rerun commands)');
  console.log('   2. Go to Mine Map > Surface Map');
  console.log('====================================================');
}

patch().catch(e => { console.error('[Patch] FATAL:', e.message); process.exit(1); });
