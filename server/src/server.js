// Сервер Фриджа: мини-апп, API, бот (polling через мост или webhook), очередь сообщений, напоминания.
// Запуск: node --no-warnings src/server.js  (настройки берутся из переменных окружения, см. deploy/install.sh)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./db');
const { makeTg, enqueue, flush, buildCall } = require('./tg');
const C = require('./core');
const A = require('./admin');
const { loadToken, makeClaim } = require('./claim');

const cfg = {
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  MODE: process.env.MODE || 'polling',
  TG_API_ROOT: process.env.TG_API_ROOT || '',
  TG_RELAY_KEY: process.env.TG_RELAY_KEY || '',
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',
  SETUP_KEY: process.env.SETUP_KEY || '',
  DB_FILE: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'fridge.db'),
  PORT: Number(process.env.PORT || 8081),
  HOST: process.env.HOST || '127.0.0.1',
  TZ: process.env.TZ_NAME || 'Europe/Moscow',
  OWNER_INFO: process.env.OWNER_INFO || '',
  CONTACT: process.env.CONTACT || '',
  BOT_USERNAME: process.env.BOT_USERNAME || '',
  OWNER_ID: Number(process.env.OWNER_ID || 0) // Telegram-id владельца бота: ему доступны /send, /stats, заметки
};
cfg.BOT_TOKEN = loadToken(cfg); // из переменной окружения или из файла, сохранённого одноразовой страницей /claim

const db = open(cfg.DB_FILE);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const tg = makeTg(cfg, log);
const WEB = path.join(__dirname, '..', 'web');
const status = { lastTgOk: 0, lastTgErr: '', polling: false };

/* ---------- ответы ---------- */
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000'
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; " +
  'frame-ancestors https://web.telegram.org https://*.telegram.org';
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(data);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new C.HttpError(413, 'слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new C.HttpError(400, 'не JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------- ограничение частоты запросов (в памяти) ---------- */
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.t > windowMs) { hits.set(key, { t: now, n: 1 }); return false; }
  h.n++;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 120000) hits.delete(k); }, 60000).unref();

