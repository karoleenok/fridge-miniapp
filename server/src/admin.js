// Служебное для владельца бота: пост с картинками и рассылка, статистика, заметки.
// Всё доступно только Telegram-id из OWNER_ID. Остальным эти команды не отвечают.
'use strict';
const { enqueue } = require('./tg');

const CAP = 1024;          // длина подписи к картинке в Telegram
const MAX_PICS = 10;       // в альбоме не больше десяти
const FOOT = '\n\nНе хочешь такие сообщения? Напиши /news';
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

const draft = (db) => db.prepare("SELECT * FROM broadcasts WHERE state='draft' ORDER BY id DESC LIMIT 1").get();

// Кому уйдёт: дал согласие, бот может ему писать, не отключил новости. Самого владельца не считаем.
function audience(db, ownerId) {
  const all = db.prepare('SELECT count(*) n FROM users WHERE consent_at IS NOT NULL AND id<>?').get(ownerId).n;
  const ids = db.prepare('SELECT id FROM users WHERE consent_at IS NOT NULL AND can_dm=1 AND news_off=0 AND id<>?').all(ownerId).map((r) => r.id);
  return { ids, all, skip: all - ids.length };
}

function stats(db, now = new Date()) {
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const day = (off) => new Date(now.getTime() - off * 86400000).toISOString().slice(0, 10);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = day(i);
    days.push({ d, n: one("SELECT count(*) n FROM users WHERE consent_at IS NOT NULL AND substr(consent_at,1,10)=?", d) });
  }
  return {
    total: one('SELECT count(*) n FROM users WHERE consent_at IS NOT NULL'),
    botCanWrite: one('SELECT count(*) n FROM users WHERE consent_at IS NOT NULL AND can_dm=1'),
    active7: one("SELECT count(*) n FROM users WHERE consent_at IS NOT NULL AND seen_at>=datetime('now','-7 day')"),
    newsOff: one('SELECT count(*) n FROM users WHERE news_off=1'),
    families: one('SELECT count(*) n FROM (SELECT fridge_id FROM members GROUP BY fridge_id HAVING count(*)>1)'),
    products: one('SELECT count(*) n FROM products'),
    asks: one('SELECT count(*) n FROM asks'),
    days,
    recent: db.prepare("SELECT first_name name, username nick, substr(consent_at,1,10) d FROM users WHERE consent_at IS NOT NULL ORDER BY consent_at DESC LIMIT 10").all()
  };
}

function statsText(s) {
  const L = ['Статистика Фриджа', '',
    `Пришли и дали согласие: ${s.total}`,
    `Бот может им писать: ${s.botCanWrite}`,
    `Открывали приложение за 7 дней: ${s.active7}`,
    `Семей, где больше одного человека: ${s.families}`,
    `Продуктов внутри: ${s.products}`,
    `Просьб «купить»: ${s.asks}`,
    `Отказались от рассылки: ${s.newsOff}`, '', 'Кто присоединился по дням:'];
  s.days.forEach((x) => L.push(`${x.d.slice(8)}.${x.d.slice(5, 7)} — ${x.n}`));
  if (s.recent.length) { L.push('', 'Последние:'); s.recent.forEach((r) => L.push(`${r.name || 'Без имени'}${r.nick ? ' @' + r.nick : ''}, ${r.d.slice(8)}.${r.d.slice(5, 7)}`)); L.push('', 'Все по списку: /users'); }
  return L.join('\n');
}

