// Логика Фриджа без HTTP: проверка входа из Telegram, холодильники, продукты, просьбы, напоминания.
'use strict';
const crypto = require('node:crypto');
const { enqueue } = require('./tg');

const DEFAULT_TPL = '{кто} просит вас купить:\n{что} — {сколько}\n💬 {коммент}';
const UNITS = ['шт', 'г', 'кг', 'мл', 'л', 'уп', 'пучок'];
const CATS = ['dairy', 'meat', 'veg', 'ready', 'drink', 'sauce', 'sweet', 'other'];
const INVITE_TTL_MS = 24 * 3600 * 1000;
const ASKS_PER_HOUR = 20;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };

/* ---------- проверка данных входа мини-аппа (initData) ----------
   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app */
function checkInitData(raw, botToken, maxAgeSec = 24 * 3600, nowSec = Math.floor(Date.now() / 1000)) {
  if (!raw || typeof raw !== 'string' || raw.length > 4096) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest();
  const got = Buffer.from(hash, 'hex');
  if (got.length !== calc.length || !crypto.timingSafeEqual(got, calc)) return null;
  const authDate = Number(p.get('auth_date'));
  if (!authDate || nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return null;
  let user;
  try { user = JSON.parse(p.get('user') || 'null'); } catch (e) { return null; }
  if (!user || !Number.isSafeInteger(user.id)) return null;
  return { user, startParam: p.get('start_param') || '' };
}

/* ---------- проверки ввода ---------- */
const str = (v, max, name, required = true) => {
  if (v == null || v === '') { if (required) bad(name + ': пусто'); return ''; }
  if (typeof v !== 'string') bad(name + ': не строка');
  const s = v.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim();
  if (required && !s) bad(name + ': пусто');
  if (s.length > max) bad(name + ': слишком длинно');
  return s;
};
const qty = (v) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 100000) bad('количество'); return Math.round(n * 100) / 100; };
const unit = (v) => (UNITS.includes(v) ? v : bad('единица'));
const cat = (v) => (CATS.includes(v) ? v : 'other');
const emoji = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 8 ? v : '📦');
const dateOrNull = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v + 'T00:00:00Z'))) bad('дата');
  return v;
};

/* ---------- дата производства + срок годности ---------- */
const SHELF_U = { 'д': 3650, 'нед': 520, 'мес': 120, 'год': 10 };
const addDaysIso = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// «+ N месяцев» по календарю: 31 января + 1 мес = 28 (29) февраля, а не 3 марта
function addMonthsIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + n, ny = Math.floor(t / 12), nm = t % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
}
function calcExp(made, n, u) {
  if (u === 'д') return addDaysIso(made, n);
  if (u === 'нед') return addDaysIso(made, n * 7);
  if (u === 'мес') return addMonthsIso(made, n);
  return addMonthsIso(made, n * 12);
}
// Что хранить по срокам. Если есть «изготовлено + срок», «годен до» считает сервер: клиенту не верим.
function shelfFields(p, prev) {
  const has = (k) => p[k] !== undefined;
  if (!has('made') && !has('sn') && !has('su')) {
    if (!has('exp')) return { exp: prev ? prev.exp : null, made: prev ? prev.made : null, sn: prev ? prev.shelf_n : null, su: prev ? prev.shelf_u : null };
    return { exp: dateOrNull(p.exp), made: null, sn: null, su: null };
  }
  const made = dateOrNull(p.made);
  if (!made) return { exp: has('exp') ? dateOrNull(p.exp) : null, made: null, sn: null, su: null };
  const n = Number(p.sn), u = p.su;
  if (!Number.isInteger(n) || n < 1 || !SHELF_U[u] || n > SHELF_U[u]) bad('срок годности');
  if (made > addDaysIso(new Date().toISOString().slice(0, 10), 2)) bad('дата производства в будущем');
  return { exp: calcExp(made, n, u), made, sn: n, su: u };
}

/* ---------- пользователи и холодильники ---------- */
const getUser = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const membership = (db, uid) => db.prepare('SELECT * FROM members WHERE user_id=?').get(uid);
// Как человека зовут в холодильнике: свой ник, а если его нет, имя из Telegram. Его же видят в сообщениях бота.
const displayName = (db, uid) => {
  const r = db.prepare('SELECT m.nick, u.first_name FROM users u LEFT JOIN members m ON m.user_id=u.id WHERE u.id=?').get(uid);
  return r ? (r.nick || r.first_name || 'Без имени') : 'Без имени';
};