/* ---------- API мини-аппа ---------- */
const isOwner = (id) => !!cfg.OWNER_ID && id === cfg.OWNER_ID;
const full = (uid) => Object.assign(C.stateFor(db, uid), { bot: botUsername || 'friidge_bot', admin: isOwner(uid) });
function authUser(req) {
  const raw = req.headers['x-init-data'];
  const r = C.checkInitData(Array.isArray(raw) ? raw[0] : raw, cfg.BOT_TOKEN);
  if (!r) throw new C.HttpError(401, 'Открой Фридж из Telegram');
  return r;
}

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = req.method;
  const auth = authUser(req);
  const tgUser = auth.user;
  if (limited('u' + tgUser.id, 120, 60000)) throw new C.HttpError(429, 'Слишком часто. Подожди минуту.');
  const body = m === 'GET' || m === 'DELETE' ? {} : await readBody(req, /^\/members\/\d+\/photo$/.test(p) ? 220 * 1024 : undefined);
  const canDm = tgUser.allows_write_to_pm === true;

  // До согласия ничего не храним: только отвечаем, что оно нужно
  if (m === 'POST' && p === '/consent') {
    const had = !!(C.getUser(db, tgUser.id) || {}).consent_at;
    db.exec('BEGIN');
    try { C.upsertUser(db, tgUser, { consent: true, canDm }); C.ensureFridge(db, tgUser.id); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    if (!had) tellOwnerNew(tgUser.id);
    return send(res, 200, full(tgUser.id));
  }
  const u = C.getUser(db, tgUser.id);
  if (!u || !u.consent_at) return send(res, 200, { needConsent: true, name: String(tgUser.first_name || '').slice(0, 64) });
  C.upsertUser(db, tgUser, { canDm });
  const uid = tgUser.id;
  touchSeen(uid);

  if (m === 'GET' && p === '/state') return send(res, 200, full(uid));
  if (m === 'POST' && p === '/products') return send(res, 200, { ids: C.addProducts(db, uid, body.items) });
  let mm;
  if ((mm = p.match(/^\/products\/(\d+)$/))) {
    if (m === 'PATCH') { C.updateProduct(db, uid, mm[1], body); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { C.deleteProduct(db, uid, mm[1]); return send(res, 200, { ok: true }); }
  }
  // человек разрешил боту писать (Telegram.WebApp.requestWriteAccess): это касается только сообщений ему самому
  if (m === 'POST' && p === '/dm-allowed') { db.prepare('UPDATE users SET can_dm=1 WHERE id=?').run(uid); return send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/onboarded') { db.prepare('UPDATE users SET onboarded=1 WHERE id=?').run(uid); return send(res, 200, { ok: true }); }
  if (m === 'PATCH' && p === '/fridge') {
    const fid = C.ensureFridge(db, uid);
    if (body.name !== undefined) db.prepare('UPDATE fridges SET name=? WHERE id=?').run(C.str(body.name, 30, 'название') || 'Наш холодильник', fid);
    if (body.tpl !== undefined) {
      const t = C.str(body.tpl, 300, 'текст');
      if (!t.includes('{что}')) throw new C.HttpError(400, 'В тексте нет {что}: непонятно, что покупать');
      db.prepare('UPDATE fridges SET tpl=? WHERE id=?').run(t === C.DEFAULT_TPL ? null : t, fid);
    }
    return send(res, 200, { ok: true });
  }
  if (m === 'PATCH' && p === '/me/notify') {
    const on = body.on === undefined ? u.notify_on : body.on ? 1 : 0;
    const days = body.days === undefined ? u.notify_days : [1, 2, 3, 5].includes(Number(body.days)) ? Number(body.days) : 0;
    if (!days) throw new C.HttpError(400, 'дни');
    const okTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    let time = body.time === undefined ? u.notify_time : okTime(body.time) ? body.time : '';
    if (!time) throw new C.HttpError(400, 'время');
    let times = u.notify_times;
    if (body.times !== undefined) {
      const list = Array.isArray(body.times) ? [...new Set(body.times)].filter(okTime).sort() : [];
      if (list.length < 1 || list.length > 3 || list.length !== (Array.isArray(body.times) ? new Set(body.times).size : -1)) throw new C.HttpError(400, 'Время: от одного до трёх раз в день');
      times = JSON.stringify(list); time = list[0];
    } else if (body.time !== undefined) times = JSON.stringify([time]);
    let wd = u.notify_wd || '1111111';
    if (body.wd !== undefined) {
      if (typeof body.wd !== 'string' || !/^[01]{7}$/.test(body.wd) || !body.wd.includes('1')) throw new C.HttpError(400, 'Выбери хотя бы один день недели');
      wd = body.wd;
    }
    const always = body.always === undefined ? u.notify_always : body.always ? 1 : 0;
    const fzdays = body.fzdays === undefined ? (u.notify_fz_days || 14) : [7, 14, 30].includes(Number(body.fzdays)) ? Number(body.fzdays) : 0;
    if (!fzdays) throw new C.HttpError(400, 'дни для морозилки');
    db.prepare('UPDATE users SET notify_on=?, notify_days=?, notify_time=?, notify_times=?, notify_wd=?, notify_always=?, notify_fz_days=? WHERE id=?').run(on, days, time, times, wd, always, fzdays, uid);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/invite') {
    if (limited('inv' + uid, 10, 3600000)) throw new C.HttpError(429, 'Слишком много новых ссылок. Подожди час.');
    const token = C.newInvite(db, uid);
    return send(res, 200, { token, link: inviteLink(token) });
  }
  if (m === 'DELETE' && p === '/invite') { C.revokeInvites(db, uid); return send(res, 200, { ok: true }); }
  if ((mm = p.match(/^\/members\/(\d+)$/)) && m === 'DELETE') {
    const me = C.membership(db, uid), target = Number(mm[1]);
    if (!me || me.role !== 'owner') throw new C.HttpError(403, 'Убрать участника может только владелец');
    const t = C.membership(db, target);
    if (!t || t.fridge_id !== me.fridge_id || target === uid) throw new C.HttpError(404, 'нет такого участника');
    C.leaveFridge(db, target);
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/members\/(\d+)$/)) && m === 'PATCH') {
    const nick = C.setNick(db, uid, Number(mm[1]), body.nick);
    return send(res, 200, { ok: true, nick });
  }
  if ((mm = p.match(/^\/members\/(\d+)\/photo$/))) {
    if (m === 'GET') return send(res, 200, { photo: C.getPhoto(db, uid, Number(mm[1])) });
    if (m === 'PUT') {
      if (limited('ph' + uid, 30, 3600000)) throw new C.HttpError(429, 'Слишком много смен фото. Подожди час.');
      C.setPhoto(db, uid, Number(mm[1]), body.photo);
      return send(res, 200, { ok: true });
    }
  }
  if (p === '/admin' || p.startsWith('/admin/')) {
    if (!isOwner(uid)) throw new C.HttpError(404, 'нет такого адреса');
    try {
      if (m === 'GET' && p === '/admin') return send(res, 200, adminSnapshot());
      if (m === 'POST' && p === '/admin/notes') { const id = A.notes.add(db, body.text); return send(res, 200, { id }); }
      if ((mm = p.match(/^\/admin\/notes\/(\d+)$/))) {
        if (m === 'PATCH') { A.notes.edit(db, mm[1], body.text); return send(res, 200, { ok: true }); }
        if (m === 'DELETE') { A.notes.del(db, mm[1]); return send(res, 200, { ok: true }); }
      }
    } catch (e) { if (e instanceof C.HttpError) throw e; throw new C.HttpError(400, e.message); }
    throw new C.HttpError(404, 'нет такого адреса');
  }
  if (m === 'POST' && p === '/news-read') return send(res, 200, { read: C.markNewsRead(db, uid, body.ids) });
  if (m === 'POST' && p === '/leave') {
    const left = C.leaveFridge(db, uid);
    if (left && left.empty) db.prepare('DELETE FROM fridges WHERE id=?').run(left.fridgeId);
    C.ensureFridge(db, uid);
    return send(res, 200, full(uid));
  }
  if (m === 'POST' && p === '/asks') return send(res, 200, C.createAsk(db, uid, body, cfg));
  if (m === 'POST' && p === '/cats') { C.addCat(db, uid, body); return send(res, 200, { ok: true }); }
  if ((mm = p.match(/^\/cats\/(u[a-z0-9]{1,11})$/))) {
    if (m === 'PATCH') { C.updateCat(db, uid, mm[1], body); return send(res, 200, { ok: true }); }
    if (m === 'DELETE') { C.deleteCat(db, uid, mm[1]); return send(res, 200, { ok: true }); }
  }
  if (m === 'PUT' && p === '/me/cols') { C.setMyCols(db, uid, body.cols); return send(res, 200, { ok: true }); }
  if ((mm = p.match(/^\/asks\/(\d+)\/done$/)) && m === 'POST') { C.markAskDone(db, uid, mm[1]); return send(res, 200, { ok: true }); }
  if (m === 'DELETE' && p === '/me') {
    // Удалить свои данные: выходим из холодильника, стираем себя. Продукты общего холодильника остаются у семьи.
    const left = C.leaveFridge(db, uid);
    if (left && left.empty) db.prepare('DELETE FROM fridges WHERE id=?').run(left.fridgeId);
    db.prepare('DELETE FROM outbox WHERE chat_id=? AND sent_at IS NULL').run(uid);
    db.prepare('DELETE FROM users WHERE id=?').run(uid);
    return send(res, 200, { ok: true });
  }
  throw new C.HttpError(404, 'нет такого адреса');
}

