// Одноразовая страница для токена бота: человек вставляет токен в обычном браузере (телефон/компьютер),
// а не печатает его в консоли сервера. Защита: одноразовый код из консоли, срок жизни, лимит попыток, HTTPS.
// После успешной вставки страница исчезает навсегда (токен лежит в файле, повторно не принимаем).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeTg } = require('./tg');

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;
const MAX_WRONG = 10;

function tokenFile(cfg) { return path.join(path.dirname(cfg.DB_FILE), 'bot-token'); }

function loadToken(cfg) {
  if (cfg.BOT_TOKEN) return cfg.BOT_TOKEN;
  try {
    const t = fs.readFileSync(tokenFile(cfg), 'utf8').trim();
    return TOKEN_RE.test(t) ? t : '';
  } catch (e) { return ''; }
}

function makeClaim(cfg, onToken, log) {
  const code = String(process.env.CLAIM_CODE || '');
  const until = Number(process.env.CLAIM_UNTIL || 0);
  let wrong = 0, done = false, busy = false;

  const active = () => !done && !cfg.BOT_TOKEN && code.length >= 6;
  const expired = () => !until || Date.now() > until;

  function page() {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Фридж: токен бота</title>
<style>
:root{--bg:#fff;--fg:#0B0D12;--fg2:#566074;--line:#DDE3F1;--tint:#DCE6FD;--ok:#1E7A3C;--bad:#C42B33}
@media (prefers-color-scheme:dark){:root{--bg:#0D1017;--fg:#F2F4F8;--fg2:#A3ACBD;--line:#2A3142;--tint:#1B2644;--ok:#5FD08A;--bad:#FF7A80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:32px 16px 24px;display:flex;flex-direction:column;gap:16px}
h1{font-size:26px;line-height:1.15;margin:0}p{margin:0;color:var(--fg2);font-size:15px}
label{font-weight:600;font-size:14px;display:block;margin-bottom:8px}
input[type=text],input[type=password]{width:100%;min-height:52px;padding:0 16px;border-radius:16px;border:1.5px solid var(--line);background:var(--bg);color:var(--fg);font-size:16px}
input:focus{outline:none;border-color:var(--fg)}
.chk{display:flex;gap:12px;align-items:flex-start;font-size:15px;min-height:44px}.chk input{width:22px;height:22px;margin-top:1px;flex:none}
button{min-height:56px;border:0;border-radius:999px;background:var(--fg);color:var(--bg);font-size:17px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5}
.msg{padding:14px 16px;border-radius:16px;background:var(--tint);font-size:15px}.msg.ok{color:var(--ok)}.msg.bad{color:var(--bad)}
.hint{font-size:13px}
</style></head><body><main>
<h1>Токен бота Фриджа</h1>
<p>Вставь сюда токен из @BotFather. Он сохранится только на сервере, а эта страница после этого исчезнет.</p>
<form id="f" autocomplete="off">
<div style="margin-bottom:16px"><label for="code">Код из консоли сервера</label><input id="code" type="text" inputmode="text" autocapitalize="off" spellcheck="false" maxlength="16" required></div>
<div style="margin-bottom:12px"><label for="tok">Токен бота</label><input id="tok" type="password" autocapitalize="off" spellcheck="false" maxlength="80" required>
<p class="hint" style="margin-top:8px">@BotFather → /mybots → твой бот → API Token → скопировать.</p></div>
<label class="chk" style="font-weight:400"><input id="sw" type="checkbox" checked><span>Сразу переключить кнопку «Холодильник» в боте на этот сервер</span></label>
<button id="b" type="submit" style="width:100%;margin-top:8px">Сохранить</button>
</form>
<div id="m" class="msg" role="status" hidden></div>
</main>
<script>
var f=document.getElementById('f'),m=document.getElementById('m'),b=document.getElementById('b');
f.addEventListener('submit',function(e){e.preventDefault();b.disabled=true;m.hidden=true;
 fetch('/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value.trim(),token:document.getElementById('tok').value.trim(),switchMenu:document.getElementById('sw').checked})})
 .then(function(r){return r.json().catch(function(){return {error:'Сервер ответил странно. Попробуй ещё раз.'}})})
 .then(function(j){m.hidden=false;setTimeout(function(){m.scrollIntoView({block:'nearest',behavior:'smooth'})},0);if(j.ok){m.className='msg ok';m.textContent='Готово: бот @'+j.bot+' подключён. Открой его в Telegram и нажми /start.';f.hidden=true;document.getElementById('tok').value=''}else{m.className='msg bad';m.textContent=j.error||'Не получилось';b.disabled=false}})
 .catch(function(){m.hidden=false;m.className='msg bad';m.textContent='Нет связи с сервером. Попробуй ещё раз.';b.disabled=false});
});
</script></body></html>`;
  }

  async function handle(req, res, url, send, readBody) {
    if (url.pathname !== '/claim') return false;
    const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
    if (!active()) { send(res, 404, 'not found', 'text/plain'); return true; }
    if (req.method === 'GET') {
      if (expired()) { send(res, 410, 'Код устарел. В консоли сервера: bash /opt/fridge-bot/server/deploy/claim.sh', 'text/plain; charset=utf-8'); return true; }
      send(res, 200, page(), 'text/html; charset=utf-8', { 'content-security-policy': CSP, 'x-frame-options': 'DENY' });
      return true;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'метод' }); return true; }
    if (expired()) { send(res, 410, { error: 'Код устарел. В консоли сервера: bash /opt/fridge-bot/server/deploy/claim.sh' }); return true; }
    if (wrong >= MAX_WRONG) { send(res, 429, { error: 'Слишком много неверных кодов. Страница закрыта. Новый код: bash /opt/fridge-bot/server/deploy/claim.sh' }); return true; }
    if (busy) { send(res, 429, { error: 'Уже проверяю, подожди пару секунд.' }); return true; }
    const body = await readBody(req, 4096);
    const c = String(body.code || '').trim().toLowerCase();
    const okCode = c.length === code.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code));
    if (!okCode) { wrong++; send(res, 403, { error: `Неверный код. Осталось попыток: ${MAX_WRONG - wrong}.` }); return true; }
    const token = String(body.token || '').trim();
    if (!TOKEN_RE.test(token)) { send(res, 400, { error: 'Это не похоже на токен бота. Он выглядит так: 1234567890:AAE…' }); return true; }
    busy = true;
    try {
      const probe = makeTg({ ...cfg, BOT_TOKEN: token }, log);
      const me = await probe.call('getMe', {}, 20000);
      if (!me.ok) {
        const msg = me.error_code === 401 || me.error_code === 404 ? 'Telegram не принял токен. Скопируй его заново из @BotFather.' : 'Telegram сейчас не отвечает. Подожди минуту и нажми ещё раз.';
        send(res, 400, { error: msg });
        return true;
      }
      const file = tokenFile(cfg);
      fs.writeFileSync(file, token + '\n', { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      done = true;
      await onToken(token, me.result.username, !!body.switchMenu);
      send(res, 200, { ok: true, bot: me.result.username });
      log('токен сохранён, бот @' + me.result.username);
    } finally { busy = false; }
    return true;
  }

  return { active, handle };
}

module.exports = { loadToken, makeClaim, tokenFile, TOKEN_RE };
