// Связь с Telegram: напрямую или через «мост» (Cloudflare Worker relay.js с ключом x-relay-key).
// Все исходящие сообщения идут через очередь outbox: если Telegram не ответил, повторяем с паузами.
'use strict';

function makeTg(cfg, log) {
  // Мостов может быть несколько: TG_API_ROOT="https://a,https://b", TG_RELAY_KEY="ключ_a,ключ_b" (или один общий ключ).
  // Держимся за мост, который отвечает; при обрыве, таймауте или ошибке самого моста переходим на следующий.
  const roots = String(cfg.TG_API_ROOT || 'https://api.telegram.org').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const keys = String(cfg.TG_RELAY_KEY || '').split(',').map((s) => s.trim());
  const keyOf = (i) => (keys.length > 1 ? keys[i] : keys[0]) || '';
  let cur = 0;

  async function once(i, method, body, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const headers = { 'content-type': 'application/json' };
    if (keyOf(i)) headers['x-relay-key'] = keyOf(i);
    try {
      const r = await fetch(`${roots[i]}/bot${cfg.BOT_TOKEN}/${method}`, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: ctl.signal });
      let j = null;
      try { j = await r.json(); } catch (e) { /* мост вернул не JSON */ }
      if (!j || typeof j.ok !== 'boolean') return { relayFail: true, res: { ok: false, error_code: r.status >= 500 ? r.status : 502, description: 'bridge ' + r.status } };
      return { res: j };
    } catch (e) {
      return { relayFail: true, res: { ok: false, error_code: 0, description: e.name === 'AbortError' ? 'timeout' : String(e.message || e) } };
    } finally { clearTimeout(t); }
  }

  async function call(method, body, timeoutMs = 15000) {
    let last;
    for (let a = 0; a < roots.length; a++) {
      const i = (cur + a) % roots.length;
      const r = await once(i, method, body, timeoutMs);
      if (!r.relayFail) { if (a) { cur = i; log && log('мост', roots[i]); } return r.res; }
      last = r.res;
    }
    if (roots.length > 1) cur = (cur + 1) % roots.length;
    return last;
  }
  return { call, log, roots };
}

/* ---------- очередь отправки ---------- */
// Паузы между попытками: 20 c, 1, 2, 5, 10, 20, 30 мин, дальше каждые 30 мин; через сутки сдаёмся.
const BACKOFF = [20, 60, 120, 300, 600, 1200, 1800];
const GIVE_UP_MS = 24 * 3600 * 1000;

// extra: { kind: 'photo'|'album', media: [file_id...], ents: [...] } — для рассылок с картинками и форматированием
function enqueue(db, chatId, text, markup, dedup, extra) {
  try {
    const x = extra || {};
    db.prepare('INSERT INTO outbox(chat_id,text,markup,dedup,created_at,kind,media,ents) VALUES(?,?,?,?,?,?,?,?)')
      .run(chatId, text, markup ? JSON.stringify(markup) : null, dedup || null, Date.now(), x.kind || 'text',
        x.media && x.media.length ? JSON.stringify(x.media) : null, x.ents && x.ents.length ? JSON.stringify(x.ents) : null);
    return true;
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return false; // уже в очереди — не дублируем
    throw e;
  }
}

// Как отправить строку очереди: обычным сообщением, одной картинкой или альбомом
function buildCall(m) {
  const ents = m.ents ? JSON.parse(m.ents) : null, media = m.media ? JSON.parse(m.media) : [];
  if (m.kind === 'photo' && media.length) {
    const body = { chat_id: m.chat_id, photo: media[0] };
    if (m.text) { body.caption = m.text; if (ents) body.caption_entities = ents; }
    if (m.markup) body.reply_markup = JSON.parse(m.markup);
    return { method: 'sendPhoto', body };
  }
  if (m.kind === 'album' && media.length > 1) {
    const arr = media.map((f, i) => (i === 0 && m.text ? { type: 'photo', media: f, caption: m.text, ...(ents ? { caption_entities: ents } : {}) } : { type: 'photo', media: f }));
    return { method: 'sendMediaGroup', body: { chat_id: m.chat_id, media: arr } };
  }
  const body = { chat_id: m.chat_id, text: m.text, link_preview_options: { is_disabled: true } };
  if (ents) body.entities = ents;
  if (m.markup) body.reply_markup = JSON.parse(m.markup);
  return { method: 'sendMessage', body };
}

let busy = false;
async function flush(db, tg, now = Date.now()) {
  if (busy) return 0;
  busy = true;
  let sent = 0;
  try {
    const due = db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND failed IS NULL AND next_at<=? ORDER BY id LIMIT 25').all(now);
    for (const m of due) {
      const { method, body } = buildCall(m);
      const r = await tg.call(method, body);
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

module.exports = { makeTg, enqueue, flush, buildCall, BACKOFF };