/* ---------- бот ---------- */
let botUsername = cfg.BOT_USERNAME;
const inviteLink = (token) => `https://t.me/${botUsername || 'friidge_bot'}?start=inv_${token}`;
const appButton = (text = 'Открыть холодильник') => (cfg.PUBLIC_URL ? { inline_keyboard: [[{ text, web_app: { url: cfg.PUBLIC_URL } }]] } : null);
const say = (chatId, text, markup) => enqueue(db, chatId, text, markup, null);

function consentMessage(chatId, payload) {
  const kb = [[{ text: 'Согласен(на)', callback_data: 'agree' + (payload ? ':' + payload : '') }], [{ text: 'Не согласен(на)', callback_data: 'disagree' }]];
  if (cfg.PUBLIC_URL) kb.push([{ text: 'Политика и согласие', url: cfg.PUBLIC_URL + '/policy' }]);
  say(chatId, 'Привет! Я Фридж: помню, что лежит в холодильнике, и напоминаю, пока продукты не испортились.\n\n' +
    'Чтобы хранить твои продукты и присылать напоминания, мне нужно согласие на обработку данных: имя и Telegram-id. Подробности в политике по кнопке ниже.', { inline_keyboard: kb });
}

function afterJoin(uid, r) {
  const msgs = {
    joined: 'Готово, ты в общем холодильнике. Открывай 👇',
    already: 'Ты уже в этом холодильнике. Открывай 👇',
    used: 'Эта ссылка уже использована. Попроси прислать новую.',
    expired: 'Ссылка устарела: она работает 24 часа. Попроси прислать новую.',
    notfound: 'Такой ссылки нет. Попроси прислать новую.',
    bad: 'Ссылка сломана. Попроси прислать новую.'
  };
  say(uid, msgs[r.reason] || msgs.bad, r.ok ? appButton() : null);
  if (r.reason === 'joined' && r.inviter) {
    const inv = C.getUser(db, r.inviter);
    if (inv && inv.can_dm) say(r.inviter, `${C.displayName(db, uid)} теперь в вашем холодильнике.`, null);
  }
}

