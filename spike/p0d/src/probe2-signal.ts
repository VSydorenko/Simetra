// Проба 2: сигнал команди → мапінг ключів → перечитування через PostgREST;
// приватний канал на скоуп з RLS на realtime.messages; broadcast-тригер
// прийнятої таблиці тим самим каналом. Виходить з кодом 1 на першій розбіжності.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mapContactSignal, refetchContacts, subscribeScope, type RawSignal } from './adapter.js';
import { commandPool, contactSave, inCommand } from './command.js';
import { makeFixture } from './fixture.js';
import { waitFor } from './wait.js';

const N = 20;
const fx = await makeFixture();
const pool = commandPool();
const topicA = `scope:${fx.orgA}`;
const topicB = `scope:${fx.orgB}`;

const aOwn = subscribeScope(fx.userA.db, topicA);
const bOwn = subscribeScope(fx.userB.db, topicB);
const bForeign = subscribeScope(fx.userB.db, topicA); // чужий скоуп
const aForeign = subscribeScope(fx.userA.db, topicB);
await waitFor('own channels subscribed', () => aOwn.status.includes('SUBSCRIBED') && bOwn.status.includes('SUBSCRIBED'));
await waitFor('foreign joins settled', () => bForeign.status.length > 0 && aForeign.status.length > 0);
console.log('foreign join status', { bForeign: bForeign.status, aForeign: aForeign.status });
assert.ok(!bForeign.status.includes('SUBSCRIBED'), 'B joined a foreign scope channel');
assert.ok(!aForeign.status.includes('SUBSCRIBED'), 'A joined a foreign scope channel');

// Серія команд у скоупі A: створення + оновлення. Очікуємо рівно N сигналів.
const ids: string[] = Array.from({ length: N / 2 }, () => randomUUID());
const expected = new Set<string>();
for (const id of ids) {
  const r1 = await contactSave(pool, fx.userA.id, { id, org_id: fx.orgA, full_nm: `P ${id.slice(0, 4)}`, email_addr: 'a@x', company_id: fx.companyA, referrer_id: fx.companyA2 }, null);
  expected.add(`${id}:${r1.result}`);
  const r2 = await contactSave(pool, fx.userA.id, { id, email_addr: 'b@x' }, Number(r1.result));
  expected.add(`${id}:${r2.result}`);
  assert.deepEqual([...r1.notices, ...r2.notices], [], 'command produced warnings');
}

// Відкат: сигнал у відкоченій транзакції не доходить.
const rolledBackId = randomUUID();
await inCommand(pool, fx.userA.id, 'select demo.contact_save($1::jsonb, null) as r', [JSON.stringify({ id: rolledBackId, org_id: fx.orgA, full_nm: 'rollback' })], { rollback: true });

// Відправка в чужий скоуп з команди: RLS на INSERT відхиляє, а realtime.send
// ковтає помилку в WARNING — команда успішна, сигнал втрачено мовчки.
const foreignSend = await inCommand(pool, fx.userA.id, `select realtime.send('{"kind":"contact","op":"probe","keys":{}}'::jsonb, 'change', $1, true)::text as r`, [topicB]);
console.log('foreign send notices', foreignSend.notices);
assert.ok(foreignSend.notices.some((n) => n.includes('WarnSendingBroadcastMessage')), 'expected swallowed RLS denial');

// Сигнал у скоуп B — щоб канал B був перевірений не вхолосту.
const idB = randomUUID();
const rB = await contactSave(pool, fx.userB.id, { id: idB, org_id: fx.orgB, full_nm: 'B person' }, null);

// Сентинел у кінці серії A: після нього дублікати вже прийшли б.
const sentinel = randomUUID();
const rS = await contactSave(pool, fx.userA.id, { id: sentinel, org_id: fx.orgA, full_nm: 'sentinel' }, null);
const contactSignals = () => aOwn.messages.filter((m) => m.event === 'change').map((m) => mapContactSignal(m.payload as RawSignal));
await waitFor('A received sentinel', () => contactSignals().some((s) => s.keys.id === sentinel));
await waitFor('B received own signal', () => bOwn.messages.some((m) => (m.payload as RawSignal).keys?.id === idB));

