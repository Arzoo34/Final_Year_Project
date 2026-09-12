
'use strict';
const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');

const { dbPath, mode, sql, params } = JSON.parse(process.argv[2]);

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync(dbPath));
  let result = null;
  try {
    if (mode === 'exec') {
      db.run(sql);
      result = { ok: true };
    } else if (mode === 'run') {
      db.run(sql, params);
      result = { changes: db.getRowsModified() };
    } else if (mode === 'get') {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      result = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
    } else if (mode === 'all') {
      const stmt = db.prepare(sql);
      stmt.bind(params || []);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      result = rows;
    } else if (mode === 'begin') {
      db.run('BEGIN');
      result = { ok: true };
    } else if (mode === 'commit') {
      db.run('COMMIT');
      result = { ok: true };
    } else if (mode === 'rollback') {
      db.run('ROLLBACK');
      result = { ok: true };
    }
  } catch(e) {
    process.stdout.write(JSON.stringify({ error: e.message }));
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    process.exit(1);
  }
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  process.stdout.write(JSON.stringify({ result }));
  process.exit(0);
}).catch(e => {
  process.stderr.write(e.message + '\n');
  process.exit(1);
});