/* ---------- владелец: рассылка, статистика, заметки ---------- */
const seenAt = new Map();
function touchSeen(uid) {
  const now = Date.now();
  if (now - (seenAt.get(uid) || 0) < 10 * 60 * 1000) return;
  seenAt.set(uid, now);
  db.prepare("UPDATE users SET seen_at=datetime('now') WHERE id=?").run(uid);
}
function tellOwnerNew(uid) {
  if (!cfg.OWNER_ID || uid === cfg.OWNER_ID) return;
  const u = C.getUser(db, uid), total = db.prepare('SELECT count(*) n FROM users WHERE consent_at IS NOT NULL').get().n;
  enqueue(db, cfg.OWNER_ID, `Новый человек во Фридже: ${u ? u.first_name : uid}. Всего: ${total}.`, null, 'new:' + uid);
}
function adminSnapshot() {
  return {
    stats: A.stats(db),
    notes: A.notes.list(db),
    posts: db.prepare("SELECT id,substr(text,1,80) text,state,total,ok,fail,created_at FROM broadcasts WHERE state<>'cancelled' ORDER BY id DESC LIMIT 10").all()
  };
}

const ownerHelp = 'Команды владельца:\n\n/send текст — собрать пост для всех. Потом можно прислать до 10 картинок.\n/stats — кто присоединился\n/note текст — записать заметку\n/notes — все заметки, их можно править\n/whoami — твой Telegram id';
const sendHelp = 'Как отправить пост:\n\n1) /send и текст. Жирный, ссылки и курсив сохранятся.\n2) Потом пришли картинки, до 10 штук (можно альбомом).\n3) Нажми «Показать», проверь и подтверди.\n\nМожно сразу картинку с подписью, которая начинается с /send.';
const bcKb = [[{ text: 'Показать, как увидят люди', callback_data: 'bc:show' }], [{ text: 'Отменить черновик', callback_data: 'bc:no' }]];
const reply = (chatId, text, markup) => tg.call('sendMessage', Object.assign({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }, markup ? { reply_markup: markup } : {}));

function notesKb(list) {
  return { inline_keyboard: list.slice(0, 8).map((n) => [{ text: '✏️ #' + n.id, callback_data: 'nt:e:' + n.id }, { text: '🗑 #' + n.id, callback_data: 'nt:d:' + n.id }]) };
}
async function showNotes(chatId) {
  const list = A.notes.list(db);
  if (!list.length) return reply(chatId, 'Заметок пока нет. Запиши: /note текст');
  return reply(chatId, 'Заметки (' + list.length + '):\n\n' + list.slice(0, 20).map(A.noteLine).join('\n') + (list.length > 8 ? '\n\nКнопки есть у первых 8. Остальные правятся в приложении, раздел «Для владельца».' : ''), notesKb(list));
}
let lastGroup = '';

// Возвращает true, если сообщение разобрано как команда владельца
async function ownerMessage(msg) {
  const chatId = msg.chat.id, raw = String(msg.text || msg.caption || '');
  const editing = db.prepare("SELECT v FROM kv WHERE k='edit-note'").get();
  if (/^\/cancel/.test(raw)) { db.prepare("DELETE FROM kv WHERE k='edit-note'").run(); await reply(chatId, 'Хорошо, ничего не меняю.'); return true; }
  if (/^\/admin/.test(raw)) { await reply(chatId, ownerHelp); return true; }
  if (/^\/stats/.test(raw)) { await reply(chatId, A.statsText(A.stats(db))); return true; }
  if (/^\/notes/.test(raw)) { await showNotes(chatId); return true; }
  let mm = raw.match(/^\/note(?:@\w+)?\s+([\s\S]+)/);
  if (mm) { try { const id = A.notes.add(db, mm[1]); await reply(chatId, 'Записала заметку #' + id + '. Все заметки: /notes'); } catch (e) { await reply(chatId, e.message); } return true; }
  if (/^\/note(?:@\w+)?\s*$/.test(raw)) { await reply(chatId, 'Напиши заметку после команды: /note купить фильтр для воды'); return true; }
  if (editing && raw && !raw.startsWith('/')) {
    db.prepare("DELETE FROM kv WHERE k='edit-note'").run();
    try { A.notes.edit(db, editing.v, raw); await reply(chatId, 'Заметка #' + editing.v + ' обновлена.'); } catch (e) { await reply(chatId, e.message); }
    return true;
  }
  const isSend = /^\/send(@\w+)?(\s|$)/.test(raw);
  const d0 = A.draft(db);
  if (isSend || (msg.photo && d0)) {
    const post = A.parsePost(msg, isSend);
    if (isSend && !post.text && !post.pic) { await reply(chatId, sendHelp); return true; }
    if (!isSend && d0 && d0.text) { post.text = ''; post.ents = []; } // подпись к картинке не затирает уже написанный текст
    const d = A.saveDraft(db, post, isSend);
    if (d.full) { await reply(chatId, 'В посте уже ' + A.MAX_PICS + ' картинок, больше нельзя.'); return true; }
    const gid = msg.media_group_id || '';
    if (gid && gid === lastGroup) return true; // альбом приходит по одной картинке: отвечаем один раз
    lastGroup = gid;
    const n = JSON.parse(d.media).length;
    await reply(chatId, 'Черновик собран. Текст: ' + d.text.length + ' знаков, картинок: ' + n + '.\nМожно прислать ещё картинки, потом нажми «Показать».', bcKb);
    return true;
  }
  return false;
}

