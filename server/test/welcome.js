// Сквозная проверка нового: владелец (рассылка, статистика, заметки), ник и фото, срок от производства — через настоящий сервер.
// Запуск: node --no-warnings test/owner.js
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const TOKEN = '123456:TEST-token_abc', KEY = 'k1', PORT = 18082, OWNER = 101;
const calls = []; let queue = [], uid = 1;
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.headers['x-relay-key'] !== KEY) { res.writeHead(403); return res.end(); }
    const m = req.url.match(/^\/bot[^/]+\/(\w+)$/), body = b ? JSON.parse(b) : {};
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (m[1] === 'getMe') return ok({ username: 'friidge_bot' });
    if (m[1] === 'getUpdates') { const u = queue; queue = []; return setTimeout(() => ok(u), u.length ? 0 : 200); }
    calls.push({ method: m[1], ...body });
    ok({ message_id: calls.length });
  });
});
function initData(user) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'Q', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(150); } throw new Error('timeout: ' + fn); }
const U = (id, name) => ({ id, first_name: name, allows_write_to_pm: true });
const api = async (user, method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-init-data': initData(user) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json().catch(() => ({})) };
};
const say = (from, text, extra = {}) => queue.push({ update_id: ++uid + 1000, message: { message_id: uid, chat: { id: from, type: 'private' }, from: { id: from, first_name: 'X' }, text, ...extra } });
const press = (from, data, mid = 5) => queue.push({ update_id: ++uid + 1000, callback_query: { id: 'cb' + uid, from: { id: from, first_name: 'X' }, data, message: { message_id: mid, chat: { id: from } } } });
let n = 0; const ok = (t) => console.log('  ✓ ' + String(++n).padStart(2) + ' ' + t);
const findCall = (pred) => calls.find(pred);

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dbFile = path.join(__dirname, 'welcome.db'); for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, BOT_TOKEN: TOKEN, DB_FILE: dbFile, PORT: String(PORT + 1), PUBLIC_URL: 'http://127.0.0.1:' + (PORT + 1), MODE: 'polling', OWNER_ID: String(OWNER),
      TG_API_ROOT: 'http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => { try { srv.kill(); } catch (e) {} });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d)); process.on('exit', () => { if (process.exitCode) console.log(log.slice(-1500)); });
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT + 1}/health`)).ok; } catch (e) { return false; } });
  const P = PORT + 1;
  const api2 = async (user, method, p, body) => { const r = await fetch(`http://127.0.0.1:${P}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-init-data': initData(user) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const K = { id: OWNER, first_name: 'Каролина', username: 'karolenok', allows_write_to_pm: true };
  const M = { id: 202, first_name: 'Маша', username: 'masha_k', allows_write_to_pm: true };
  const B = { id: 404, first_name: 'Без ника', allows_write_to_pm: true };
  for (const u of [K, M]) assert.equal((await api2(u, 'POST', '/consent')).s, 200);
  await until(() => calls.some((c) => c.chat_id === OWNER && /Маша @masha_k\. Всего/.test(c.text || ''))); ok('владельцу пришло имя с @ником');

  say(OWNER, '/users'); const ul = await until(() => findCall((c) => c.chat_id === OWNER && /Присоединились: 2/.test(c.text || '')));
  assert.match(ul.text, /Маша @masha_k/); assert.match(ul.text, /Каролина @karolenok/); ok('/users: список с никами');
  say(202, '/users'); await wait(600); assert.ok(!calls.some((c) => c.chat_id === 202 && /Присоединились/.test(c.text || ''))); ok('/users у чужого молчит');

  // приветствие: собрать, посмотреть, сохранить
  say(OWNER, '/welcome'); await until(() => findCall((c) => c.chat_id === OWNER && /Приветствия пока нет/.test(c.text || ''))); ok('до настройки /welcome говорит, что приветствия нет');
  say(OWNER, '/welcome Привет! Это <b>Фридж</b>', { entities: [{ type: 'bold', offset: 21, length: 5 }] });
  await until(() => findCall((c) => c.chat_id === OWNER && /Черновик собран/.test(c.text || ''))); ok('черновик приветствия собран');
  press(OWNER, 'bc:show'); const chk = await until(() => findCall((c) => c.chat_id === OWNER && /Проверка приветствия/.test(c.text || '')));
  assert.ok(JSON.stringify(chk.reply_markup).includes('bc:wel:')); assert.ok(!JSON.stringify(chk.reply_markup).includes('bc:go')); ok('предпросмотр: кнопка «Сделать приветствием», рассылки нет');
  const pv = calls.filter((c) => c.chat_id === OWNER && /Привет! Это/.test(c.text || '')); assert.ok(pv.length); assert.ok(!/Не хочешь такие/.test(pv[0].text)); ok('в приветствии нет подписи про отписку');
  const wid = /bc:wel:(\d+)/.exec(JSON.stringify(chk.reply_markup))[1];
  press(OWNER, 'bc:wel:' + wid); await until(() => findCall((c) => c.chat_id === OWNER && /Приветствие сохранено/.test(c.text || ''))); ok('приветствие сохранено');
  assert.ok(!calls.some((c) => c.chat_id === 202 && /Привет! Это/.test(c.text || ''))); ok('уже присоединившимся ничего не ушло');

  // новичок получает приветствие один раз
  assert.equal((await api2(B, 'POST', '/consent')).s, 200);
  await until(() => calls.some((c) => c.chat_id === 404 && /Привет! Это/.test(c.text || ''))); ok('новичок получил приветствие после согласия');
  assert.equal((await api2(B, 'POST', '/consent')).s, 200); await wait(800);
  assert.equal(calls.filter((c) => c.chat_id === 404 && /Привет! Это/.test(c.text || '')).length, 1); ok('повторное согласие второго приветствия не шлёт');
  say(OWNER, '/users'); const ul2 = await until(() => calls.filter((c) => c.chat_id === OWNER && /Присоединились: 3/.test(c.text || '')).pop());
  assert.match(ul2.text, /Без ника \(ника нет\)/); ok('без ника в списке помечено');

  // выключить
  say(OWNER, '/welcome off'); await until(() => findCall((c) => /Приветствие выключено/.test(c.text || '')));
  assert.equal((await api2({ id: 505, first_name: 'Новый', allows_write_to_pm: true }, 'POST', '/consent')).s, 200); await wait(1000);
  assert.ok(!calls.some((c) => c.chat_id === 505 && /Привет! Это/.test(c.text || ''))); ok('после /welcome off новым ничего не приходит');
  console.log('\nВсе ' + n + ' проверок прошли'); srv.kill(); process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ', e); process.exit(1); });