/* ---------- заметки ---------- */
const notes = {
  list: (db) => db.prepare('SELECT id,text,created_at,updated_at FROM notes ORDER BY id DESC LIMIT 200').all(),
  add(db, text) {
    const t = clean(text);
    const n = db.prepare('SELECT count(*) n FROM notes').get().n;
    if (n >= 500) throw new Error('Заметок уже 500, удали лишние');
    return Number(db.prepare('INSERT INTO notes(text) VALUES(?)').run(t).lastInsertRowid);
  },
  edit(db, id, text) {
    const r = db.prepare("UPDATE notes SET text=?, updated_at=datetime('now') WHERE id=?").run(clean(text), Number(id));
    if (!r.changes) throw new Error('Нет такой заметки');
  },
  del(db, id) { db.prepare('DELETE FROM notes WHERE id=?').run(Number(id)); }
};
function clean(text) {
  const t = String(text || '').replace(/\u0000/g, '').trim();
  if (!t) throw new Error('Пустая заметка');
  if (t.length > 2000) throw new Error('Заметка длиннее 2000 знаков');
  return t;
}
const noteLine = (n) => `#${n.id}  ${n.text.length > 90 ? n.text.slice(0, 90) + '…' : n.text}`;

/* ---------- рассылка ---------- */
// Из одного сообщения владельца достаём текст, форматирование и картинку.
function parsePost(msg, cutCommand) {
  let raw = String(msg.text || msg.caption || '');
  let ents = msg.entities || msg.caption_entities || [];
  let pre = 0;
  if (cutCommand) { const m = raw.match(/^\/(?:send|welcome)(?:@\w+)?\s*/); pre = m ? m[0].length : 0; }
  const text = raw.slice(pre).replace(/\s+$/, '');
  ents = ents.filter((e) => e.offset >= pre && e.offset + e.length <= pre + text.length && e.type !== 'bot_command')
    .map((e) => ({ ...e, offset: e.offset - pre }));
  const pic = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
  return { text, ents, pic };
}

// Кто присоединился: имя, @ник, дата. Страницами по 40, чтобы влезало в одно сообщение Telegram.
const PAGE = 40;
function members(db, page = 0) {
  const total = db.prepare('SELECT count(*) n FROM users WHERE consent_at IS NOT NULL').get().n;
  const rows = db.prepare('SELECT first_name name, username nick, can_dm dm, news_off off, substr(consent_at,1,10) d FROM users WHERE consent_at IS NOT NULL ORDER BY consent_at DESC LIMIT ? OFFSET ?').all(PAGE, page * PAGE);
  return { total, rows, pages: Math.max(1, Math.ceil(total / PAGE)), page };
}
function membersText(m) {
  if (!m.total) return 'Пока никто не присоединился.';
  const L = [`Присоединились: ${m.total}` + (m.pages > 1 ? `. Страница ${m.page + 1} из ${m.pages}` : ''), ''];
  m.rows.forEach((r, i) => L.push(`${m.page * PAGE + i + 1}. ${r.name || 'Без имени'}${r.nick ? ' @' + r.nick : ' (ника нет)'}, ${r.d.slice(8)}.${r.d.slice(5, 7)}${r.dm ? '' : ', бот писать не может'}${r.off ? ', без рассылок' : ''}`));
  return L.join('\n');
}

function saveDraft(db, { text, ents, pic }, fresh, kind = 'post') {
  let d = fresh ? null : draft(db);
  if (!d || Date.now() - Date.parse(d.created_at.replace(' ', 'T') + 'Z') > 3600000) {
    if (d) db.prepare("UPDATE broadcasts SET state='cancelled' WHERE id=?").run(d.id);
    db.prepare("UPDATE broadcasts SET state='cancelled' WHERE state='draft'").run();
    const id = Number(db.prepare('INSERT INTO broadcasts(text,ents,media,kind) VALUES(?,?,?,?)').run(text, ents.length ? JSON.stringify(ents) : null, JSON.stringify(pic ? [pic] : []), kind).lastInsertRowid);
    return db.prepare('SELECT * FROM broadcasts WHERE id=?').get(id);
  }
  const media = JSON.parse(d.media);
  if (pic) { if (media.length >= MAX_PICS) return { ...d, full: true }; media.push(pic); }
  if (text) db.prepare('UPDATE broadcasts SET text=?, ents=? WHERE id=?').run(text, ents.length ? JSON.stringify(ents) : null, d.id);
  db.prepare('UPDATE broadcasts SET media=? WHERE id=?').run(JSON.stringify(media), d.id);
  return db.prepare('SELECT * FROM broadcasts WHERE id=?').get(d.id);
}