function upsertUser(db, tgUser, extra = {}) {
  const name = String(tgUser.first_name || '').slice(0, 64) || 'Без имени';
  const u = getUser(db, tgUser.id);
  if (!u) {
    db.prepare('INSERT INTO users(id,first_name,can_dm,consent_at) VALUES(?,?,?,?)')
      .run(tgUser.id, name, extra.canDm ? 1 : 0, extra.consent ? new Date().toISOString() : null);
  } else {
    db.prepare('UPDATE users SET first_name=? WHERE id=?').run(name, tgUser.id);
    if (extra.canDm) db.prepare('UPDATE users SET can_dm=1 WHERE id=?').run(tgUser.id);
    if (extra.consent && !u.consent_at) db.prepare('UPDATE users SET consent_at=? WHERE id=?').run(new Date().toISOString(), tgUser.id);
  }
  return getUser(db, tgUser.id);
}

function ensureFridge(db, uid) {
  const m = membership(db, uid);
  if (m) return m.fridge_id;
  const r = db.prepare('INSERT INTO fridges(owner_id) VALUES(?)').run(uid);
  db.prepare("INSERT INTO members(fridge_id,user_id,role) VALUES(?,?,'owner')").run(r.lastInsertRowid, uid);
  return Number(r.lastInsertRowid);
}

function leaveFridge(db, uid) {
  const m = membership(db, uid);
  if (!m) return null;
  const others = db.prepare('SELECT * FROM members WHERE fridge_id=? AND user_id<>? ORDER BY joined_at').all(m.fridge_id, uid);
  db.prepare('DELETE FROM members WHERE fridge_id=? AND user_id=?').run(m.fridge_id, uid);
  if (!others.length) return { fridgeId: m.fridge_id, empty: true };
  if (m.role === 'owner') {
    db.prepare("UPDATE members SET role='owner' WHERE fridge_id=? AND user_id=?").run(m.fridge_id, others[0].user_id);
    db.prepare('UPDATE fridges SET owner_id=? WHERE id=?').run(others[0].user_id, m.fridge_id);
  }
  return { fridgeId: m.fridge_id, empty: false };
}

function newInvite(db, uid) {
  const fid = ensureFridge(db, uid);
  // одна действующая ссылка на холодильник: старые гасим
  db.prepare('DELETE FROM invites WHERE fridge_id=? AND used_by IS NULL').run(fid);
  const token = crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO invites(token,fridge_id,created_by,expires_at) VALUES(?,?,?,?)').run(token, fid, uid, Date.now() + INVITE_TTL_MS);
  return token;
}

function pendingInvite(db, uid) {
  const m = membership(db, uid);
  if (!m) return null;
  return db.prepare('SELECT token,expires_at FROM invites WHERE fridge_id=? AND used_by IS NULL AND expires_at>?').get(m.fridge_id, Date.now()) || null;
}

function revokeInvites(db, uid) {
  const m = membership(db, uid);
  if (m) db.prepare('DELETE FROM invites WHERE fridge_id=? AND used_by IS NULL').run(m.fridge_id);
}

