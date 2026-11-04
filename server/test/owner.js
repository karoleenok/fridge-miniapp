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
  const dbFile = path.join(__dirname, 'owner.db'); for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, BOT_TOKEN: TOKEN, DB_FILE: dbFile, PORT: String(PORT), PUBLIC_URL: 'http://127.0.0.1:' + PORT, MODE: 'polling', OWNER_ID: String(OWNER),
      TG_API_ROOT: 'http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => { try { srv.kill(); } catch (e) {} });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch (e) { return false; } });

  const K = U(OWNER, 'Каролина'), M = U(202, 'Маша'), A = U(303, 'Антон');
  for (const u of [K, M, A]) assert.equal((await api(u, 'POST', '/consent')).s, 200);
  ok('трое согласились');

  // владелец узнаёт о новых людях
  await until(() => calls.some((c) => c.method === 'sendMessage' && c.chat_id === OWNER && /Новый человек во Фридже: Маша/.test(c.text)));
  ok('владельцу пришло «новый человек»');
  assert.ok(!calls.some((c) => c.chat_id === OWNER && /Каролина\. Всего/.test(c.text || ''))); ok('о самом владельце сообщения нет');

  // /whoami всем, админка только владельцу
  say(202, '/whoami'); await until(() => findCall((c) => c.chat_id === 202 && /Telegram id: 202/.test(c.text)));
  ok('/whoami показывает id');
  say(202, '/stats'); await wait(600);
  assert.ok(!calls.some((c) => c.chat_id === 202 && /Статистика/.test(c.text || ''))); ok('/stats у чужого молчит');
  say(202, '/send Взлом'); await wait(600);
  assert.ok(!calls.some((c) => c.chat_id === 202 && /Черновик/.test(c.text || ''))); ok('/send у чужого не работает');
  assert.equal((await api(M, 'GET', '/admin')).s, 404); ok('API владельца для чужого даёт 404');
  assert.equal((await api(K, 'GET', '/state')).j.admin, true); assert.equal((await api(M, 'GET', '/state')).j.admin, false); ok('флаг admin только у владельца');

  // статистика
  say(OWNER, '/stats'); const st = await until(() => findCall((c) => c.chat_id === OWNER && /Статистика Фриджа/.test(c.text)));
  assert.match(st.text, /Пришли и дали согласие: 3/); ok('/stats показывает цифры');

  // заметки: бот <-> приложение
  say(OWNER, '/note купить фильтр'); await until(() => findCall((c) => /Записала заметку #1/.test(c.text || '')));
  const adm = await api(K, 'GET', '/admin'); assert.equal(adm.j.notes[0].text, 'купить фильтр'); ok('заметка из бота видна в приложении');
  assert.equal((await api(K, 'POST', '/admin/notes', { text: 'из приложения' })).s, 200);
  assert.equal((await api(K, 'PATCH', '/admin/notes/1', { text: 'купить два фильтра' })).s, 200);
  say(OWNER, '/notes'); const nl = await until(() => findCall((c) => /Заметки \(2\)/.test(c.text || '')));
  assert.match(nl.text, /из приложения/); assert.match(nl.text, /купить два фильтра/); ok('правка и новая заметка из приложения видны в боте');
  assert.ok(nl.reply_markup.inline_keyboard.length === 2); ok('у заметок есть кнопки правки и удаления');
  press(OWNER, 'nt:e:1'); await until(() => findCall((c) => /Сейчас в заметке #1/.test(c.text || '')));
  say(OWNER, 'купить три фильтра'); await until(() => findCall((c) => /Заметка #1 обновлена/.test(c.text || '')));
  assert.equal((await api(K, 'GET', '/admin')).j.notes.find((x) => x.id === 1).text, 'купить три фильтра'); ok('правка заметки из бота доходит до приложения');
  press(OWNER, 'nt:d:2'); press(OWNER, 'nt:y:2'); await until(() => findCall((c) => /Заметка #2 удалена/.test(c.text || '')));
  assert.equal((await api(K, 'GET', '/admin')).j.notes.length, 1); ok('удаление заметки из бота');

  // рассылка: /send → картинки → показать → отправить
  say(OWNER, '/send Привет всем! Тут новость', { entities: [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'bold', offset: 6, length: 6 }] });
  await until(() => findCall((c) => /Черновик собран/.test(c.text || '')));
  say(OWNER, '', { text: undefined, photo: [{ file_id: 'SMALL' }, { file_id: 'BIG1' }], media_group_id: 'g1' });
  say(OWNER, '', { text: undefined, photo: [{ file_id: 'SMALL' }, { file_id: 'BIG2' }], media_group_id: 'g1' });
  await wait(900);
  const drafts = calls.filter((c) => /Черновик собран/.test(c.text || '')); assert.equal(drafts.length, 2); ok('альбом из двух картинок даёт один ответ, а не два');
  press(OWNER, 'bc:show'); const chk = await until(() => findCall((c) => /Проверка перед отправкой/.test(c.text || '')));
  assert.match(chk.text, /Картинок: 2/); assert.match(chk.text, /Получат: 2 человека/); ok('проверка: текст, картинки и сколько получат');
  assert.ok(calls.some((c) => c.method === 'sendMediaGroup' && c.chat_id === OWNER)); ok('предпросмотр ушёл владельцу альбомом');
  db1 = null;
  press(OWNER, 'bc:go:1'); await until(() => calls.filter((c) => c.method === 'sendMediaGroup' && c.chat_id !== OWNER).length >= 2, 25000);
  const got = calls.filter((c) => c.method === 'sendMediaGroup' && c.chat_id !== OWNER);
  assert.deepEqual(got.map((c) => c.chat_id).sort(), [202, 303]); assert.equal(got[0].media.length, 2);
  assert.match(got[0].media[0].caption, /Привет всем/); assert.match(got[0].media[0].caption, /\/news/); assert.equal(got[0].media[0].caption_entities[0].type, 'bold'); ok('альбом дошёл двоим, подпись с форматированием и /news');
  await until(() => findCall((c) => c.chat_id === OWNER && /Рассылка закончена/.test(c.text || '')), 90000);
  assert.match(calls.filter((c) => /Рассылка закончена/.test(c.text || ''))[0].text, /2 из 2/); ok('владельцу пришёл отчёт «2 из 2»');

  // отказ от рассылки
  say(303, '/news'); await until(() => findCall((c) => c.chat_id === 303 && /Больше не буду присылать новости/.test(c.text)));
  say(OWNER, '/send Ещё раз'); await until(() => calls.filter((c) => /Черновик собран/.test(c.text || '')).length >= 3);
  press(OWNER, 'bc:show', 6); const chk2 = await until(() => calls.filter((c) => /Проверка перед отправкой/.test(c.text || '')).length >= 2 && calls.filter((c) => /Проверка перед отправкой/.test(c.text || '')).pop());
  assert.match(chk2.text, /Получат: 1 человек/); ok('отказавшийся от рассылки не попадает в получатели');
  press(OWNER, 'bc:no', 7); await until(() => calls.some((c) => /Черновик отменён/.test(c.text || ''))); ok('черновик можно отменить');

  // ник и фото через HTTP
  const inv = (await api(K, 'POST', '/invite')).j; const tokenStr = inv.token;
  say(202, '/start inv_' + tokenStr); await until(async () => (await api(M, 'GET', '/state')).j.members.length === 2);
  const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80000, 7), Buffer.from([0xff, 0xd9])]).toString('base64');
  assert.equal((await api(M, 'PUT', '/members/202/photo', { photo: jpeg })).s, 200); ok('фото 80 КБ проходит (лимит больше, чем у обычных запросов)');
  const big = await api(M, 'PUT', '/members/202/photo', { photo: 'data:image/jpeg;base64,' + 'A'.repeat(300000) }).catch(() => ({ s: 'reset' }));
  assert.ok(big.s === 413 || big.s === 'reset'); ok('слишком большое тело отклонено (413 или обрыв)');
  assert.equal((await api(M, 'PATCH', '/members/202', { nick: 'Мамуля' })).s, 200);
  assert.equal((await api(M, 'PATCH', '/members/101', { nick: 'Босс' })).s, 403); ok('участник не меняет ник владельца');
  assert.equal((await api(K, 'PATCH', '/members/202', { nick: 'Мама' })).s, 200); ok('владелец правит ник участника');
  const s1 = (await api(K, 'GET', '/state')).j; const mm = s1.members.find((x) => x.id === 202);
  assert.equal(mm.name, 'Мама'); assert.equal(mm.photoV, 1); ok('в состоянии ник и версия фото');
  assert.equal((await api(K, 'GET', '/members/202/photo')).j.photo, jpeg); ok('фото отдаётся семье');
  assert.equal((await api(A, 'GET', '/members/202/photo')).s, 404); ok('фото не отдаётся чужому');
  await api(K, 'PATCH', '/members/202', { nick: 'Мама' });
  assert.equal((await api(M, 'POST', '/asks', { to: [101], name: 'Хлеб', q: 1, u: 'шт', note: '' })).s, 200);
  await until(() => findCall((c) => c.chat_id === 101 && /^Мама просит вас купить/.test(c.text || ''))); ok('в сообщении бота стоит ник «Мама»');

  // срок от производства через API
  const today = new Date().toISOString().slice(0, 10);
  const r = await api(K, 'POST', '/products', { items: [{ name: 'Йогурт', e: '🥛', c: 'dairy', made: today, sn: 3, su: 'нед', exp: '2000-01-01', q: 1, u: 'шт' }] });
  const pr = (await api(K, 'GET', '/state')).j.products[0]; assert.equal(pr.sn, 3); assert.equal(pr.su, 'нед'); assert.equal(pr.made, today);
  assert.equal(new Date(Date.parse(today) + 21 * 86400000).toISOString().slice(0, 10), pr.exp); ok('сервер посчитал «годен до» = производство + 3 недели');
  assert.equal((await api(K, 'POST', '/news-read', { ids: ['n-bell'] })).s, 200);
  assert.deepEqual((await api(K, 'GET', '/state')).j.me.newsRead, ['n-bell']); ok('прочитанные новости хранятся на сервере');

  console.log('\nВсе ' + n + ' проверок прошли'); srv.kill(); process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
let db1;
