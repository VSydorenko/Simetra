// Г6: пакет із BURST фаз = BURST викликів realtime.send в одній транзакції.
// Скільки доходить до підписника, за який час, і що пише Realtime у лог.
// Ліміти локального тенанта — у _realtime.tenants (хостинг може мати інші).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { subscribeScope, type RawSignal } from './adapter.js';
import { commandPool, inCommand } from './command.js';
import { makeFixture } from './fixture.js';
import { waitFor } from './wait.js';

const BURST = Number(process.env.BURST ?? 500);
const fx = await makeFixture();
const pool = commandPool(2);
const topic = `scope:${fx.orgA}`;
const sub = subscribeScope(fx.userA.db, topic);
await waitFor('subscribed', () => sub.status.includes('SUBSCRIBED'));

const batch = randomUUID();
const started = Date.now();
const out = await inCommand(
  pool,
  fx.userA.id,
  `select count(*)::text as r from (
     select realtime.send(jsonb_build_object('kind', 'contact', 'op', 'update', 'batch', $2::text,
       'keys', jsonb_build_object('id', gen_random_uuid(), 'org_id', $3::uuid), 'row_ver', g), 'change', $1, true)
     from generate_series(1, $4::int) g) s`,
  [topic, batch, fx.orgA, BURST],
);
const committed = Date.now();
assert.deepEqual(out.notices, []);
const inBatch = () => sub.messages.filter((m) => (m.payload as RawSignal & { batch?: string }).batch === batch).length;
let firstAt = 0;
let lastCount = 0;
let lastAt = committed;
// Чекаємо або всього пакета, або 10 с тиші після останнього повідомлення.
await waitFor(
  'burst settled',
  () => {
    const n = inBatch();
    if (n > 0 && !firstAt) firstAt = Date.now();
    if (n !== lastCount) {
      lastCount = n;
      lastAt = Date.now();
    }
    return n === BURST || Date.now() - lastAt > 10_000;
  },
  120_000,
);
const received = inBatch();
// Канал живий після сплеску? Окремий сигнал після пакета.
const after = randomUUID();
await inCommand(pool, fx.userA.id, `select realtime.send(jsonb_build_object('kind','contact','op','probe','keys',jsonb_build_object('id',$2::text)), 'change', $1, true)::text as r`, [topic, after]);
let afterOk = true;
await waitFor('post-burst signal', () => sub.messages.some((m) => (m.payload as RawSignal).keys?.id === after), 15_000).catch(() => (afterOk = false));
console.log('BURST RESULT', {
  burst: BURST,
  received,
  txMs: committed - started,
  firstAfterCommitMs: firstAt ? firstAt - committed : null,
  lastAfterCommitMs: lastAt - committed,
  channelStatus: sub.status,
  postBurstSignalDelivered: afterOk,
});
await pool.end();
await fx.userA.db.removeAllChannels();
process.exit(0);