async function ownerCallback(q, d, answer) {
  const chatId = q.message.chat.id, mid = q.message.message_id;
  if (d === 'bc:show') {
    const b = A.draft(db);
    if (!b) { await answer('Черновика нет'); return reply(chatId, 'Черновика нет. Начни с /send'); }
    await answer();
    for (const r of A.postRows(b, cfg.PUBLIC_URL)) {
      const { method, body } = buildCall({ chat_id: chatId, text: r.text, markup: r.kb ? JSON.stringify(r.kb) : null, kind: r.kind, media: JSON.stringify(r.media), ents: r.ents.length ? JSON.stringify(r.ents) : null });
      await tg.call(method, body);
    }
    const chk = A.checkDraft(b), aud = A.audience(db, cfg.OWNER_ID);
    const L = ['Проверка перед отправкой', '', 'Текст: ' + (b.text ? b.text.length + ' знаков' : 'нет'), 'Картинок: ' + chk.media,
      'Получат: ' + aud.ids.length + ' ' + A.plural(aud.ids.length, 'человек', 'человека', 'человек'),
      'Не получат: ' + aud.skip + ' (не нажимали Старт или отключили рассылку)'];
    if (b.text.length > A.CAP && chk.media) L.push('Текст длиннее подписи, придёт отдельным сообщением под картинками.');
    chk.bad.forEach((x) => L.push('⚠️ ' + x));
    if (!aud.ids.length) L.push('⚠️ Отправлять некому.');
    const ok = !chk.bad.length && aud.ids.length;
    return reply(chatId, L.join('\n'), { inline_keyboard: (ok ? [[{ text: 'Отправить ' + aud.ids.length + ' ' + A.plural(aud.ids.length, 'человеку', 'людям', 'людям'), callback_data: 'bc:go:' + b.id }]] : []).concat([[{ text: 'Отменить', callback_data: 'bc:no' }]]) });
  }
  let mm;
  if ((mm = d.match(/^bc:go:(\d+)$/))) {
    const b = A.draft(db);
    if (!b || b.id !== Number(mm[1])) return answer('Этот черновик уже не актуален');
    await answer('Отправляю');
    tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } });
    const aud = A.startSending(db, b, cfg.OWNER_ID, cfg.PUBLIC_URL);
    return reply(chatId, 'Отправляю ' + aud.ids.length + ' ' + A.plural(aud.ids.length, 'человеку', 'людям', 'людям') + '. Когда всё уйдёт, пришлю отчёт.');
  }
  if (d === 'bc:no') {
    db.prepare("UPDATE broadcasts SET state='cancelled' WHERE state='draft'").run();
    tg.call('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] } });
    await answer('Отменено');
    return reply(chatId, 'Черновик отменён, никому ничего не ушло.');
  }
  if ((mm = d.match(/^nt:e:(\d+)$/))) {
    db.prepare("INSERT INTO kv(k,v) VALUES('edit-note',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(mm[1]);
    await answer();
    const n = db.prepare('SELECT text FROM notes WHERE id=?').get(Number(mm[1]));
    return reply(chatId, n ? 'Сейчас в заметке #' + mm[1] + ':\n\n' + n.text + '\n\nПришли новый текст одним сообщением. /cancel, чтобы не менять.' : 'Такой заметки уже нет.');
  }
  if ((mm = d.match(/^nt:d:(\d+)$/))) {
    await answer();
    return reply(chatId, 'Удалить заметку #' + mm[1] + '?', { inline_keyboard: [[{ text: 'Да, удалить', callback_data: 'nt:y:' + mm[1] }, { text: 'Нет', callback_data: 'cancel' }]] });
  }
  if ((mm = d.match(/^nt:y:(\d+)$/))) {
    A.notes.del(db, mm[1]);
    await answer('Удалено');
    return reply(chatId, 'Заметка #' + mm[1] + ' удалена.');
  }
  return false;
}

async function onUpdate(up) {
  try {
    if (up.message && up.message.chat && up.message.chat.type === 'private' && up.message.from) {
      const from = up.message.from, text = String(up.message.text || '');
      const u = C.getUser(db, from.id);
      if (/^\/whoami/.test(text)) return reply(from.id, 'Твой Telegram id: ' + from.id);
      if (/^\/news/.test(text) && u) {
        const off = u.news_off ? 0 : 1;
        db.prepare('UPDATE users SET news_off=? WHERE id=?').run(off, from.id);
        return reply(from.id, off ? 'Больше не буду присылать новости. Вернуть: снова /news.' : 'Хорошо, новости снова буду присылать.');
      }
      if (isOwner(from.id) && (await ownerMessage(up.message))) return;
      const mm = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
      if (mm) {
        const payload = mm[1] && /^inv_[\w-]{8,40}$/.test(mm[1]) ? mm[1] : '';
        if (!u || !u.consent_at) return consentMessage(from.id, payload);
        C.upsertUser(db, from, { canDm: true });
        if (payload) return afterJoin(from.id, C.joinByToken(db, from.id, payload.slice(4)));
        return say(from.id, 'Холодильник на месте. Открывай 👇', appButton());
      }
      if (!u || !u.consent_at) return consentMessage(from.id, '');
      if (/^\/stop/.test(text)) {
        db.prepare('UPDATE users SET can_dm=0, notify_on=0 WHERE id=?').run(from.id);
        return tg.call('sendMessage', { chat_id: from.id, text: 'Больше не пишу. Чтобы вернуть сообщения, нажми /start.' });
      }
      if (/^\/delete_me/.test(text)) {
        return say(from.id, 'Удалить все твои данные из Фриджа? Продукты общего холодильника останутся у семьи.',
          { inline_keyboard: [[{ text: 'Да, удалить', callback_data: 'delme' }], [{ text: 'Отмена', callback_data: 'cancel' }]] });
      }
      return say(from.id, 'Всё делается в приложении. Кнопка «Холодильник» внизу или тут 👇\n\n/stop — не присылать сообщения\n/delete_me — удалить мои данные', appButton());
    }
    if (up.callback_query) {
      const q = up.callback_query, uid = q.from.id, d = String(q.data || '');
      const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: q.id, text: text || '' });
      if (isOwner(uid) && /^(bc|nt):/.test(d) && q.message) return ownerCallback(q, d, answer);
      if (d === 'agree' || d.startsWith('agree:')) {
        const had = !!(C.getUser(db, uid) || {}).consent_at;
        C.upsertUser(db, q.from, { consent: true, canDm: true });
        if (!had) tellOwnerNew(uid);
        C.ensureFridge(db, uid);
        await answer('Спасибо!');
        const payload = d.slice(6);
        if (/^inv_[\w-]{8,40}$/.test(payload)) return afterJoin(uid, C.joinByToken(db, uid, payload.slice(4)));
        return say(uid, 'Готово. Открывай холодильник и добавь, что там лежит 👇', appButton());
      }
      if (d === 'disagree') { await answer(); return tg.call('sendMessage', { chat_id: uid, text: 'Понял. Без согласия я ничего не храню. Передумаешь — нажми /start.' }); }
      if (d === 'cancel') return answer('Отменено');
      if (d === 'delme') {
        const left = C.leaveFridge(db, uid);
        if (left && left.empty) db.prepare('DELETE FROM fridges WHERE id=?').run(left.fridgeId);
        db.prepare('DELETE FROM outbox WHERE chat_id=? AND sent_at IS NULL').run(uid);
        db.prepare('DELETE FROM users WHERE id=?').run(uid);
        await answer('Удалено');
        return tg.call('sendMessage', { chat_id: uid, text: 'Твои данные удалены.' });
      }
      const dm = d.match(/^done:(\d+)$/);
      if (dm) {
        try {
          const r = C.markAskDone(db, uid, dm[1]);
          await answer(r.already ? 'Уже отмечено' : 'Отметил: куплено');
          if (q.message) tg.call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: appButton() || { inline_keyboard: [] } });
        } catch (e) { await answer('Эта просьба уже не в твоём холодильнике'); }
        return;
      }
      return answer();
    }
    if (up.my_chat_member && up.my_chat_member.chat.type === 'private') {
      const st = up.my_chat_member.new_chat_member.status, uid = up.my_chat_member.chat.id;
      if (st === 'kicked') db.prepare('UPDATE users SET can_dm=0 WHERE id=?').run(uid);
    }
  } catch (e) { log('update error', e.message); }
}