const got = contactSignals().filter((s) => s.keys.id !== sentinel);
const counts = new Map<string, number>();
for (const s of got) counts.set(`${s.keys.id}:${s.version}`, (counts.get(`${s.keys.id}:${s.version}`) ?? 0) + 1);
assert.equal(got.length, N, `A got ${got.length} signals, expected ${N}`);
for (const k of expected) assert.equal(counts.get(k), 1, `signal ${k} not exactly once`);
assert.ok(!got.some((s) => s.keys.id === rolledBackId), 'rolled back signal delivered');
assert.equal(new Set(got.map((s) => s.messageId)).size, N, 'message ids not unique');

// Ключі після мапінгу — логічні.
const sample = got[0]!;
assert.deepEqual(Object.keys(sample.keys).sort(), ['id', 'organization']);
assert.equal(sample.keys.organization, fx.orgA);
console.log('mapped signal sample', sample);

// Жодного сигналу A у каналах B (свій і чужі).
assert.ok(!bOwn.messages.some((m) => (m.payload as RawSignal).keys?.id && ids.includes((m.payload as RawSignal).keys.id!)), 'leak into B channel');
assert.equal(bForeign.messages.length, 0, 'B foreign channel received messages');
assert.equal(aForeign.messages.length, 0, 'A foreign channel received messages');
assert.ok(!aOwn.messages.some((m) => (m.payload as RawSignal).keys?.id === idB), 'B signal leaked to A');
assert.ok(rB.result);

// Перечитування за ключами сигналу через PostgREST під RLS: логічні ключі, версія збігається.
const last = new Map<string, number>();
for (const s of got) last.set(s.keys.id, Math.max(last.get(s.keys.id) ?? 0, s.version));
const re = await refetchContacts(fx.userA.db, [...last.keys()]);
assert.equal(re.error, null);
assert.equal(re.data!.length, ids.length);
for (const row of re.data!) {
  assert.equal(row.version, last.get(row.id), 'refetched version differs from signal');
  assert.equal(row.organization, fx.orgA);
  assert.equal(row.company?.companyTitle, 'Acme');
  assert.equal(row.referrer?.companyTitle, 'Referrer Inc');
}
console.log('refetched row sample', re.data![0]);
// Той самий запит від B за ключами A — RLS не віддає рядків.
const reB = await refetchContacts(fx.userB.db, [...last.keys()]);
assert.equal(reB.data!.length, 0, 'B refetched A rows');

// Прийнята таблиця: запис через API → broadcast-тригер з обрізаним payload.
const ins = await fx.userA.db.from('legacy_note').insert({ org_id: fx.orgA, body: 'secret body', prio: 1 }).select('id').single();
assert.equal(ins.error, null);
const noteId = ins.data!.id;
const upd = await fx.userA.db.from('legacy_note').update({ body: 'secret 2' }).eq('id', noteId);
assert.equal(upd.error, null);
const legacy = () => aOwn.messages.filter((m) => m.event === 'legacy_change');
await waitFor('two legacy signals', () => legacy().length >= 2);
const sentinel2 = randomUUID();
await contactSave(pool, fx.userA.id, { id: sentinel2, org_id: fx.orgA, full_nm: 'sentinel2' }, null);
await waitFor('A received sentinel2', () => contactSignals().some((s) => s.keys.id === sentinel2));
assert.equal(legacy().length, 2, 'legacy signals not exactly two');
const lp = legacy()[1]!.payload;
console.log('legacy payload', JSON.stringify(lp));
assert.deepEqual(Object.keys(lp['record'] as object).sort(), ['id', 'org_id'], 'legacy payload not trimmed');
assert.ok(!JSON.stringify(lp).includes('secret'), 'legacy payload leaks data');
assert.ok(!bOwn.messages.some((m) => m.event === 'legacy_change'), 'legacy leak into B');
assert.equal(bForeign.messages.length, 0);

console.log('PROBE2 OK', { signals: got.length, legacy: legacy().length });
await pool.end();
await Promise.all([fx.userA.db.removeAllChannels(), fx.userB.db.removeAllChannels()]);
process.exit(0);
