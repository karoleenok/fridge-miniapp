// Новое: срок годности от даты производства, ник и фото, новости, рассылка, статистика, заметки. Запуск: node --no-warnings test/features.js
'use strict';
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const C = require('../src/core');
const A = require('../src/admin');
const { enqueue, flush, buildCall } = require('../src/tg');

let n = 0; const ok = (t) => console.log('  ✓ ' + String(++n).padStart(2) + ' ' + t);
const db = open(':memory:');
const mkUser = (id, name, dm = 1) => { C.upsertUser(db, { id, first_name: name }, { consent: true, canDm: !!dm }); C.ensureFridge(db, id); };
mkUser(1, 'Каролина'); mkUser(2, 'Маша'); mkUser(3, 'Антон', 0);
const tok = C.newInvite(db, 1); C.joinByToken(db, 2, tok);

// ---- срок годности
assert.equal(C.calcExp('2026-01-31', 1, 'мес'), '2026-02-28'); ok('31 января + 1 месяц = конец февраля');
assert.equal(C.calcExp('2024-01-31', 1, 'мес'), '2024-02-29'); ok('в високосный год — 29 февраля');
assert.equal(C.calcExp('2026-11-04', 14, 'д'), '2026-11-18'); ok('14 дней');
assert.equal(C.calcExp('2026-11-04', 2, 'нед'), '2026-11-18'); ok('2 недели');
assert.equal(C.calcExp('2026-11-04', 1, 'год'), '2027-11-04'); ok('1 год');
const today = new Date().toISOString().slice(0, 10);
const [id1] = C.addProducts(db, 1, [{ name: 'Йогурт', e: '🥛', c: 'dairy', made: today, sn: 21, su: 'д', exp: '1999-01-01', q: 1, u: 'шт' }]);
let st = C.stateFor(db, 1);
let y = st.products.find((p) => p.id === id1);
assert.equal(y.exp, C.calcExp(today, 21, 'д')); assert.equal(y.made, today); assert.equal(y.sn, 21); assert.equal(y.su, 'д');
ok('«годен до» считает сервер, а не верит присланному');
C.updateProduct(db, 1, id1, { name: 'Йогурт греческий' });
y = C.stateFor(db, 1).products.find((p) => p.id === id1);
assert.equal(y.made, today); assert.equal(y.exp, C.calcExp(today, 21, 'д')); ok('правка названия не теряет дату производства');
C.updateProduct(db, 1, id1, { exp: '2027-05-05', made: null, sn: null, su: null });
y = C.stateFor(db, 1).products.find((p) => p.id === id1);
assert.equal(y.exp, '2027-05-05'); assert.equal(y.made, null); assert.equal(y.sn, null); ok('можно вернуться к простой дате «годен до»');
C.updateProduct(db, 1, id1, { exp: '2027-06-06' });
assert.equal(C.stateFor(db, 1).products.find((p) => p.id === id1).exp, '2027-06-06'); ok('смена только exp работает как раньше');
assert.throws(() => C.addProducts(db, 1, [{ name: 'X', made: today, sn: 0, su: 'д', q: 1, u: 'шт' }]), /срок годности/); ok('срок 0 отклонён');
assert.throws(() => C.addProducts(db, 1, [{ name: 'X', made: today, sn: 5, su: 'век', q: 1, u: 'шт' }]), /срок годности/); ok('чужая единица отклонена');
assert.throws(() => C.addProducts(db, 1, [{ name: 'X', made: '2999-01-01', sn: 5, su: 'д', q: 1, u: 'шт' }]), /будущем/); ok('производство в будущем отклонено');
assert.throws(() => C.addProducts(db, 1, [{ name: 'X', made: today, sn: 99999, su: 'д', q: 1, u: 'шт' }]), /срок годности/); ok('нелепо большой срок отклонён');
const [id2] = C.addProducts(db, 1, [{ name: 'Яблоки', exp: '2026-12-01', q: 1, u: 'кг' }]);
assert.equal(C.stateFor(db, 1).products.find((p) => p.id === id2).made, null); ok('продукт без производства работает как раньше');

