// v1.3 по HTTP. Запуск: node --no-warnings test/v13_http.js
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const TOKEN = '123456:TEST-token_abc';
const RELAY_KEY = 'relaykey123';
const sent = []; let tgDown = false; let updates = [];

// поддельный мост: проверяет ключ и путь как настоящий relay.js
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.headers['x-relay-key'] !== RELAY_KEY) { res.writeHead(403); return res.end('forbidden'); }
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m || m[1] !== TOKEN) { res.writeHead(400); return res.end('bad path'); }
    const body = b ? JSON.parse(b) : {};
    if (tgDown) { res.writeHead(502); return res.end('down'); }
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (m[2] === 'sendMessage') {
      if (body.chat_id === 999) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })); }
      sent.push(body); return ok({ message_id: sent.length });
    }
    if (m[2] === 'getUpdates') { const u = updates; updates = []; return ok(u); }
    return ok(true);
  });
});

function initData(user, ageSec = 0, extra = {}) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - ageSec), query_id: 'AAA', user: JSON.stringify(user), ...extra });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return p.toString();
}

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    FRIDGE_TEST: '1', BOT_TOKEN: TOKEN, DB_FILE: ':memory:', PUBLIC_URL: 'https://fridge.example', MODE: 'polling',
    TG_API_ROOT: 'http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: RELAY_KEY, SETUP_KEY: 'setupkey', BOT_USERNAME: 'friidge_bot'
  });
  const S = require('../src/server.js');
  const { flush } = require('../src/tg');
  const C = require('../src/core');
  const tg = require('../src/tg').makeTg(S.cfg, () => {});
  await new Promise((r) => S.server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + S.server.address().port;
  const KAROLINA = { id: 101, first_name: 'Каролина', allows_write_to_pm: true };
  const MASHA = { id: 202, first_name: 'Маша' };
  const ANTON = { id: 303, first_name: 'Антон' };
  const call = async (user, method, path, body, raw) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-init-data': raw !== undefined ? raw : initData(user) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  };
  let n = 0; const ok = (name) => console.log('  ✓', ++n, name);

  // v1.3 по HTTP: маршруты, права и формат ответов
  await call(KAROLINA, 'POST', '/api/consent');
  let r = await call(KAROLINA, 'POST', '/api/cats', { id: 'ucat1', n: 'Для кота', e: '🐈', col: '#7C5CFF', mode: 'emoji' });
  assert.equal(r.status, 200); ok('POST /cats создаёт категорию');
  r = await call(KAROLINA, 'POST', '/api/cats', { id: 'NOPE', n: 'X', col: '#112233' });
  assert.equal(r.status, 400); ok('кривой id категории — 400');
  r = await call(KAROLINA, 'POST', '/api/products', { items: [{ name: 'Корм', c: 'ucat1', col: '#E86F51', fz: true, q: 1, u: 'шт', exp: '2027-02-01' }] });
  assert.equal(r.status, 200);
  r = await call(KAROLINA, 'GET', '/api/state');
  assert.equal(r.json.cats[0].id, 'ucat1'); assert.equal(r.json.products[0].c, 'ucat1'); assert.equal(r.json.products[0].fz, true); assert.equal(r.json.products[0].col, '#E86F51'); ok('состояние отдаёт cats, c, fz, col');
  const pid = r.json.products[0].id;
  r = await call(KAROLINA, 'PATCH', '/api/products/' + pid, { fz: false, exp: '2026-12-01' });
  assert.equal(r.status, 200); ok('PATCH /products: достать из морозилки');
  r = await call(KAROLINA, 'PATCH', '/api/cats/ucat1', { n: 'Коты' });
  assert.equal(r.status, 200); ok('PATCH /cats/:id переименовывает');
  r = await call(KAROLINA, 'PATCH', '/api/me/notify', { fzdays: 30 });
  assert.equal(r.status, 200); assert.equal((await call(KAROLINA, 'GET', '/api/state')).json.me.notify.fzdays, 30); ok('PATCH /me/notify: окно морозилки 30 дней');
  r = await call(KAROLINA, 'PATCH', '/api/me/notify', { fzdays: 5 });
  assert.equal(r.status, 400); ok('окно морозилки 5 дней отклонено');
  r = await call(KAROLINA, 'PUT', '/api/me/cols', { cols: ['#112233', '#AABBCC'] });
  assert.equal(r.status, 200); assert.deepEqual((await call(KAROLINA, 'GET', '/api/state')).json.me.myCols, ['#112233', '#AABBCC']); ok('PUT /me/cols сохраняет «Мои цвета»');
  r = await call(KAROLINA, 'POST', '/api/asks', { to: [], name: 'Яйца', q: 10, u: 'шт', note: '' });
  assert.equal(r.status, 200); ok('POST /asks без получателей — личный список, 200');
  assert.equal((await call(KAROLINA, 'GET', '/api/state')).json.asks.length, 1); ok('личная просьба видна в состоянии');
  await call(MASHA, 'POST', '/api/consent');
  r = await call(MASHA, 'PATCH', '/api/cats/ucat1', { n: 'Взлом' });
  assert.equal(r.status, 404); ok('чужая семья категорию не меняет (у неё её нет)');
  r = await call(KAROLINA, 'DELETE', '/api/cats/ucat1');
  assert.equal(r.status, 200); assert.equal((await call(KAROLINA, 'GET', '/api/state')).json.cats.length, 0); ok('DELETE /cats/:id');
  r = await call(KAROLINA, 'GET', '/api/state', null, '');
  assert.equal(r.status, 401); ok('без подписи Telegram всё по-прежнему закрыто');
  console.log(`\nВсе ${n} проверок прошли`);
  process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
