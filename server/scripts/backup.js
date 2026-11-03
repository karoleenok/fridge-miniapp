// Ежедневная копия базы: DATA/backup/fridge-ГГГГ-ММ-ДД.db, хранится 14 последних.
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.DB_FILE;
if (!file || !fs.existsSync(file)) { console.error('нет базы', file); process.exit(1); }
const dir = path.join(path.dirname(file), 'backup');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'fridge-' + new Date().toISOString().slice(0, 10) + '.db');
fs.rmSync(out, { force: true });
const db = new DatabaseSync(file);
db.prepare('VACUUM INTO ?').run(out);
db.close();
const all = fs.readdirSync(dir).filter((f) => /^fridge-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
for (const f of all.slice(0, Math.max(0, all.length - 14))) fs.rmSync(path.join(dir, f));
console.log('копия:', out);
