// v1.3: морозилка, свои категории и цвета, личный список покупок. Запуск: node --no-warnings test/v13.js
'use strict';
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const C = require('../src/core');

let n = 0; const ok = (t) => console.log('  ✓ ' + String(++n).padStart(2) + ' ' + t);
const throws = (fn, re) => assert.throws(fn, (e) => e instanceof C.HttpError && (!re || re.test(e.message)));
const db = open(':memory:');
const mk = (id, name) => { C.upsertUser(db, { id, first_name: name }, { consent: true, canDm: true }); C.ensureFridge(db, id); };
mk(1, 'Каролина'); mk(2, 'Маша');
const S = () => C.stateFor(db, 1);

// --- морозилка и цвет у продукта
const [pid] = C.addProducts(db, 1, [{ name: 'Пельмени', e: '🥟', c: 'meat', q: 1, u: 'шт', exp: '2027-02-01', fz: true, col: '#E86F51' }]);
let p = S().products.find((x) => x.id === pid);
assert.equal(p.fz, true); assert.equal(p.col, '#E86F51'); ok('продукт хранит fz и цвет #RRGGBB');
const [pid2] = C.addProducts(db, 1, [{ name: 'Молоко', c: 'dairy', q: 1, u: 'л', exp: '2026-11-10' }]);
p = S().products.find((x) => x.id === pid2);
assert.equal(p.fz, false); assert.equal(p.col, null); ok('по умолчанию не в морозилке и без цвета');
C.updateProduct(db, 1, pid2, { fz: true, exp: '2027-02-05' });
p = S().products.find((x) => x.id === pid2);
assert.equal(p.fz, true); assert.equal(p.exp, '2027-02-05'); ok('перенос в морозилку меняет fz и срок');
C.updateProduct(db, 1, pid2, { fz: false, exp: '2026-11-07' });
assert.equal(S().products.find((x) => x.id === pid2).fz, false); ok('«достать» возвращает в холодильник');
C.updateProduct(db, 1, pid2, { name: 'Молоко 3,2%' });
assert.equal(S().products.find((x) => x.id === pid2).fz, false); ok('правка названия не сбрасывает fz');
throws(() => C.addProducts(db, 1, [{ name: 'Х', c: 'other', q: 1, u: 'шт', col: 'red;drop' }]), /цвет/); ok('мусор вместо цвета отклонён');
throws(() => C.addProducts(db, 1, [{ name: 'Х', c: 'other', q: 1, u: 'шт', col: '<img>' }]), /цвет/); ok('разметка вместо цвета отклонена');
C.addProducts(db, 1, [{ name: 'Хлеб', c: 'other', q: 1, u: 'шт', col: 'cream' }]);
assert.ok(S().products.some((x) => x.col === 'cream')); ok('цвет из палитры по id принимается');

// --- свои категории
C.addCat(db, 1, { id: 'ucat1', n: 'Для кота', e: '🐈', col: '#7C5CFF', mode: 'emoji' });
let cats = S().cats;
assert.equal(cats.length, 1); assert.equal(cats[0].n, 'Для кота'); assert.equal(cats[0].mode, 'emoji'); ok('своя категория создаётся и приходит в состоянии');
const [pc] = C.addProducts(db, 1, [{ name: 'Корм', c: 'ucat1', q: 1, u: 'шт' }]);
assert.equal(S().products.find((x) => x.id === pc).c, 'ucat1'); ok('продукт можно положить в свою категорию');
const [pz] = C.addProducts(db, 1, [{ name: 'Чужой', c: 'uzzzz', q: 1, u: 'шт' }]);
assert.equal(S().products.find((x) => x.id === pz).c, 'other'); ok('несуществующая своя категория превращается в «Другое»');
throws(() => C.addCat(db, 1, { id: 'Bad id', n: 'X', col: '#112233' }), /id/); ok('кривой id категории отклонён');
throws(() => C.addCat(db, 1, { id: 'ucat2', n: '', col: '#112233' }), /название/); ok('пустое имя категории отклонено');
throws(() => C.addCat(db, 1, { id: 'ucat2', n: 'Х', col: 'zzz zzz' }), /цвет/); ok('кривой цвет категории отклонён');
throws(() => C.addCat(db, 1, { id: 'ucat2', n: '<b onclick=x>', col: '#112233' }), /символ/); ok('разметка в названии категории отклонена');
throws(() => C.addCat(db, 1, { id: 'ucat2', n: 'Ок', e: '<b>', mode: 'emoji', col: '#112233' }), /символ/); ok('разметка в эмодзи категории отклонена');
const [pe] = C.addProducts(db, 1, [{ name: 'Тест', e: '<b>', c: 'other', q: 1, u: 'шт' }]);
assert.equal(S().products.find((x) => x.id === pe).e, '📦'); ok('разметка в значке продукта заменяется на коробку');
C.updateCat(db, 1, 'ucat1', { n: 'Коты', mode: 'color' });
cats = S().cats; assert.equal(cats[0].n, 'Коты'); assert.equal(cats[0].mode, 'color'); assert.equal(cats[0].col, '#7C5CFF'); ok('категорию можно переименовать, остальное сохраняется');
assert.equal(C.stateFor(db, 2).cats.length, 0); ok('чужой холодильник своих категорий не видит');
for (let i = 2; i <= 30; i++) C.addCat(db, 1, { id: 'ux' + i, n: 'К' + i, col: '#112233' });
throws(() => C.addCat(db, 1, { id: 'uxover', n: 'К', col: '#112233' }), /много/); ok('больше 30 категорий нельзя');
C.deleteCat(db, 1, 'ucat1');
assert.equal(S().products.find((x) => x.id === pc).c, 'other'); assert.ok(!S().cats.some((c) => c.id === 'ucat1')); ok('удаление категории переносит продукты в «Другое»');