async function pollLoop() {
  status.polling = true;
  const off = db.prepare("SELECT v FROM kv WHERE k='offset'").get();
  let offset = off ? Number(off.v) : 0;
  await tg.call('deleteWebhook', { drop_pending_updates: false });
  while (status.polling) {
    const r = await tg.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, 40000);
    if (!r.ok) { status.lastTgErr = r.description; if (r.error_code === 409) log('webhook ещё включён'); await new Promise((s) => setTimeout(s, 3000)); continue; }
    status.lastTgOk = Date.now();
    for (const up of r.result) {
      offset = up.update_id + 1;
      await onUpdate(up);
      db.prepare("INSERT INTO kv(k,v) VALUES('offset',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(offset));
    }
  }
}

/* ---------- страницы политики (черновик: текст проверяет юрист) ---------- */
function policyPage() {
  const owner = cfg.OWNER_INFO ? esc(cfg.OWNER_INFO) : '<b>[укажи оператора: ФИО, статус, ИНН]</b>';
  const contact = cfg.CONTACT ? esc(cfg.CONTACT) : '<b>[контакт для обращений]</b>';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Фридж: политика и согласие</title>
<style>body{font:16px/1.55 system-ui,-apple-system,sans-serif;max-width:680px;margin:0 auto;padding:24px 16px;color:#0B0D12;background:#fff}h1{font-size:24px}h2{font-size:18px;margin-top:28px}</style>
<h1>Политика обработки персональных данных и согласие</h1>
<p>Оператор: ${owner}. Контакт: ${contact}.</p>
<h2>Какие данные</h2><p>Telegram-id и имя из профиля Telegram; ник и фото, если вы сами их задали; продукты, сроки, просьбы купить и настройки напоминаний, которые вы вводите сами.</p>
<h2>Зачем</h2><p>Чтобы показывать содержимое холодильника вам и участникам вашей семьи, присылать напоминания о сроках и просьбы купить.</p>
<h2>Сообщения от оператора</h2><p>Иногда оператор присылает новости о сервисе. Отказаться можно в любой момент командой /news в боте.</p>
<h2>Где хранятся</h2><p>На сервере в Российской Федерации. Сообщения доставляются через Telegram.</p>
<h2>Сколько хранятся</h2><p>Пока вы пользуетесь сервисом. Удалить свои данные можно командой /delete_me в боте или написав оператору.</p>
<h2>Согласие</h2><p>Нажимая «Согласен(на)» в боте или в приложении, вы даёте согласие на обработку перечисленных данных для указанных целей. Согласие можно отозвать: /delete_me.</p>
</html>`;
}

/* ---------- HTTP ---------- */
let appHtml = null;
function loadApp() {
  const f = path.join(WEB, 'index.html');
  appHtml = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from('<p>Мини-апп не собран</p>');
}
loadApp();

async function doSetup() {
  const out = [];
  if (cfg.MODE === 'webhook') out.push(await tg.call('setWebhook', { url: cfg.PUBLIC_URL + '/tg', secret_token: cfg.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }));
  else out.push(await tg.call('deleteWebhook', {}));
  out.push(await tg.call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Холодильник', web_app: { url: cfg.PUBLIC_URL } } }));
  out.push(await tg.call('setMyCommands', { commands: [{ command: 'start', description: 'Открыть холодильник' }, { command: 'stop', description: 'Не присылать сообщения' }, { command: 'delete_me', description: 'Удалить мои данные' }] }));
  if (cfg.OWNER_ID) out.push(await tg.call('setMyCommands', { scope: { type: 'chat', chat_id: cfg.OWNER_ID }, commands: [{ command: 'start', description: 'Открыть холодильник' }, { command: 'send', description: 'Собрать пост для всех' }, { command: 'stats', description: 'Кто присоединился' }, { command: 'note', description: 'Записать заметку' }, { command: 'notes', description: 'Все заметки' }, { command: 'admin', description: 'Команды владельца' }] }));
  return out.map((r) => (r.ok ? 'ок' : 'ошибка: ' + r.description)).join('\n');
}

const claim = makeClaim(cfg, async (token, username, switchMenu) => {
  cfg.BOT_TOKEN = token;
  if (username) botUsername = username;
  startLoops();
  if (switchMenu && cfg.PUBLIC_URL) log('setup:', (await doSetup()).replace(/\n/g, ', '));
}, log);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (await claim.handle(req, res, url, send, readBody)) return;
    if (!cfg.BOT_TOKEN) {
      if (url.pathname === '/health') return send(res, 200, { ok: true, mode: 'waiting-token' });
      return send(res, 503, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px system-ui;padding:24px">Фридж ещё настраивается. Загляни через пару минут.</p>', 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
      return send(res, 200, appHtml, 'text/html; charset=utf-8', { 'content-security-policy': CSP });
    if (req.method === 'GET' && (url.pathname === '/policy' || url.pathname === '/consent'))
      return send(res, 200, policyPage(), 'text/html; charset=utf-8', { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    if (req.method === 'GET' && url.pathname === '/health') {
      const q = db.prepare('SELECT count(*) n FROM outbox WHERE sent_at IS NULL AND failed IS NULL').get().n;
      return send(res, 200, { ok: true, mode: cfg.MODE, queue: q, lastTelegramOk: status.lastTgOk ? new Date(status.lastTgOk).toISOString() : null });
    }
    if (req.method === 'GET' && url.pathname === '/setup') {
      const key = url.searchParams.get('key') || '';
      if (!cfg.SETUP_KEY || key.length !== cfg.SETUP_KEY.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.SETUP_KEY)))
        return send(res, 403, 'forbidden', 'text/plain');
      return send(res, 200, await doSetup(), 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/tg' && cfg.MODE === 'webhook') {
      const s = req.headers['x-telegram-bot-api-secret-token'] || '';
      if (!cfg.WEBHOOK_SECRET || s !== cfg.WEBHOOK_SECRET) return send(res, 403, 'forbidden', 'text/plain');
      const up = await readBody(req, 256 * 1024);
      send(res, 200, 'ok', 'text/plain');
      return onUpdate(up);
    }
    send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    const st = e.status || 500;
    if (st === 500) log('error', req.method, url.pathname, e.stack || e);
    if (!res.headersSent) send(res, st, { error: st === 500 ? 'Что-то сломалось на сервере. Попробуй ещё раз.' : e.message });
  }
});

/* ---------- фоновые задачи ---------- */
let started = false;
function startLoops() {
  if (started) return;
  started = true;
  setInterval(() => { flush(db, tg).catch((e) => log('flush', e.message)); }, 5000);
  setInterval(() => { try { C.queueReminders(db, cfg); } catch (e) { log('reminders', e.message); } }, 60000);
  setInterval(() => {
    try {
      for (const r of A.finishSending(db)) {
        if (cfg.OWNER_ID) enqueue(db, cfg.OWNER_ID, `Рассылка закончена.\nДоставлено: ${r.ok} из ${r.total}.` + (r.fail ? `\nНе дошло: ${r.fail} (заблокировали бота или Telegram не ответил).` : ''), null, 'bcdone:' + r.id);
      }
    } catch (e) { log('broadcast', e.message); }
  }, 60000);
  setInterval(() => { // уборка: отправленное старше 30 дней и использованные/просроченные приглашения
    db.prepare("DELETE FROM outbox WHERE (sent_at IS NOT NULL OR failed IS NOT NULL) AND created_at<?").run(Date.now() - 30 * 86400000);
    db.prepare('DELETE FROM invites WHERE expires_at<?').run(Date.now() - 7 * 86400000);
  }, 3600000);
  if (cfg.MODE === 'polling') pollLoop().catch((e) => log('poll', e.message));
}

if (require.main === module) {
  server.listen(cfg.PORT, cfg.HOST, async () => {
    log(`Фридж слушает ${cfg.HOST}:${cfg.PORT}, режим ${cfg.MODE}`);
    if (!cfg.BOT_TOKEN) { log('жду токен на странице /claim'); return; }
    if (!botUsername) { const r = await tg.call('getMe', {}); if (r.ok) botUsername = r.result.username; }
    startLoops();
  });
}

module.exports = { server, db, cfg, onUpdate, startLoops, status, loadApp, claim };
