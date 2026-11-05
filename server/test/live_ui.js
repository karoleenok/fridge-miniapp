// Живой интерфейс на настоящем сервере: фото и ник, срок от производства, новости, «Для владельца». Запуск: node --no-warnings test/live_ui.js
'use strict';
const http = require('node:http'), crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const TOKEN = '123456:TEST-token_abc', KEY = 'k1', PORT = 18084, OWNER = 101;
const sent = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const m = req.url.match(/^\/bot[^/]+\/(\w+)$/), body = b ? JSON.parse(b) : {};
    const ok = (r) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: r })); };
    if (m[1] === 'getMe') return ok({ username: 'friidge_bot' });
    if (m[1] === 'getUpdates') return setTimeout(() => ok([]), 300);
    sent.push({ method: m[1], ...body }); ok({ message_id: 1 });
  });
});
const initData = (user) => { const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'Q', user: JSON.stringify(user) });
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  p.set('hash', crypto.createHmac('sha256', crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(dcs).digest('hex')); return p.toString(); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (t) => console.log('  ✓ ' + String(++n).padStart(2) + ' ' + t);
(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dbFile = path.join(__dirname, 'live_ui.db'); for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, BOT_TOKEN: TOKEN, DB_FILE: dbFile, PORT: String(PORT), PUBLIC_URL: 'http://127.0.0.1:' + PORT, MODE: 'polling', OWNER_ID: String(OWNER), TG_API_ROOT: 'http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: KEY }, stdio: 'ignore' });
  process.on('exit', () => { try { srv.kill(); } catch (e) {} });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch (e) {} await wait(150); }
  const api = (u, method, p, body) => fetch(`http://127.0.0.1:${PORT}/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-init-data': initData(u) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const K = { id: OWNER, first_name: 'Каролина', allows_write_to_pm: true }, M = { id: 202, first_name: 'Маша', allows_write_to_pm: true };
  await api(K, 'POST', '/consent'); await api(M, 'POST', '/consent');
  const inv = await api(K, 'POST', '/invite');
  // Маша входит по ссылке прямо в базе: используем бота-обработчик через ядро нельзя, поэтому через getUpdates не получится; вступаем напрямую
  const { open } = require('../src/db'); const C = require('../src/core');
  const db = open(dbFile); C.joinByToken(db, 202, inv.token); db.close();

  const browser = await chromium.launch(fs.existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] } : {});
  const open1 = async (user, w = 360) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: 740 } });
    await ctx.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.Telegram={WebApp:{initData:${JSON.stringify(initData(user))},ready(){},expand(){},setHeaderColor(){},setBackgroundColor(){},openTelegramLink(){},openLink(){}}};` }));
    await ctx.route('https://fonts.**', (r) => r.abort());
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
    await pg.goto(`http://127.0.0.1:${PORT}/`); await pg.waitForSelector('#main:not([hidden]), #ob1:not([hidden])', { timeout: 8000 });
    return { pg, errs, ctx };
  };
  const { pg, errs } = await open1(K);
  if (await pg.locator('#ob1:not([hidden])').count()) { await pg.click('[data-act=ob-next]'); await pg.click('[data-act=ob-back]'); await pg.evaluate(() => 0); }
  // пропускаем онбординг через API
  await api(K, 'POST', '/onboarded'); await api(K, 'POST', '/products', { items: [{ name: 'Молоко', e: '🥛', c: 'dairy', exp: '2030-01-01', q: 1, u: 'л' }] });
  await pg.reload(); await pg.waitForSelector('#main:not([hidden])'); await pg.waitForTimeout(400);
  const badge = await pg.locator('#tab-products .nbadge').innerText(); assert.ok(Number(badge) >= 3); ok('в живом режиме у колокольчика есть непрочитанные новости (' + badge + ')');
  await pg.click('#tab-products .bell'); await pg.waitForTimeout(250); await pg.click('#sheet [data-act=close-sheet]'); await pg.waitForTimeout(500);
  const rd = (await api(K, 'GET', '/state')).me.newsRead; assert.equal(rd.length, Number(badge)); ok('прочитанные новости ушли на сервер');
  await pg.click('[data-tab=family]'); await pg.waitForTimeout(200);
  assert.ok(await pg.evaluate("!document.querySelector('#adminEntry').hidden")); ok('владельцу видна карточка «Для владельца»');
  // профиль Маши от имени владельца: ник и фото
  await pg.click('.mem:has-text("Маша")'); await pg.waitForTimeout(300);
  const png = await pg.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d'); x.fillStyle = '#E85'; x.fillRect(0, 0, 800, 600); return c.toDataURL('image/png').split(',')[1]; });
  await pg.setInputFiles('#pfFile', { name: 'm.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await pg.waitForTimeout(500);
  await pg.fill('#pfNick', 'Мама'); await pg.click('[data-act=pf-save]'); await pg.waitForTimeout(1200);
  let st = await api(K, 'GET', '/state'); const mm = st.members.find((x) => x.id === 202); assert.equal(mm.name, 'Мама'); assert.equal(mm.photoV, 1); ok('ник и фото сохранились на сервере');
  await pg.waitForSelector('.mem:has-text("Мама") .av img', { timeout: 5000 }); ok('фото подгрузилось и видно в списке семьи');
  const ph = await api(K, 'GET', '/members/202/photo'); assert.ok(ph.photo.startsWith('data:image/jpeg;base64,')); assert.ok(ph.photo.length < 150000); ok('на сервере лежит JPEG меньше 110 КБ');
  // Маша видит себя и не может править чужих
  const m2 = await open1(M); if (await m2.pg.locator('#ob1:not([hidden])').count()) { await api(M, 'POST', '/onboarded'); await m2.pg.reload(); await m2.pg.waitForSelector('#main:not([hidden])'); }
  await m2.pg.click('[data-tab=family]'); await m2.pg.waitForTimeout(500);
  assert.ok(await m2.pg.evaluate("document.querySelector('#adminEntry').hidden")); ok('у участника нет «Для владельца»');
  assert.equal(await m2.pg.locator('.mem:not([disabled])').count(), 1); ok('участник может открыть только свой профиль');
  await m2.pg.waitForSelector('.mem:has-text("это вы") .av img', { timeout: 5000 }); ok('свою фотографию участник видит');
  // срок от производства
  await pg.click('[data-tab=products]'); await pg.click('[data-act=open-add]'); await pg.waitForTimeout(300);
  await pg.fill('#fName', 'Кефир'); await pg.click('[data-act=fmode][data-m=made]'); await pg.click('[data-act=fshelf][data-n="14"][data-u="д"]'); await pg.click('[data-act=form-save]'); await pg.waitForTimeout(900);
  st = await api(K, 'GET', '/state'); const kf = st.products.find((x) => x.name === 'Кефир'); assert.equal(kf.sn, 14); assert.equal(kf.su, 'д'); assert.ok(kf.made); ok('продукт от производства сохранился на сервере');
  // «Для владельца» в браузере
  await pg.click('[data-tab=family]'); await pg.click('[data-act=admin-open]'); await pg.waitForTimeout(500);
  assert.match(await pg.innerText('#adminBody'), /пришли и согласились/); await pg.fill('#noteNew', 'проверка из приложения'); await pg.click('[data-act=note-add]'); await pg.waitForTimeout(600);
  assert.equal((await api(K, 'GET', '/admin')).notes[0].text, 'проверка из приложения'); ok('заметка из приложения попала на сервер');
  const w = await pg.evaluate("(()=>{const b=document.querySelector('#adminBody');return b.scrollWidth<=b.clientWidth})()"); assert.ok(w); ok('«Для владельца» без горизонтального скролла');
  await pg.screenshot({ path: path.join(__dirname, 'shots', 'live_admin.png') });
  assert.deepEqual(errs, []); ok('ошибок JS нет');
  console.log('\nВсе ' + n + ' проверок прошли'); srv.kill(); await browser.close(); process.exit(0);
})().catch((e) => { console.error('✗', e); process.exit(1); });
