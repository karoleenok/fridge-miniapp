// v1.3 в живом интерфейсе. Запуск: node --no-warnings test/live_v13.js
'use strict';
const http = require('node:http'), crypto = require('node:crypto'), path = require('node:path'), fs = require('node:fs');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const TOKEN = '123456:TEST-token_abc', KEY = 'k1', PORT = 18086, OWNER = 101;
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
  const dbFile = path.join(__dirname, 'live_v13.db'); for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });
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
  await api(K, 'POST', '/onboarded');
  await api(K, 'POST', '/products', { items: [
    { name: 'Курица грудка', e: '🍗', c: 'meat', exp: '2026-11-08', q: 1, u: 'кг' },
    { name: 'Молоко', e: '🥛', c: 'dairy', exp: '2030-01-01', q: 1, u: 'л' }] });
  await pg.reload(); await pg.waitForSelector('#main:not([hidden])'); await pg.waitForTimeout(400);
  // заморозить: шторка, срок по справочнику, сохранение
  await pg.locator('.row:has-text("Курица грудка")').first().click(); await pg.waitForTimeout(250);
  await pg.click('[data-act=fz-toggle]'); await pg.waitForTimeout(250);
  assert.match(await pg.locator('#fzHint').innerText(), /USDA: 9 мес/); ok('для куриных кусков шторка предлагает 9 мес. по USDA');
  assert.equal(await pg.locator('#fzChips .chip[aria-pressed=true]').innerText(), '9 мес.'); ok('срок 9 мес. выбран заранее');
  await pg.click('[data-act=fz-do]'); await pg.waitForTimeout(900);
  let st = await api(K, 'GET', '/state');
  const ch = st.products.find((p) => p.name === 'Курица грудка');
  assert.equal(ch.fz, true); assert.ok(ch.exp > '2027-07-01' && ch.exp < '2027-09-01', ch.exp); ok('на сервере fz=true и срок около 9 месяцев');
  assert.ok(await pg.locator('#placeSw:not([hidden])').count()); ok('после первой заморозки появился переключатель «Холодильник / Морозилка»');
  await pg.click('[data-act=place][data-v=fz]'); await pg.waitForTimeout(250);
  assert.ok(await pg.locator('#hero.frost').count()); assert.match(await pg.locator('#hero').innerText(), /1\s*\n?\s*продукт в морозилке/i); ok('в морозилке ледяная сводка');
  // своя категория
  await pg.click('[data-act=place][data-v=fridge]');
  await pg.click('[data-act=open-add]'); await pg.waitForTimeout(250);
  await pg.fill('#fName', 'Корм Whiskas'); await pg.click('[data-act=cat-new]'); await pg.waitForTimeout(250);
  await pg.fill('#ncName', 'Для кота'); await pg.click('[data-act=nc-mode][data-v=color]');
  await pg.click('[data-act=cat-save]'); await pg.waitForTimeout(300);
  await pg.click('#saveBtn'); await pg.waitForTimeout(900);
  st = await api(K, 'GET', '/state');
  assert.equal(st.cats.length, 1); assert.equal(st.cats[0].n, 'Для кота'); assert.equal(st.cats[0].mode, 'color'); ok('своя категория сохранилась на сервере');
  const wk = st.products.find((p) => p.name === 'Корм Whiskas'); assert.equal(wk.c, st.cats[0].id); ok('продукт лежит в своей категории');
  // цвет: сохранить HEX в «Мои цвета»
  await pg.click('[data-act=open-add]'); await pg.waitForTimeout(250);
  await pg.click('[data-act=cat-new]'); await pg.waitForTimeout(250);
  await pg.click('[data-act=pk-open]'); await pg.waitForTimeout(300);
  await pg.click('#pkSave'); await pg.waitForTimeout(700);
  st = await api(K, 'GET', '/state'); assert.equal(st.me.myCols.length, 1); assert.match(st.me.myCols[0], /^#[0-9A-F]{6}$/); ok('«Мои цвета» сохранились на сервере');
  await pg.click('[data-act=pk-close]'); await pg.waitForTimeout(200);
  // перезагрузка: всё на месте
  await pg.reload(); await pg.waitForSelector('#main:not([hidden])'); await pg.waitForTimeout(500);
  assert.ok(await pg.locator('#placeSw:not([hidden])').count()); ok('после перезагрузки морозилка на месте');
  assert.ok(await pg.locator('.acc-h:has-text("Для кота")').count()); ok('после перезагрузки своя категория на месте');
  // переименовать и удалить свою категорию
  await pg.click('[data-act=open-add]'); await pg.waitForTimeout(250);
  await pg.click('#catManage'); await pg.waitForTimeout(250);
  await pg.click('[data-act=cat-edit]'); await pg.waitForTimeout(250);
  await pg.fill('#ncName', 'Корм для кота'); await pg.click('[data-act=cat-save]'); await pg.waitForTimeout(800);
  st = await api(K, 'GET', '/state'); assert.equal(st.cats[0].n, 'Корм для кота'); ok('переименование категории дошло до сервера');
  await pg.click('[data-act=cat-edit]'); await pg.waitForTimeout(250);
  await pg.click('#catDel'); await pg.click('#catDel'); await pg.waitForTimeout(900);
  st = await api(K, 'GET', '/state'); assert.equal(st.cats.length, 0); assert.equal(st.products.find((p) => p.name === 'Корм Whiskas').c, 'other'); ok('удаление категории: продукт ушёл в «Другое», на сервере её нет');
  await pg.click('[data-act=close-form]'); await pg.waitForTimeout(250);
  // свой срок заморозки
  if (await pg.locator('#secAll').count()) await pg.click('#secAll'); await pg.waitForTimeout(300);
  await pg.locator('.row:has-text("Молоко")').first().click(); await pg.waitForTimeout(250);
  await pg.click('[data-act=fz-toggle]'); await pg.click('[data-act=fz-custom]');
  await pg.fill('#fzDate', '2027-02-14');
  await pg.locator('#fzDate').dispatchEvent('change'); await pg.click('[data-act=fz-do]'); await pg.waitForTimeout(900);
  st = await api(K, 'GET', '/state'); const ml = st.products.find((p) => p.name === 'Молоко'); assert.equal(ml.fz, true); assert.equal(ml.exp, '2027-02-14'); ok('свой срок заморозки сохранился на сервере');
  // личный список без семьи: отдельный человек, один в холодильнике
  const L = { id: 404, first_name: 'Лена', allows_write_to_pm: true };
  await api(L, 'POST', '/consent'); await api(L, 'POST', '/onboarded');
  const lone = await open1(L);
  await lone.pg.click('[data-tab=buy]'); await lone.pg.waitForTimeout(300);
  assert.ok(await lone.pg.locator('#qaName').count()); ok('один в холодильнике: вверху поле «Что купить?»');
  await lone.pg.fill('#qaName', 'Яйца'); await lone.pg.keyboard.press('Enter'); await lone.pg.waitForTimeout(900);
  st = await api(L, 'GET', '/state');
  assert.equal(st.asks.length, 1); assert.deepEqual(st.asks[0].to_ids, []); ok('пункт личного списка сохранился на сервере');
  await lone.pg.reload(); await lone.pg.waitForSelector('#main:not([hidden])'); await lone.pg.click('[data-tab=buy]'); await lone.pg.waitForTimeout(400);
  assert.ok(await lone.pg.locator('#buyList .row:has-text("Яйца")').count()); ok('после перезагрузки «Яйца» на месте');
  await lone.pg.click('#buyList .chk'); await lone.pg.waitForTimeout(800);
  st = await api(L, 'GET', '/state'); assert.equal(st.asks[0].done, true); ok('«куплено» тоже сохраняется');
  assert.equal(sent.filter((m) => m.chat_id === 404).length, 0); ok('личный список никому не отправил сообщений');
  errs.push(...lone.errs);
  assert.deepEqual(errs.filter((e) => !/ERR_TUNNEL|favicon/.test(e)), []); ok('в консоли браузера нет ошибок');
  console.log(`\nВсе ${n} проверок прошли`);
  process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