// Строки для очереди: как увидит один человек. Footer добавляем в конец, чтобы форматирование не сдвинулось.
function postRows(b, appUrl, noFoot) {
  const media = JSON.parse(b.media || '[]'), ents = b.ents ? JSON.parse(b.ents) : [];
  const text = (b.text || '') + (noFoot ? '' : FOOT);
  const kb = appUrl ? { inline_keyboard: [[{ text: 'Открыть Фридж', web_app: { url: appUrl } }]] } : null;
  if (!media.length) return [{ text, ents, kb, kind: 'text', media: [] }];
  const kind = media.length === 1 ? 'photo' : 'album';
  if (text.length <= CAP) return [{ text, ents, kb: kind === 'photo' ? kb : null, kind, media }];
  // длинный текст не влезает в подпись: картинки отдельно, текст сразу под ними
  return [{ text: '', ents: [], kb: null, kind, media }, { text, ents, kb, kind: 'text', media: [] }];
}

function checkDraft(b) {
  const media = JSON.parse(b.media || '[]');
  const bad = [];
  if (!b.text && !media.length) bad.push('в посте нет ни текста, ни картинок');
  if (b.text.length > 3500) bad.push('текст длиннее 3500 знаков, Telegram может его не принять');
  return { media: media.length, bad };
}

function startSending(db, b, ownerId, appUrl) {
  const aud = audience(db, ownerId);
  const rows = postRows(b, appUrl);
  db.exec('BEGIN');
  try {
    aud.ids.forEach((uid) => rows.forEach((r, i) => enqueue(db, uid, r.text, r.kb, `bc:${b.id}:${uid}:${i}`, { kind: r.kind, media: r.media, ents: r.ents })));
    db.prepare("UPDATE broadcasts SET state='sending', total=?, sent_at=datetime('now') WHERE id=?").run(aud.ids.length, b.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return aud;
}

// Раз в минуту: если вся очередь рассылки ушла (или не дошла), закрываем её и готовим отчёт владельцу.
function finishSending(db) {
  const out = [];
  for (const b of db.prepare("SELECT * FROM broadcasts WHERE state='sending'").all()) {
    const like = `bc:${b.id}:%`;
    const wait = db.prepare('SELECT count(*) n FROM outbox WHERE dedup LIKE ? AND sent_at IS NULL AND failed IS NULL').get(like).n;
    if (wait) continue;
    const ok = db.prepare("SELECT count(DISTINCT chat_id) n FROM outbox WHERE dedup LIKE ? AND sent_at IS NOT NULL").get(like).n;
    const fail = Math.max(0, b.total - ok);
    db.prepare("UPDATE broadcasts SET state='done', ok=?, fail=? WHERE id=?").run(ok, fail, b.id);
    out.push({ id: b.id, ok, fail, total: b.total });
  }
  return out;
}

// Приветствие новичкам: один активный пост, state='welcome'. Уходит каждому, кто даёт согласие и разрешил писать.
const welcome = (db) => db.prepare("SELECT * FROM broadcasts WHERE state='welcome' ORDER BY id DESC LIMIT 1").get();
function setWelcome(db, id) {
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE broadcasts SET state='cancelled' WHERE state='welcome'").run();
    db.prepare("UPDATE broadcasts SET state='welcome' WHERE id=? AND kind='welcome'").run(id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function queueWelcome(db, uid, appUrl) {
  const w = welcome(db), u = db.prepare('SELECT can_dm FROM users WHERE id=?').get(uid);
  if (!w || !u || !u.can_dm) return false;
  postRows(w, appUrl, true).forEach((r, i) => enqueue(db, uid, r.text, r.kb, `wel:${w.id}:${uid}:${i}`, { kind: r.kind, media: r.media, ents: r.ents }));
  return true;
}

module.exports = { members, membersText, PAGE, welcome, setWelcome, queueWelcome, CAP, MAX_PICS, FOOT, plural, draft, audience, stats, statsText, notes, noteLine, parsePost, saveDraft, postRows, checkDraft, startSending, finishSending };
