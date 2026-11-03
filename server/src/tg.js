// Связь с Telegram: напрямую или через «мост» (Cloudflare Worker relay.js с ключом x-relay-key).
// Все исходящие сообщения идут через очередь outbox: если Telegram не ответил, повторяем с паузами.
'use strict';

function makeTg(cfg, log) {
  const root = (cfg.TG_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (cfg.TG_RELAY_KEY) headers['x-relay-key'] = cfg.TG_RELAY_KEY;

  async function call(method, body, timeoutMs = 15000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${root}/bot${cfg.BOT_TOKEN}/${method}`, {
        method: 'POST', headers, body: JSON.stringify(body || {}), signal: ctl.signal
      });
      let j = null;
      try { j = await r.json(); } catch (e) { /* мост мог вернуть не JSON */ }
      if (!j) return { ok: false, error_code: r.status, description: 'bad response ' + r.status };
      return j;
    } catch (e) {
      return { ok: false, error_code: 0, description: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
    } finally { clearTimeout(t); }
  }
  return { call, log };
}

/* ---------- очередь отправки ---------- */
// Паузы между попытками: 20 c, 1, 2, 5, 10, 20, 30 мин, дальше каждые 30 мин; через сутки сдаёмся.
const BACKOFF = [20, 60, 120, 300, 600, 1200, 1800];
const GIVE_UP_MS = 24 * 3600 * 1000;

function enqueue(db, chatId, text, markup, dedup) {
  try {
    db.prepare('INSERT INTO outbox(chat_id,text,markup,dedup,created_at) VALUES(?,?,?,?,?)')
      .run(chatId, text, markup ? JSON.stringify(markup) : null, dedup || null, Date.now());
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false; // уже в очереди — не дублируем
    throw e;
  }
}

let busy = false;
async function flush(db, tg, now = Date.now()) {
  if (busy) return 0;
  busy = true;
  let sent = 0;
  try {
    const due = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND failed IS NULL AND next_at<=? ORDER BY id LIMIT 25').all(now);
    for (const m of due) {
      const body = { chat_id: m.chat_id, text: m.text, link_preview_options: { is_disabled: true } };
      if (m.markup) body.reply_markup = JSON.parse(m.markup);
      const r = await tg.call('sendMessage', body);
      if (r.ok) {
        db.prepare("UPDATE outbox SET sent_at=datetime('now') WHERE id=?").run(m.id);
        sent++;
        continue;
      }
      const code = r.error_code;
      // 403 — человек заблокировал бота или не нажимал «Старт»; 400 chat not found — тоже не повторяем
      if (code === 403 || (code === 400 && /chat not found|user is deactivated/i.test(r.description || ''))) {
        db.prepare('UPDATE outbox SET failed=? WHERE id=?').run(String(r.description || code).slice(0, 200), m.id);
        db.prepare('UPDATE users SET can_dm=0 WHERE id=?').run(m.chat_id);
        continue;
      }
      if (code === 400) { // сломанный запрос: повтор не поможет
        db.prepare('UPDATE outbox SET failed=? WHERE id=?').run(String(r.description || code).slice(0, 200), m.id);
        continue;
      }
      const tries = m.tries + 1;
      if (now - m.created_at > GIVE_UP_MS) {
        db.prepare('UPDATE outbox SET failed=?, tries=? WHERE id=?').run('gave up: ' + String(r.description).slice(0, 150), tries, m.id);
        continue;
      }
      const wait = code === 429 && r.parameters && r.parameters.retry_after
        ? r.parameters.retry_after
        : BACKOFF[Math.min(tries - 1, BACKOFF.length - 1)];
      db.prepare('UPDATE outbox SET tries=?, next_at=? WHERE id=?').run(tries, now + wait * 1000, m.id);
      if (code === 0 || code >= 500) break; // связи нет — остальные подождут следующего круга
    }
  } finally { busy = false; }
  return sent;
}

module.exports = { makeTg, enqueue, flush, BACKOFF };
