'use strict';

const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'mineguard.db');

try {
  fs.unlinkSync(dbPath);
  console.log('[reset-db] Removed mineguard.db');
} catch (e) {
  if (e.code === 'ENOENT') {
    console.log('[reset-db] No existing mineguard.db');
  } else {
    console.error('[reset-db]', e.message);
    process.exit(1);
  }
}
