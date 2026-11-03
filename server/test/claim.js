// Проверка одноразовой страницы токена. Запуск: node test/claim.js
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const TOKEN = '1234567890:AAEtest_token-for_claim_check_1234567';
const KEY = 'k1', PORT = 18082, CODE = 'a1b2c3d4';
const calls = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (req.headers['x-relay-key'] !== KEY) { res.writeHead(403); return res.end(); }
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    calls.push(m[2]);
    res.writeHead(200, { 'content-type': 'application/json' });
    if (m[1] !== TOKEN) return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
    if (m[2] === 'getMe') return res.end(JSON.stringify({ ok: true, result: { username: 'friidge_bot', is_bot: true } }));
    if (m[2] === 'getUpdates') return setTimeout(() => res.end(JSON.stringify({ ok: true, result: [] })), 300);
    res.end(JSON.stringify({ ok: true, result: true }));
  });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(__dirname, 'claim-'));
  const env = { ...process.env, BOT_TOKEN: '', DB_FILE: path.join(dir, 'fridge.db'), PORT: String(PORT), PUBLIC_URL: 'https://fridge.example',
    TG_API_ROOT: 'http://127.0.0.1:1,http://127.0.0.1:' + fake.address().port, TG_RELAY_KEY: KEY, CLAIM_CODE: CODE, CLAIM_UNTIL: String(Date.now() + 3600000) };
  const srv = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  process.on('exit', () => { try { srv.kill(); } catch (e) {} fs.rmSync(dir, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + PORT;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) {} await wait(100); }
  let n = 0; const ok = (t) => console.log('  ✓', ++n, t);
  const post = (body) => fetch(base + '/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => ({})) }));

  assert.equal((await (await fetch(base + '/health')).json()).mode, 'waiting-token'); ok('без токена сервер ждёт');
  assert.equal((await fetch(base + '/')).status, 503); ok('мини-апп пока закрыт');
  const pg = await fetch(base + '/claim'); assert.equal(pg.status, 200); assert.match(pg.headers.get('content-security-policy'), /frame-ancestors 'none'/); ok('страница открывается, встраивать в чужие сайты нельзя');
  let r = await post({ code: 'zzzzzzzz', token: TOKEN }); assert.equal(r.s, 403); assert.match(r.j.error, /Осталось попыток: 9/); ok('неверный код — отказ и счётчик');
  r = await post({ code: CODE, token: 'abc' }); assert.equal(r.s, 400); ok('не токен — отказ');
  r = await post({ code: CODE, token: '1234567890:AAEwrong_token_wrong_token_wrong_toke' }); assert.equal(r.s, 400); assert.match(r.j.error, /не принял/); ok('чужой токен Telegram не принял — не сохраняем');
  r = await post({ code: CODE.toUpperCase(), token: TOKEN, switchMenu: true }); assert.equal(r.j.ok, true); assert.equal(r.j.bot, 'friidge_bot'); ok('верный код и токен — бот подключён (через второй мост)');
  const tf = path.join(dir, 'bot-token');
  assert.equal(fs.readFileSync(tf, 'utf8').trim(), TOKEN); assert.equal(fs.statSync(tf).mode & 0o777, 0o600); ok('токен в файле с правами 600');
  await wait(500);
  assert.ok(calls.includes('setChatMenuButton')); ok('кнопка «Холодильник» переключена');
  assert.equal((await fetch(base + '/claim')).status, 404); r = await post({ code: CODE, token: TOKEN }); assert.equal(r.s, 404); ok('после использования страница исчезла');
  assert.equal((await fetch(base + '/')).status, 200); ok('мини-апп открылся');
  srv.kill(); await wait(300);
  const srv2 = spawn(process.execPath, ['--no-warnings', path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
  process.on('exit', () => { try { srv2.kill(); } catch (e) {} });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) {} await wait(100); }
  assert.notEqual((await (await fetch(base + '/health')).json()).mode, 'waiting-token'); assert.equal((await fetch(base + '/claim')).status, 404); ok('после перезапуска токен на месте, страница закрыта');
  console.log(`\nВсе ${n} проверок страницы токена прошли`);
  process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e); process.exit(1); });
