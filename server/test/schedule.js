// Расписание напоминаний: дни недели, несколько времён, режим «всегда». Запуск: node --no-warnings test/schedule.js
'use strict';
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const C = require('../src/core');

let n = 0; const ok = (t) => console.log('  ✓ ' + String(++n).padStart(2) + ' ' + t);
const db = open(':memory:');
const mk = (id, name) => { C.upsertUser(db, { id, first_name: name }, { consent: true, canDm: true }); C.ensureFridge(db, id); };
mk(1, 'Каролина');
const cfg = { TZ: 'Europe/Moscow', PUBLIC_URL: 'http://x' };
// 2026-11-04 — среда. Москва = UTC+3, поэтому 09:00 МСК = 06:00 UTC.
const msk = (date, hh, mm = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + ((hh - 3) * 60 + mm) * 60000);
const set = (o) => db.prepare('UPDATE users SET notify_on=?, notify_days=?, notify_time=?, notify_times=?, notify_wd=?, notify_always=? WHERE id=1')
  .run(o.on ?? 1, o.days ?? 3, o.times ? o.times[0] : '09:00', o.times ? JSON.stringify(o.times) : null, o.wd ?? '1111111', o.always ?? 0);
const outbox = () => db.prepare("SELECT dedup FROM outbox WHERE chat_id=1 AND dedup LIKE 'rem:%'").all().map((r) => r.dedup);
const clear = () => db.prepare('DELETE FROM outbox').run();
C.addProducts(db, 1, [{ name: 'Творог', e: '🥛', c: 'dairy', q: 200, u: 'г', exp: '2026-11-05' }]);

set({ times: ['09:00'] });
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 8, 59)), 0); ok('до назначенного времени ничего не ставится');
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 1); ok('в 09:00 ставится сводка');
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 1)), 0); ok('второй раз в тот же день — нет');
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 12, 5)), 0); ok('окно 3 часа закрылось, повтора нет');

clear(); set({ times: ['09:00', '18:00'] });
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 1);
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 18, 0)), 1);
assert.deepEqual(outbox().sort(), ['rem:1:2026-11-04:09:00', 'rem:1:2026-11-04:18:00']); ok('два времени в день — два сообщения');

clear(); set({ times: ['09:00', '10:00'] });
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 10, 5)), 1);
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 10, 6)), 1); ok('при сбое сервера две просроченные отметки не слипаются в одно сообщение за проход');

clear(); set({ wd: '1111100', times: ['09:00'] }); // будни
assert.equal(C.queueReminders(db, cfg, msk('2026-11-07', 9, 0)), 0); ok('в субботу при расписании «будни» молчим');
assert.equal(C.queueReminders(db, cfg, msk('2026-11-06', 9, 0)), 1); ok('в пятницу пишем');

clear(); set({ wd: '1000000', times: ['09:00'] }); // только понедельник
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 0); assert.equal(C.queueReminders(db, cfg, msk('2026-11-09', 9, 0)), 1); ok('раз в неделю — только в понедельник');

clear(); set({ wd: '0000001', times: ['09:00'] }); // только воскресенье
assert.equal(C.queueReminders(db, cfg, msk('2026-11-08', 9, 0)), 1); ok('воскресенье считается седьмым днём, а не нулевым');

// режим «всегда» и тишина
clear(); set({ times: ['09:00'], days: 1 }); db.prepare('DELETE FROM products').run();
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 0); ok('ничего не портится и режим «только срочное» — тишина');
set({ times: ['09:00'], days: 1, always: 1 });
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 1);
const text = db.prepare("SELECT text FROM outbox WHERE chat_id=1 AND dedup LIKE 'rem:%'").get().text;
assert.match(text, /Всё свежее\. Ближайшие 1 день ничего не портится/); ok('режим «всегда»: приходит спокойное сообщение');

clear(); set({ on: 0, times: ['09:00'] });
assert.equal(C.queueReminders(db, cfg, msk('2026-11-04', 9, 0)), 0); ok('выключено — не пишем');

// старая запись без notify_times
clear(); db.prepare('UPDATE users SET notify_on=1, notify_times=NULL, notify_time=? WHERE id=1').run('10:30');
assert.deepEqual(C.notifyTimes(db.prepare('SELECT * FROM users WHERE id=1').get()), ['10:30']); ok('старые пользователи: время берётся из прежнего поля');
const st = C.stateFor(db, 1).me.notify;
assert.deepEqual(st.times, ['10:30']); assert.equal(st.wd.length, 7); ok('в состоянии для приложения есть times и wd');
console.log('\nВсе ' + n + ' проверок прошли');