// Вход по приглашению. Возвращает {ok, reason, fridgeId, inviter}
function joinByToken(db, uid, token) {
  if (typeof token !== 'string' || !/^[\w-]{8,40}$/.test(token)) return { ok: false, reason: 'bad' };
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(token);
  if (!inv) return { ok: false, reason: 'notfound' };
  const cur = membership(db, uid);
  if (cur && cur.fridge_id === inv.fridge_id) return { ok: true, reason: 'already', fridgeId: inv.fridge_id };
  if (inv.used_by) return { ok: false, reason: 'used' };
  if (inv.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  db.exec('BEGIN');
  try {
    const left = leaveFridge(db, uid);
    if (left && left.empty) {
      // свой пустой холодильник: продукты переезжают вместе с человеком
      db.prepare('UPDATE products SET fridge_id=? WHERE fridge_id=?').run(inv.fridge_id, left.fridgeId);
      db.prepare('DELETE FROM fridges WHERE id=?').run(left.fridgeId);
    }
    db.prepare("INSERT INTO members(fridge_id,user_id,role) VALUES(?,?,'member')").run(inv.fridge_id, uid);
    db.prepare("UPDATE invites SET used_by=?, used_at=datetime('now') WHERE token=?").run(uid, token);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { ok: true, reason: 'joined', fridgeId: inv.fridge_id, inviter: inv.created_by };
}

/* ---------- состояние для мини-аппа ---------- */
function stateFor(db, uid) {
  const u = getUser(db, uid);
  const fid = ensureFridge(db, uid);
  const f = db.prepare('SELECT * FROM fridges WHERE id=?').get(fid);
  const members = db.prepare(`SELECT m.user_id id, m.role, u.first_name name, u.can_dm, m.nick, m.photo_v, m.photo IS NOT NULL has_photo
    FROM members m JOIN users u ON u.id=m.user_id WHERE m.fridge_id=? ORDER BY m.role='owner' DESC, m.joined_at`).all(fid);
  const products = db.prepare('SELECT id,name,e,c,exp,made,shelf_n sn,shelf_u su,q,u,added_by,added FROM products WHERE fridge_id=? ORDER BY id').all(fid);
  const asks = db.prepare(`SELECT * FROM (
      SELECT id,from_id,to_ids,name,q,u,note,done,done_by,created_at FROM asks WHERE fridge_id=? AND done=0
      UNION ALL SELECT * FROM (SELECT id,from_id,to_ids,name,q,u,note,done,done_by,created_at FROM asks WHERE fridge_id=? AND done=1 ORDER BY id DESC LIMIT 10)
    ) ORDER BY id`).all(fid, fid).map((a) => ({ ...a, to_ids: JSON.parse(a.to_ids), done: !!a.done }));
  const inv = pendingInvite(db, uid);
  return {
    me: { id: uid, name: displayName(db, uid), canDm: !!u.can_dm, onboarded: !!u.onboarded,
      newsRead: (() => { try { return JSON.parse(u.news_read || '[]'); } catch (e) { return []; } })(),
      notify: { on: !!u.notify_on, days: u.notify_days, time: u.notify_time } },
    fridge: { id: fid, name: f.name, tpl: f.tpl || DEFAULT_TPL, ownerId: f.owner_id },
    members: members.map((m) => ({ id: m.id, name: m.nick || m.name, tgName: m.name, nick: m.nick || '', role: m.role, bot: !!m.can_dm, photoV: m.has_photo ? m.photo_v : 0 })),
    products, asks,
    invite: inv ? { token: inv.token, expiresAt: inv.expires_at } : null
  };
}

/* ---------- продукты ---------- */
function addProducts(db, uid, list) {
  if (!Array.isArray(list) || !list.length || list.length > 60) bad('список продуктов');
  const fid = ensureFridge(db, uid);
  const count = db.prepare('SELECT count(*) n FROM products WHERE fridge_id=?').get(fid).n;
  if (count + list.length > 500) bad('слишком много продуктов в холодильнике');
  const ins = db.prepare('INSERT INTO products(fridge_id,name,e,c,exp,made,shelf_n,shelf_u,q,u,added_by,added) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const today = new Date().toISOString().slice(0, 10);
  const ids = [];
  db.exec('BEGIN');
  try {
    for (const p of list) {
      const sh = shelfFields(p, null);
      const r = ins.run(fid, str(p.name, 40, 'название'), emoji(p.e), cat(p.c), sh.exp, sh.made, sh.sn, sh.su, qty(p.q), unit(p.u), uid, today);
      ids.push(Number(r.lastInsertRowid));
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return ids;
}

function ownProduct(db, uid, id) {
  const m = membership(db, uid);
  const p = m && db.prepare('SELECT * FROM products WHERE id=? AND fridge_id=?').get(Number(id), m.fridge_id);
  if (!p) throw new HttpError(404, 'нет такого продукта');
  return p;
}

function updateProduct(db, uid, id, b) {
  const p = ownProduct(db, uid, id);
  const n = {
    name: b.name !== undefined ? str(b.name, 40, 'название') : p.name,
    e: b.e !== undefined ? emoji(b.e) : p.e,
    c: b.c !== undefined ? cat(b.c) : p.c,
    ...(() => { const sh = shelfFields(b, p); return { exp: sh.exp, made: sh.made, sn: sh.sn, su: sh.su }; })(),
    q: b.q !== undefined ? qty(b.q) : p.q,
    u: b.u !== undefined ? unit(b.u) : p.u
  };
  db.prepare('UPDATE products SET name=?,e=?,c=?,exp=?,made=?,shelf_n=?,shelf_u=?,q=?,u=? WHERE id=?').run(n.name, n.e, n.c, n.exp, n.made, n.sn, n.su, n.q, n.u, p.id);
}

function deleteProduct(db, uid, id) {
  const p = ownProduct(db, uid, id);
  db.prepare('DELETE FROM products WHERE id=?').run(p.id);
}

/* ---------- просьбы купить ---------- */
function renderAsk(tpl, from, name, q, u, note) {
  const map = { 'кто': from, 'что': name, 'сколько': String(q).replace('.', ',') + ' ' + u, 'коммент': (note || '').trim() };
  return String(tpl || DEFAULT_TPL).replace(/\{(кто|что|сколько|коммент)\}/g, (m, k) => map[k])
    .split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.replace(/💬/g, '').trim()).join('\n');
}

function createAsk(db, uid, b, cfg) {
  const m = membership(db, uid);
  if (!m) bad('нет холодильника');
  const recent = db.prepare("SELECT count(*) n FROM asks WHERE from_id=? AND created_at>datetime('now','-1 hour')").get(uid).n;
  if (recent >= ASKS_PER_HOUR) throw new HttpError(429, 'Слишком много просьб за час. Попробуй позже.');
  const memberIds = db.prepare('SELECT user_id FROM members WHERE fridge_id=?').all(m.fridge_id).map((r) => r.user_id);
  const to = Array.isArray(b.to) ? [...new Set(b.to.map(Number))] : [];
  if (!to.length || to.some((id) => id === uid || !memberIds.includes(id))) bad('кому');
  const name = str(b.name, 40, 'что купить'), q = qty(b.q), u = unit(b.u), note = str(b.note, 140, 'комментарий', false);
  const r = db.prepare('INSERT INTO asks(fridge_id,from_id,to_ids,name,q,u,note) VALUES(?,?,?,?,?,?,?)')
    .run(m.fridge_id, uid, JSON.stringify(to), name, q, u, note);
  const askId = Number(r.lastInsertRowid);
  const f = db.prepare('SELECT tpl FROM fridges WHERE id=?').get(m.fridge_id);
  const from = displayName(db, uid);
  const text = renderAsk(f.tpl, from, name, q, u, note);
  const delivered = [];
  for (const id of to) {
    const rcp = getUser(db, id);
    if (!rcp || !rcp.can_dm) continue;
    const kb = [[{ text: '✅ Куплено', callback_data: 'done:' + askId }]];
    if (cfg.PUBLIC_URL) kb.push([{ text: 'Открыть Фридж', web_app: { url: cfg.PUBLIC_URL } }]);
    enqueue(db, id, text, { inline_keyboard: kb }, 'ask:' + askId + ':' + id);
    delivered.push(id);
  }
  return { id: askId, queued: delivered };
}

function markAskDone(db, uid, id) {
  const m = membership(db, uid);
  const a = m && db.prepare('SELECT * FROM asks WHERE id=? AND fridge_id=?').get(Number(id), m.fridge_id);
  if (!a) throw new HttpError(404, 'нет такой просьбы');
  if (a.done) return { already: true, ask: a };
  db.prepare('UPDATE asks SET done=1, done_by=? WHERE id=?').run(uid, a.id);
  if (a.from_id !== uid) {
    const asker = getUser(db, a.from_id);
    if (asker && asker.can_dm) {
      const who = displayName(db, uid);
      enqueue(db, a.from_id, `${who} купил(а): ${a.name}, ${String(a.q).replace('.', ',')} ${a.u}`, null, 'done:' + a.id);
    }
  }
  return { already: false, ask: a };
}

/* ---------- ник и фото участника ---------- */
// Менять можно себя; владелец холодильника может поправить любого из своей семьи.
function profileTarget(db, actor, target) {
  const a = membership(db, actor), t = membership(db, target);
  if (!a || !t || a.fridge_id !== t.fridge_id) throw new HttpError(404, 'нет такого участника');
  if (actor !== target && a.role !== 'owner') throw new HttpError(403, 'Менять других может только владелец');
  return t;
}
function setNick(db, actor, target, nick) {
  profileTarget(db, actor, target);
  let v = nick == null ? '' : typeof nick === 'string' ? nick : bad('ник');
  v = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (v.length > 24) bad('Ник длиннее 24 знаков');
  db.prepare('UPDATE members SET nick=? WHERE user_id=?').run(v || null, target);
  return v;
}
const PHOTO_MAX = 150000; // знаков в data-url, это около 110 КБ
function setPhoto(db, actor, target, dataUrl) {
  profileTarget(db, actor, target);
  if (dataUrl == null) { db.prepare('UPDATE members SET photo=NULL, photo_v=photo_v+1 WHERE user_id=?').run(target); return; }
  if (typeof dataUrl !== 'string' || dataUrl.length > PHOTO_MAX || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) bad('Нужна фотография JPEG до 100 КБ');
  const buf = Buffer.from(dataUrl.slice(23), 'base64');
  if (buf.length < 200 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) bad('Это не фотография');
  db.prepare('UPDATE members SET photo=?, photo_v=photo_v+1 WHERE user_id=?').run(dataUrl, target);
}
function getPhoto(db, actor, target) {
  const a = membership(db, actor), t = membership(db, target);
  if (!a || !t || a.fridge_id !== t.fridge_id) throw new HttpError(404, 'нет такого участника');
  return t.photo || null;
}

/* ---------- прочитанные новости ---------- */
function markNewsRead(db, uid, ids) {
  if (!Array.isArray(ids) || ids.length > 50 || ids.some((i) => typeof i !== 'string' || !/^[\w-]{1,40}$/.test(i))) bad('новости');
  const u = getUser(db, uid);
  let cur = [];
  try { cur = JSON.parse(u.news_read || '[]'); } catch (e) { cur = []; }
  const next = [...new Set([...cur, ...ids])].slice(-100);
  db.prepare('UPDATE users SET news_read=? WHERE id=?').run(JSON.stringify(next), uid);
  return next;
}

/* ---------- напоминания о сроках ---------- */
function mskNow(tz, d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

function digestText(products, today, days) {
  const list = products.filter((p) => p.exp && dayDiff(p.exp, today) <= days).sort((a, b) => (a.exp < b.exp ? -1 : 1));
  if (!list.length) return null;
  const over = list.filter((p) => dayDiff(p.exp, today) < 0), soon = list.filter((p) => dayDiff(p.exp, today) >= 0);
  const when = (p) => { const d = dayDiff(p.exp, today); return d === 0 ? 'сегодня' : d === 1 ? 'завтра' : `через ${d} ${plural(d, 'день', 'дня', 'дней')}`; };
  let s = '';
  if (over.length) s += 'Просрочено, проверь:\n' + over.slice(0, 5).map((p) => `${p.e} ${p.name}`).join('\n') + '\n\n';
  if (soon.length) s += 'Скоро испортится:\n' + soon.slice(0, 6).map((p) => `${p.e} ${p.name}, ${when(p)}`).join('\n') + (soon.length > 6 ? `\nи ещё ${soon.length - 6}` : '');
  return s.trim();
}

// Раз в минуту: кому пора прислать сводку. Окно 3 часа — если сервер перезапускался, сводка всё равно придёт.
function queueReminders(db, cfg, d = new Date()) {
  const now = mskNow(cfg.TZ || 'Europe/Moscow', d);
  const users = db.prepare('SELECT u.*, m.fridge_id FROM users u JOIN members m ON m.user_id=u.id WHERE u.notify_on=1 AND u.can_dm=1 AND u.consent_at IS NOT NULL').all();
  let n = 0;
  for (const u of users) {
    const [h, mi] = u.notify_time.split(':').map(Number), [nh, nm] = now.time.split(':').map(Number);
    const diff = nh * 60 + nm - (h * 60 + mi);
    if (diff < 0 || diff > 180) continue;
    const products = db.prepare('SELECT name,e,exp FROM products WHERE fridge_id=? AND exp IS NOT NULL').all(u.fridge_id);
    const text = digestText(products, now.date, u.notify_days);
    if (!text) continue;
    const kb = cfg.PUBLIC_URL ? { inline_keyboard: [[{ text: 'Открыть Фридж', web_app: { url: cfg.PUBLIC_URL } }]] } : null;
    if (enqueue(db, u.id, text, kb, `rem:${u.id}:${now.date}`)) n++;
  }
  return n;
}

module.exports = {
  HttpError, DEFAULT_TPL, UNITS, CATS, checkInitData, str, qty, unit, dateOrNull,
  getUser, membership, upsertUser, ensureFridge, leaveFridge, newInvite, pendingInvite, revokeInvites, joinByToken,
  stateFor, addProducts, updateProduct, deleteProduct, renderAsk, createAsk, markAskDone,
  displayName, calcExp, setNick, setPhoto, getPhoto, markNewsRead,
  mskNow, digestText, queueReminders
};
