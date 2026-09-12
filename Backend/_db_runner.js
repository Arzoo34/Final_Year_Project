'use strict';
const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');

// Read input from a file (not argv, to avoid ENAMETOOLONG)
const inputFile = process.argv[2];
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const { dbPath, ops } = input;

initSqlJs().then(SQL => {
  let db;
  try {
    db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database();
  } catch(e) {
    fs.writeFileSync(inputFile + '.out', JSON.stringify({ error: 'open: ' + e.message }));
    process.exit(1);
  }

  const results = [];

  for (let i = 0; i < ops.length; i++) {
    const { mode, sql, params } = ops[i];
    try {
      if (mode === 'schema') {
        db.run(sql);
        results.push({ ok: true });
      } else if (mode === 'exec' || mode === 'run') {
        db.run(sql, params || []);
        results.push({ changes: db.getRowsModified() });
      } else if (mode === 'get') {
        const stmt = db.prepare(sql);
        if (params && params.length) stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        results.push(row);
      } else if (mode === 'all') {
        const stmt = db.prepare(sql);
        if (params && params.length) stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        results.push(rows);
      } else if (mode === 'begin')    { db.run('BEGIN');    results.push({ ok: true }); }
        else if (mode === 'commit')   { db.run('COMMIT');   results.push({ ok: true }); }
        else if (mode === 'rollback') { db.run('ROLLBACK'); results.push({ ok: true }); }
        else { results.push({ error: 'unknown mode: ' + mode }); }
    } catch(e) {
      results.push({ error: e.message });
    }
  }

  try {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  } catch(e) {
    fs.writeFileSync(inputFile + '.out', JSON.stringify({ error: 'save: ' + e.message }));
    process.exit(1);
  }
  db.close();
  fs.writeFileSync(inputFile + '.out', JSON.stringify({ results }));
  process.exit(0);
}).catch(e => {
  fs.writeFileSync(process.argv[2] + '.out', JSON.stringify({ error: 'init: ' + e.message }));
  process.exit(1);
});
