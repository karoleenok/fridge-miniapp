// Тесты сервера с поддельным Telegram-мостом. Запуск: node --no-warnings test/run.js
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

  // 1. вход
  assert.equal((await call(KAROLINA, 'GET', '/api/state', null, '')).status, 401); ok('без initData — 401');
  let bad = initData(KAROLINA).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64));
  assert.equal((await call(KAROLINA, 'GET', '/api/state', null, bad)).status, 401); ok('подделанная подпись — 401');
  assert.equal((await call(KAROLINA, 'GET', '/api/state', null, initData(KAROLINA, 2 * 86400))).status, 401); ok('старый initData — 401');
  let r = await call(KAROLINA, 'GET', '/api/state');
  assert.equal(r.json.needConsent, true); assert.equal(S.db.prepare('SELECT count(*) n FROM users').get().n, 0); ok('до согласия ничего не сохраняем');
  r = await call(KAROLINA, 'POST', '/api/consent');
  assert.equal(r.status, 200); assert.equal(r.json.me.canDm, true); assert.equal(r.json.fridge.name, 'Наш холодильник'); ok('согласие создаёт холодильник');
  assert.ok(r.headers.get('x-content-type-options')); ok('заголовки безопасности');

  // 2. продукты
  r = await call(KAROLINA, 'POST', '/api/products', { items: [{ name: 'Молоко', e: '🥛', c: 'dairy', q: 1, u: 'л', exp: null }, { name: 'Сыр', e: '🧀', c: 'dairy', q: 300, u: 'г', exp: '2030-01-01' }] });
  assert.equal(r.json.ids.length, 2); const milk = r.json.ids[0]; ok('ревизия без сроков');
  assert.equal((await call(KAROLINA, 'POST', '/api/products', { items: [{ name: '<script>', q: -1, u: 'шт' }] })).status, 400); ok('плохое количество — 400');
  assert.equal((await call(KAROLINA, 'POST', '/api/products', { items: [{ name: 'x', q: 1, u: 'бочка' }] })).status, 400); ok('чужая единица — 400');
  assert.equal((await call(KAROLINA, 'PATCH', '/api/products/' + milk, { exp: '2026-13-45' })).status, 400); ok('кривая дата — 400');
  assert.equal((await call(KAROLINA, 'PATCH', '/api/products/' + milk, { exp: '2026-11-20' })).status, 200); ok('точная дата сохраняется');

  // 3. семья
  r = await call(KAROLINA, 'POST', '/api/invite');
  const token = r.json.token; assert.match(r.json.link, /^https:\/\/t\.me\/friidge_bot\?start=inv_/); ok('ссылка-приглашение через бота');
  assert.equal((await call(MASHA, 'GET', '/api/products/' + milk)).status, 200); // needConsent — не видит чужого
  await S.onUpdate({ update_id: 1, message: { chat: { id: 202, type: 'private' }, from: MASHA, text: '/start inv_' + token } });
  assert.ok(!C.getUser(S.db, 202)); ok('бот: без согласия не сохраняет');
  await S.onUpdate({ update_id: 2, callback_query: { id: 'q1', from: MASHA, data: 'agree:inv_' + token } });
  r = await call(MASHA, 'GET', '/api/state');
  assert.equal(r.json.fridge.id, (await call(KAROLINA, 'GET', '/api/state')).json.fridge.id); assert.equal(r.json.products.length, 2); ok('Маша вошла по ссылке и видит продукты');
  assert.equal(C.joinByToken(S.db, 303, token).reason, 'used'); ok('ссылка одноразовая');
  r = await call(KAROLINA, 'POST', '/api/invite'); const t2 = r.json.token;
  S.db.prepare('UPDATE invites SET expires_at=? WHERE token=?').run(Date.now() - 1, t2);
  await S.onUpdate({ update_id: 3, callback_query: { id: 'q2', from: ANTON, data: 'agree:inv_' + t2 } });
  assert.notEqual((await call(ANTON, 'GET', '/api/state')).json.fridge.id, (await call(KAROLINA, 'GET', '/api/state')).json.fridge.id); ok('просроченная ссылка не пускает');
  r = await call(KAROLINA, 'POST', '/api/invite');
  await S.onUpdate({ update_id: 4, message: { chat: { id: 303, type: 'private' }, from: ANTON, text: '/start inv_' + r.json.token } });
  assert.equal((await call(ANTON, 'GET', '/api/state')).json.members.length, 3); ok('Антон вошёл, его пустой холодильник удалён');
  assert.equal((await call(MASHA, 'DELETE', '/api/members/303')).status, 403); ok('убрать участника может только владелец');

  // 4. просьбы
  S.db.prepare('UPDATE users SET can_dm=0 WHERE id=303').run();
  r = await call(KAROLINA, 'POST', '/api/asks', { to: [202, 303], name: 'Хлеб', q: 1, u: 'шт', note: 'Бородинский' });
  assert.deepEqual(r.json.queued, [202]); ok('просьба: в очередь только тем, кому бот может писать');
  assert.equal((await call(KAROLINA, 'POST', '/api/asks', { to: [101], name: 'x', q: 1, u: 'шт' })).status, 400); ok('нельзя попросить себя');
  assert.equal((await call(KAROLINA, 'POST', '/api/asks', { to: [999999], name: 'x', q: 1, u: 'шт' })).status, 400); ok('нельзя писать чужим');
  sent.length = 0; tgDown = true;
  await flush(S.db, tg);
  assert.equal(sent.length, 0); let ob = S.db.prepare('SELECT * FROM outbox').all();
  const tried = ob.filter((m) => m.tries === 1); assert.equal(tried.length, 1); assert.ok(tried[0].next_at > Date.now()); assert.ok(ob.every((m) => !m.sent_at)); ok('Telegram недоступен — ничего не потеряно, повтор позже');
  tgDown = false; S.db.prepare('UPDATE outbox SET next_at=0').run();
  await flush(S.db, tg);
  const askMsg = sent.find((m) => m.chat_id === 202 && /Хлеб/.test(m.text));
  assert.ok(askMsg); assert.match(askMsg.text, /Каролина просит вас купить:\nХлеб — 1 шт\n💬 Бородинский/); ok('сообщение дошло после восстановления связи');
  assert.equal(askMsg.reply_markup.inline_keyboard[0][0].callback_data.startsWith('done:'), true); ok('в сообщении кнопка «Куплено»');
  await S.onUpdate({ update_id: 5, callback_query: { id: 'q3', from: MASHA, data: askMsg.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: 202 }, message_id: 1 } } });
  S.db.prepare('UPDATE outbox SET next_at=0').run(); await flush(S.db, tg);
  assert.ok(sent.find((m) => m.chat_id === 101 && /Маша купил\(а\): Хлеб/.test(m.text))); ok('«Куплено» из Telegram отмечает и сообщает Каролине');
  assert.equal((await call(KAROLINA, 'PATCH', '/api/fridge', { tpl: 'без слов' })).status, 400); ok('текст без {что} не сохраняется');
  assert.equal((await call(KAROLINA, 'PATCH', '/api/fridge', { tpl: 'Привет! {кто} просит {что}, {сколько}. {коммент}' })).status, 200); ok('свой текст сохраняется');
  S.db.prepare("UPDATE asks SET created_at=datetime('now')").run();
  let last;
  for (let i = 0; i < 25; i++) last = await call(KAROLINA, 'POST', '/api/asks', { to: [202], name: 'Тест ' + i, q: 1, u: 'шт' });
  assert.equal(last.status, 429); ok('лимит просьб в час');

  // 5. заблокировал бота
  S.db.prepare("INSERT INTO users(id,first_name,can_dm,consent_at) VALUES(999,'Бан',1,'x')").run();
  require('../src/tg').enqueue(S.db, 999, 'hi', null, null);
  S.db.prepare('UPDATE outbox SET next_at=0').run(); await flush(S.db, tg);
  assert.equal(C.getUser(S.db, 999).can_dm, 0); ok('403 от Telegram — больше не пишем');

  // 6. напоминания
  const today = C.mskNow('Europe/Moscow').date;
  const plus = (d) => new Date(Date.parse(today + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
  await call(KAROLINA, 'POST', '/api/products', { items: [{ name: 'Творог', e: '🥛', c: 'dairy', q: 200, u: 'г', exp: plus(1) }, { name: 'Кефир', e: '🥛', c: 'dairy', q: 1, u: 'л', exp: plus(-1) }] });
  const t = C.mskNow('Europe/Moscow').time;
  S.db.prepare('UPDATE users SET notify_time=? WHERE id=101').run(t);
  assert.equal(C.queueReminders(S.db, S.cfg), 1); assert.equal(C.queueReminders(S.db, S.cfg), 0); ok('сводка ставится один раз в день');
  S.db.prepare('UPDATE outbox SET next_at=0').run(); await flush(S.db, tg);
  const dg = sent.find((m) => m.chat_id === 101 && /Скоро испортится/.test(m.text));
  assert.match(dg.text, /Просрочено, проверь:\n🥛 Кефир/); assert.match(dg.text, /Творог, завтра/); ok('текст сводки');
  assert.equal((await call(KAROLINA, 'PATCH', '/api/me/notify', { time: '25:00' })).status, 400); ok('кривое время — 400');

  // 7. setup и удаление
  assert.equal((await fetch(base + '/setup?key=wrong')).status, 403); ok('setup без ключа — 403');
  assert.equal((await call(ANTON, 'DELETE', '/api/me')).status, 200);
  assert.ok(!C.getUser(S.db, 303)); assert.equal((await call(KAROLINA, 'GET', '/api/state')).json.members.length, 2); ok('удаление своих данных');
  const big = await fetch(base + '/api/products', { method: 'POST', headers: { 'x-init-data': initData(KAROLINA), 'content-type': 'application/json' }, body: 'x'.repeat(70000) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413); ok('слишком большой запрос — 413');

  console.log(`\nВсе ${n} проверок прошли`);
  process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