// ---- ник и фото
const jpeg = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 1), Buffer.from([0xff, 0xd9])]).toString('base64');
assert.equal(C.setNick(db, 2, 2, '  Мамуля  '), 'Мамуля'); ok('свой ник');
assert.equal(C.stateFor(db, 1).members.find((m) => m.id === 2).name, 'Мамуля'); ok('ник виден в семье');
assert.equal(C.stateFor(db, 1).members.find((m) => m.id === 2).tgName, 'Маша'); ok('имя из Telegram тоже отдаём');
assert.throws(() => C.setNick(db, 2, 1, 'Босс'), /владелец/); ok('участник не меняет чужой ник');
assert.equal(C.setNick(db, 1, 2, 'Мама'), 'Мама'); ok('владелец может поправить ник участника');
assert.throws(() => C.setNick(db, 1, 3, 'Ты'), /нет такого/); ok('чужой холодильник недоступен');
assert.throws(() => C.setNick(db, 2, 2, 'x'.repeat(25)), /24/); ok('длинный ник отклонён');
assert.equal(C.setNick(db, 2, 2, 'a<b>\u0007c'), 'abc'); ok('угловые скобки и управляющие знаки вычищаются');
C.setNick(db, 2, 2, 'Мамуля');
const jobs = []; const tgStub = { call: async (m, b) => { jobs.push([m, b]); return { ok: true }; } };
C.setPhoto(db, 2, 2, jpeg); assert.equal(C.stateFor(db, 1).members.find((m) => m.id === 2).photoV, 1); ok('фото сохранилось, версия 1');
assert.equal(C.getPhoto(db, 1, 2), jpeg); ok('фото отдаётся участнику той же семьи');
assert.throws(() => C.getPhoto(db, 3, 2), /нет такого/); ok('чужой семье фото не отдаётся');
assert.throws(() => C.setPhoto(db, 2, 2, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), /JPEG/); ok('SVG вместо фото отклонён');
assert.throws(() => C.setPhoto(db, 2, 2, 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>'.repeat(20)).toString('base64')), /фотография/); ok('не-JPEG под видом JPEG отклонён');
assert.throws(() => C.setPhoto(db, 2, 2, 'data:image/jpeg;base64,' + 'A'.repeat(200000)), /JPEG/); ok('слишком большое фото отклонено');
C.setPhoto(db, 2, 2, null); assert.equal(C.stateFor(db, 1).members.find((m) => m.id === 2).photoV, 0); ok('фото можно убрать');

// ---- ник в сообщениях бота
const out = db.prepare('SELECT * FROM outbox');
C.createAsk(db, 2, { to: [1], name: 'Молоко', q: 2, u: 'шт', note: '' }, { PUBLIC_URL: '' });
assert.match(db.prepare('SELECT text FROM outbox ORDER BY id DESC').get().text, /^Мамуля просит/); ok('в просьбе «купить» стоит ник, а не имя из Telegram');
C.setNick(db, 2, 2, ''); C.createAsk(db, 2, { to: [1], name: 'Сыр', q: 1, u: 'шт', note: '' }, { PUBLIC_URL: '' });
assert.match(db.prepare('SELECT text FROM outbox ORDER BY id DESC').get().text, /^Маша просит/); ok('пустой ник возвращает имя из Telegram');
C.setNick(db, 2, 2, 'Мамуля');
assert.equal(C.displayName(db, 2), 'Мамуля'); ok('displayName');
const ask = db.prepare('SELECT id FROM asks ORDER BY id DESC').get().id;
C.markAskDone(db, 1, ask);
assert.ok(db.prepare("SELECT 1 FROM outbox WHERE dedup=?").get('done:' + ask)); ok('ответ «куплено» создан');

// ---- новости
assert.deepEqual(C.markNewsRead(db, 1, ['a', 'b']), ['a', 'b']); assert.deepEqual(C.markNewsRead(db, 1, ['b', 'c']), ['a', 'b', 'c']);
assert.deepEqual(C.stateFor(db, 1).me.newsRead, ['a', 'b', 'c']); ok('прочитанные новости копятся без повторов');
assert.throws(() => C.markNewsRead(db, 1, ['<x>']), /новости/); ok('мусор вместо id новости отклонён');

// ---- заметки
const nid = A.notes.add(db, ' купить фильтр '); A.notes.edit(db, nid, 'купить два фильтра');
assert.equal(A.notes.list(db)[0].text, 'купить два фильтра'); ok('заметка добавляется и правится');
assert.throws(() => A.notes.add(db, '   '), /Пустая/); ok('пустая заметка отклонена');
A.notes.del(db, nid); assert.equal(A.notes.list(db).length, 0); ok('заметка удаляется');

// ---- статистика
const s = A.stats(db);
assert.equal(s.total, 3); assert.equal(s.botCanWrite, 2); assert.equal(s.families, 1); assert.equal(s.days.length, 7);
assert.equal(s.days[6].n, 3); ok('статистика: всего, можно писать, семьи, по дням');
assert.match(A.statsText(s), /Каролина/); ok('текст статистики со списком последних');

// ---- рассылка
db.prepare('UPDATE users SET news_off=1 WHERE id=2').run();
let aud = A.audience(db, 1);
assert.deepEqual(aud.ids, []); assert.equal(aud.skip, 2); ok('получатели: без Старта и без отказавшихся');
db.prepare('UPDATE users SET news_off=0 WHERE id=2').run();
aud = A.audience(db, 1); assert.deepEqual(aud.ids, [2]); ok('вернулся в рассылку');
const post = A.parsePost({ text: '/send Привет, *всем*', entities: [{ type: 'bot_command', offset: 0, length: 5 }, { type: 'bold', offset: 14, length: 5 }] }, true);
assert.equal(post.text, 'Привет, *всем*'); assert.equal(post.ents.length, 1); assert.equal(post.ents[0].offset, 8); ok('команда вырезана, форматирование сдвинуто');
let d = A.saveDraft(db, post, true);
d = A.saveDraft(db, { text: '', ents: [], pic: 'F1' }, false); d = A.saveDraft(db, { text: '', ents: [], pic: 'F2' }, false);
assert.deepEqual(JSON.parse(d.media), ['F1', 'F2']); assert.equal(d.text, 'Привет, *всем*'); ok('картинки приклеиваются к тексту');
for (let i = 0; i < 12; i++) d = A.saveDraft(db, { text: '', ents: [], pic: 'X' + i }, false);
assert.equal(JSON.parse(A.draft(db).media).length, 10); ok('больше десяти картинок не берём');
let rows = A.postRows(A.draft(db), 'https://f.example');
assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'album'); assert.ok(rows[0].text.endsWith('/news')); ok('короткий текст уходит подписью к альбому');
const long = { ...A.draft(db), text: 'a'.repeat(1100) };
rows = A.postRows(long, 'https://f.example'); assert.equal(rows.length, 2); assert.equal(rows[0].text, ''); assert.equal(rows[1].kind, 'text'); ok('длинный текст идёт отдельным сообщением под картинками');
const chkBad = A.checkDraft({ text: '', media: '[]' }); assert.equal(chkBad.bad.length, 1); ok('проверка: пустой пост не пропускается');
const one = { ...A.draft(db), media: '["P1"]' };
const call = buildCall({ chat_id: 5, text: 'Подпись', markup: null, kind: 'photo', media: '["P1"]', ents: JSON.stringify([{ type: 'bold', offset: 0, length: 3 }]) });
assert.equal(call.method, 'sendPhoto'); assert.equal(call.body.photo, 'P1'); assert.equal(call.body.caption_entities.length, 1); ok('одна картинка: sendPhoto с форматированием подписи');
const album = buildCall({ chat_id: 5, text: 'Подпись', markup: null, kind: 'album', media: '["A","B"]', ents: null });
assert.equal(album.method, 'sendMediaGroup'); assert.equal(album.body.media.length, 2); assert.equal(album.body.media[0].caption, 'Подпись'); assert.equal(album.body.media[1].caption, undefined); ok('альбом: подпись только у первой');
db.prepare('DELETE FROM outbox').run();
const b = A.draft(db);
const started = A.startSending(db, b, 1, 'https://f.example');
assert.equal(started.ids.length, 1); assert.equal(db.prepare("SELECT state FROM broadcasts WHERE id=?").get(b.id).state, 'sending'); ok('рассылка встала в очередь');
assert.equal(A.finishSending(db).length, 0); ok('пока очередь не ушла, отчёта нет');
(async () => {
  const calls = []; const stub = { call: async (m, bd) => { calls.push([m, bd]); return { ok: true }; } };
  await flush(db, stub);
  assert.equal(calls[0][0], 'sendMediaGroup'); ok('очередь отправила альбом');
  const rep = A.finishSending(db);
  assert.equal(rep.length, 1); assert.equal(rep[0].ok, 1); assert.equal(rep[0].fail, 0); ok('отчёт: доставлено 1 из 1');
  assert.equal(A.finishSending(db).length, 0); ok('отчёт приходит один раз');
  // повторная отправка тому же человеку невозможна (dedup)
  assert.equal(enqueue(db, 2, 'x', null, `bc:${b.id}:2:0`), false); ok('дубль рассылки не создаётся');
  // миграция уже работающей базы: колонок нет, данные есть
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fr-')), 'old.db');
  let d1 = open(f);
  d1.prepare("INSERT INTO users(id,first_name,consent_at) VALUES(7,'Старый',datetime('now'))").run();
  d1.exec("ALTER TABLE products DROP COLUMN made; ALTER TABLE products DROP COLUMN shelf_n; ALTER TABLE products DROP COLUMN shelf_u; ALTER TABLE members DROP COLUMN nick; ALTER TABLE members DROP COLUMN photo; ALTER TABLE members DROP COLUMN photo_v; ALTER TABLE users DROP COLUMN news_read; ALTER TABLE users DROP COLUMN news_off; ALTER TABLE users DROP COLUMN seen_at; ALTER TABLE outbox DROP COLUMN kind; ALTER TABLE outbox DROP COLUMN media; ALTER TABLE outbox DROP COLUMN ents;");
  d1.close();
  d1 = open(f);
  assert.equal(d1.prepare('SELECT first_name FROM users WHERE id=7').get().first_name, 'Старый');
  assert.ok(d1.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'shelf_n'));
  assert.ok(d1.prepare('PRAGMA table_info(members)').all().some((c) => c.name === 'photo_v'));
  open(f).close(); // второй запуск ничего не ломает
  ok('миграция: старая база получила новые колонки, данные целы, повторный запуск безопасен');
  console.log('\nВсе ' + n + ' проверок прошли');
})().catch((e) => { console.error('✗', e); process.exit(1); });
