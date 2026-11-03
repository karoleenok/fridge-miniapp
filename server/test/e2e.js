// Сквозная проверка: настоящий сервер + поддельный Telegram-мост + мини-апп в Chromium.
// Запуск: node test/e2e.js  (нужен playwright; скриншоты кладутся в test/shots)
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const TOKEN = '123456:TEST-token_abc', RELAY_KEY = 'k1', PORT = 18081;
const sent = []; let queue = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.headers['x-relay-key'] !== RELAY_KEY) { res.writeHead(403); return res.end(); }
    const m = req.url.match(/^\/bot[^/]+\/(\w+)$/), body = b ? JSON.parse(b) : {};
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
    if (m[1] === 'getMe') return ok({ username: 'friidge_bot' });
    if (m[1] === 'sendMessage') { sent.push(body); return ok({ message_id: sent.length }); }
    if (m[1] === 'getUpdates') { const u = queue; queue = []; return setTimeout(() => ok(u), u.length ? 0 : 300); }
    ok(true);
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
async function until(fn, ms = 15000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await wait(200); } throw new Error('timeout'); }

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dbFile = path.join(__dirname, 'e2e.db'); for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, BOT_TOKEN: TOKEN, DB_FILE: dbFile, PORT: String(PORT), PUBLIC_URL: 'http://127.0.0.1:' + PORT, MODE: 'polling',
      TG_API_ROOT: 'http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: RELAY_KEY }, stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => { try { srv.kill(); } catch (e) {} });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch (e) { return false; } });

  const shots = path.join(__dirname, 'shots'); fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const KAROLINA = { id: 101, first_name: 'Каролина', allows_write_to_pm: false };
  await ctx.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body:
    `window.__opened=[];window.Telegram={WebApp:{initData:${JSON.stringify(initData(KAROLINA))},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},` +
    `openTelegramLink(u){window.__opened.push(u)},openLink(u){window.__opened.push(u)},requestWriteAccess(cb){window.__wa=1;cb(true)}}};` }));
  await ctx.route('https://fonts.**', (r) => r.abort());
  const pg = await ctx.newPage();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  let n = 0; const ok = async (name, shot) => { console.log('  ✓', ++n, name); if (shot) await pg.screenshot({ path: path.join(shots, shot + '.png') }); };
  const URL = `http://127.0.0.1:${PORT}/`;

  await pg.goto(URL);
  await pg.waitForSelector('[data-act=live-agree]');
  await ok('экран согласия', 'e1-consent');
  await pg.click('[data-act=live-agree]');
  await pg.waitForSelector('#ob1:not([hidden])');
  assert.equal(await pg.evaluate('window.__wa'), 1); await ok('после согласия просим разрешение писать и ведём в знакомство', 'e2-ob1');
  await pg.click('[data-act=ob-next]');
  for (const nm of ['Молоко', 'Яйца', 'Сыр']) await pg.click(`[data-n="${nm}"]`);
  await pg.click('#revCta');
  await pg.waitForSelector('#main:not([hidden])');
  await until(async () => (await (await fetch(URL + 'health')).json()) && (await pg.evaluate('__fridge.state().products.every(function(p){return p.id<1e9})')));
  await ok('ревизия сохранена на сервере', 'e3-main');
  await pg.click('[data-act=open-dates]');
  const ids = await pg.$$eval('#dList [data-act=dcustom]', (e) => e.map((x) => x.dataset.id));
  await pg.click(`#dList [data-act=dset][data-id="${ids[0]}"][data-d="7"]`);
  await pg.click(`#dList [data-act=dcustom][data-id="${ids[1]}"]`);
  await pg.fill(`#dd${ids[1]}`, '2026-12-31');
  await pg.click('#dDone');
  await wait(800);
  await pg.reload(); await pg.waitForSelector('#main:not([hidden])');
  const exps = await pg.evaluate('__fridge.state().products.map(function(p){return p.exp})');
  assert.equal(exps.filter(Boolean).length, 2); assert.ok(exps.includes('2026-12-31')); await ok('сроки и точная дата пережили перезагрузку', 'e4-reload');

  // приглашение
  await pg.click('.nav [data-tab=family]');
  await pg.click('[data-act=invite-share]');
  const shared = await until(() => pg.evaluate('window.__opened.filter(function(u){return u.indexOf("t.me/share")>-1})[0]'));
  const link = decodeURIComponent(shared.split('url=')[1].split('&')[0]);
  assert.match(link, /^https:\/\/t\.me\/friidge_bot\?start=inv_[\w-]+$/); await ok('«Пригласить» открывает выбор чата со ссылкой на бота', 'e5-family');
  const token = link.split('inv_')[1];
  const MASHA = { id: 202, first_name: 'Маша' };
  queue.push({ update_id: 10, message: { chat: { id: 202, type: 'private' }, from: MASHA, text: '/start inv_' + token } });
  await until(() => sent.find((m) => m.chat_id === 202 && m.reply_markup && JSON.stringify(m.reply_markup).includes('agree:inv_')));
  queue.push({ update_id: 11, callback_query: { id: 'c1', from: MASHA, data: 'agree:inv_' + token } });
  await until(() => sent.find((m) => m.chat_id === 202 && /общем холодильнике/.test(m.text)));
  await ok('Маша прошла согласие в боте и вошла по ссылке');
  await pg.evaluate('__fridge.loadLive(false,true)'); await wait(600);
  assert.equal(await pg.evaluate('__fridge.state().members.length'), 2); await ok('Маша появилась в семье у Каролины', 'e6-members');

  // просьба купить
  await pg.click('.nav [data-tab=buy]');
  await pg.click('[data-act=ask-open]');
  await pg.click('[data-act=ask-pick][data-n="Молоко"]');
  await pg.fill('#askNote', 'С зелёной крышкой');
  await pg.screenshot({ path: path.join(shots, 'e7-ask.png') });
  await pg.click('#askSend');
  const msg = await until(() => sent.find((m) => m.chat_id === 202 && /просит вас купить/.test(m.text)), 12000);
  assert.match(msg.text, /Каролина просит вас купить:\nМолоко — 1 л\n💬 С зелёной крышкой/); await ok('просьба ушла Маше через бота', 'e8-sent');
  queue.push({ update_id: 12, callback_query: { id: 'c2', from: MASHA, data: msg.reply_markup.inline_keyboard[0][0].callback_data, message: { chat: { id: 202 }, message_id: 5 } } });
  await until(() => sent.find((m) => m.chat_id === 101 && /Маша купил\(а\): Молоко/.test(m.text)), 12000);
  await pg.evaluate('__fridge.loadLive(false,true)'); await wait(600);
  assert.equal(await pg.evaluate('__fridge.state().asks[0].done'), true); await ok('Маша нажала «Куплено» в Telegram, у Каролины отметилось', 'e9-done');

  // удаление продукта и отмена
  await pg.click('.nav [data-tab=products]');
  const before = await pg.evaluate('__fridge.state().products.length');
  await pg.click('.row >> nth=0'); await pg.click('[data-act=eat]'); await wait(500);
  await pg.click('[data-act=toast-act]'); await wait(800);
  await pg.reload(); await pg.waitForSelector('#main:not([hidden])');
  assert.equal(await pg.evaluate('__fridge.state().products.length'), before); await ok('«Съели» → «Отменить» не теряет продукт');
  assert.equal(await pg.evaluate('document.documentElement.scrollWidth>document.documentElement.clientWidth'), false);
  assert.deepEqual(errs, []); await ok('без ошибок в консоли и горизонтального скролла');

  const bad = await (await fetch(URL + 'api/state', { headers: { 'x-init-data': 'user=%7B%22id%22%3A1%7D&hash=' + '0'.repeat(64) } })).status;
  assert.equal(bad, 401); await ok('поддельный вход отклонён');
  console.log(`\nВсе ${n} сквозных проверок прошли`);
  await browser.close(); srv.kill(); process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