// --- «Мои цвета»
C.setMyCols(db, 1, ['#aabbcc', '#AABBCC', '#112233']);
assert.deepEqual(S().me.myCols, ['#AABBCC', '#112233']); ok('«Мои цвета» сохраняются без повторов');
throws(() => C.setMyCols(db, 1, ['red']), /цвета/); ok('цвет не в формате HEX отклонён');
throws(() => C.setMyCols(db, 1, Array.from({ length: 13 }, (_, i) => '#00000' + (i % 10))), /цвета/); ok('больше 12 цветов нельзя');

// --- личный список покупок (без получателей)
const a = C.createAsk(db, 1, { to: [], name: 'Яйца', q: 10, u: 'шт' }, { PUBLIC_URL: '' });
assert.ok(a.id); assert.deepEqual(a.queued, []); ok('просьба без получателей сохраняется, сообщений нет');
assert.equal(S().asks.filter((x) => x.name === 'Яйца').length, 1);
assert.deepEqual(S().asks.find((x) => x.name === 'Яйца').to_ids, []); ok('в состоянии у неё пустой список получателей');
assert.equal(C.markAskDone(db, 1, a.id).already, false);
assert.equal(db.prepare("SELECT count(*) n FROM outbox WHERE dedup LIKE 'done:%'").get().n, 0); ok('отметка «куплено» у личной просьбы никому не пишет');
for (let i = 0; i < 25; i++) C.createAsk(db, 1, { to: [], name: 'Личное ' + i, q: 1, u: 'шт' }, {});
ok('личные пункты не упираются в лимит 20 просьб в час');
throws(() => C.createAsk(db, 1, { to: [1], name: 'Себе', q: 1, u: 'шт' }, {}), /кому/); ok('получатель «я сам» по-прежнему отклоняется');
throws(() => C.createAsk(db, 1, { to: [999], name: 'Чужому', q: 1, u: 'шт' }, {}), /кому/); ok('чужой человек как получатель отклонён');

// --- напоминания: у морозилки своё окно, срок там не тревога
const today = '2026-11-05';
const prods = [
  { name: 'Творог', e: '🥛', exp: '2026-11-04', fz: 0 },
  { name: 'Фарш', e: '🥩', exp: '2026-11-15', fz: 1 },
  { name: 'Ягоды', e: '🍓', exp: '2027-03-01', fz: 1 },
  { name: 'Пельмени', e: '🥟', exp: '2026-11-01', fz: 1 }
];
let t = C.digestText(prods, today, 3, 14);
assert.ok(t.includes('Просрочено, проверь:\n🥛 Творог')); ok('в холодильнике просрочка по-прежнему тревожная');
assert.ok(t.includes('В морозилке пора доесть:')); assert.ok(t.includes('🥩 Фарш, через 10 дней')); ok('фарш в окне 14 дней попадает в сводку морозилки');
assert.ok(!t.includes('Ягоды')); ok('ягоды через 4 месяца не беспокоят');
assert.ok(t.includes('🥟 Пельмени, срок вышел')); assert.ok(!t.split('Просрочено, проверь:')[1].split('\n\n')[0].includes('Пельмени')); ok('вышедший срок в морозилке без слова «просрочено»');
t = C.digestText(prods, today, 3, 7);
assert.ok(!t.includes('Фарш')); ok('окно морозилки 7 дней: фарш через 10 дней молчит');
t = C.digestText([{ name: 'Ягоды', e: '🍓', exp: '2027-03-01', fz: 1 }], today, 3, 14);
assert.equal(t, null); ok('если нечего сказать, сводки нет');
assert.equal(C.digestText([{ name: 'Молоко', e: '🥛', exp: '2026-11-06', fz: 0 }], today, 3), 'Скоро испортится:\n🥛 Молоко, завтра'); ok('старый вызов digestText без окна морозилки работает как раньше');
const defs = C.stateFor(db, 1).me.notify;
assert.equal(defs.fzdays, 14); ok('по умолчанию предупреждаем о морозилке за 14 дней');
db.prepare('UPDATE users SET notify_fz_days=30 WHERE id=1').run();
assert.equal(C.stateFor(db, 1).me.notify.fzdays, 30); ok('своё окно морозилки приходит в состоянии');

console.log(`\nВсе ${n} проверок прошли`);
