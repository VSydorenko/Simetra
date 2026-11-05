// Проби 3–4: зміна типу у фазі розширення під навантаженням змішаних записів
// старої й нової збірки, дозаповнення конкурентно, RLS і сигнали на місці;
// порядок тригерів і те, що синхронізація змінює NEW того самого рядка.
// Передумова: свіжа база (`supabase db reset`), бо проба сама застосовує розширення.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { subscribeScope, type RawSignal } from './adapter.js';
import { commandPool, inCommand } from './command.js';
import { env } from './env.js';
import { clientV2, makeFixture } from './fixture.js';
import { waitFor } from './wait.js';

const ROWS = 12;
// Останні RESERVED рядків записувачі не чіпають: їх заповнює лише дозаповнення.
const RESERVED = 6;
const OPS_PER_BUILD = 150;
const WORKERS_PER_BUILD = 4;

const fx = await makeFixture();
const aNew = clientV2(fx.userA);
const bNew = clientV2(fx.userB);
const pool = commandPool(12);
const admin = new pg.Client({ connectionString: env.dbUrl });
await admin.connect();
const topicA = `scope:${fx.orgA}`;
const aOwn = subscribeScope(fx.userA.db, topicA);
const bOwn = subscribeScope(fx.userB.db, `scope:${fx.orgB}`);
await waitFor('subscribed', () => aOwn.status.includes('SUBSCRIBED') && bOwn.status.includes('SUBSCRIBED'));

// Карти колонок двох збірок: логічне `score` → різні фізичні колонки.
const oldBuild = { score: 'score', prio: 'prio', select: 'id, score, version:row_ver' } as const;
const newBuild = { score: 'score_num', prio: 'prio_num', select: 'id, score:score_num, version:row_ver' } as const;
type Build = typeof oldBuild | typeof newBuild;

const stats = { commands: 0, conflicts: 0, legacyWrites: 0, legacyRetries: 0 };

// Команда зі свіжою очікуваною версією; конфлікт версії — повтор.
async function save(item: Record<string, unknown>, create = false): Promise<void> {
  for (;;) {
    try {
      const sql = create
        ? 'select demo.contact_save($1::jsonb, null) as r'
        : `select demo.contact_save($1::jsonb, (select row_ver from demo.contact where id = ($1::jsonb->>'id')::uuid)) as r`;
      const out = await inCommand(pool, fx.userA.id, sql, [JSON.stringify(item)]);
      assert.deepEqual(out.notices, [], `command warnings: ${out.notices.join('; ')}`);
      stats.commands++;
      return;
    } catch (e) {
      if ((e as { code?: string }).code === '40001') {
        stats.conflicts++;
        continue;
      }
      throw e;
    }
  }
}

const ids = Array.from({ length: ROWS }, () => randomUUID());
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;

// Стара збірка до розширення: рядки з цілим score; частина — без значення.
for (const [i, id] of ids.entries()) {
  await save({ id, org_id: fx.orgA, full_nm: `R${i}`, score: i % 3 === 0 ? null : i * 10 }, true);
}
const noteIds: string[] = [];
for (let i = 0; i < ROWS; i++) {
  const r = await fx.userA.db.from('legacy_note').insert({ org_id: fx.orgA, body: `n${i}`, prio: i % 3 === 0 ? null : i }).select('id').single();
  assert.equal(r.error, null);
  noteIds.push(r.data!.id);
  stats.legacyWrites++;
}

function randomValue(build: Build): number {
  return build === oldBuild ? Math.floor(Math.random() * 1000) : Math.round(Math.random() * 100000) / 100;
}

async function contactWorker(build: Build, ops: number): Promise<void> {
  for (let i = 0; i < ops; i++) await save({ id: pick(ids.slice(0, ROWS - RESERVED)), [build.score]: randomValue(build) });
}

// Запис прийнятої таблиці напряму через PostgREST; нова колонка може ще не бути
// в кеші схеми PostgREST — повтор, доки кеш не оновиться.
async function legacyWorker(build: Build, ops: number): Promise<void> {
  for (let i = 0; i < ops; i++) {
    const value = build === oldBuild ? Math.floor(Math.random() * 300) : Math.round(Math.random() * 30000) / 100;
    for (;;) {
      const r =
        build === oldBuild
          ? await fx.userA.db.from('legacy_note').update({ prio: value }).eq('id', pick(noteIds.slice(0, ROWS - RESERVED))).select('id')
          : await aNew.from('legacy_note').update({ prio_num: value }).eq('id', pick(noteIds.slice(0, ROWS - RESERVED))).select('id');
      if (r.error?.code === 'PGRST204') {
        stats.legacyRetries++;
        await new Promise((res) => setTimeout(res, 50));
        continue;
      }
      assert.equal(r.error, null, JSON.stringify(r.error));
      assert.equal(r.data!.length, 1);
      stats.legacyWrites++;
      break;
    }
  }
}

const workers = (build: Build, n: number) =>
  Array.from({ length: WORKERS_PER_BUILD }, () => Promise.all([contactWorker(build, n / WORKERS_PER_BUILD), legacyWorker(build, n / WORKERS_PER_BUILD / 3)]));

// Стара збірка пише безперервно; посеред її роботи — розширення.
const oldRunning = Promise.all(workers(oldBuild, OPS_PER_BUILD));
await admin.query(readFileSync(new URL('../sql/expand.sql', import.meta.url), 'utf8'));

// Дозаповнення пачками конкурентно з обома збірками; broadcast прийнятої таблиці
// мовчить за GUC simetra.backfill.
async function backfill(table: 'contact' | 'legacy_note'): Promise<number> {
  const [oldCol, newCol] = table === 'contact' ? ['score', 'score_num'] : ['prio', 'prio_num'];
  let total = 0;
  for (;;) {
    await admin.query('begin');
    await admin.query(`set local simetra.backfill = 'on'`);
    const r = await admin.query(
      `update demo.${table} t set ${newCol} = t.${oldCol}
         where t.id in (select id from demo.${table} where ${newCol} is null and ${oldCol} is not null limit 3 for update skip locked)`,
    );
    await admin.query('commit');
    total += r.rowCount ?? 0;
    if (!r.rowCount) return total;
  }
}
const newRunning = Promise.all(workers(newBuild, OPS_PER_BUILD));
const backfilled = { contact: await backfill('contact'), legacy: await backfill('legacy_note') };
await Promise.all([oldRunning, newRunning]);
console.log('stats', stats, 'backfilled', backfilled);
// Резервні рядки з непорожньою старою колонкою: індекси 7, 8, 10, 11.
assert.ok(backfilled.contact >= 4 && backfilled.legacy >= 4, 'backfill did not touch reserved rows');

// Сентинел: після нього дублікати вже прийшли б.
const sentinel = randomUUID();
await save({ id: sentinel, org_id: fx.orgA, full_nm: 'sentinel' }, true);
const signals = () => aOwn.messages.filter((m) => m.event === 'change').map((m) => m.payload as RawSignal);
await waitFor('sentinel', () => signals().some((s) => s.keys.id === sentinel), 20_000);
const legacySignals = aOwn.messages.filter((m) => m.event === 'legacy_change');

// Рівно один сигнал на команду; жодного — на дозаповнення.
assert.equal(signals().length, stats.commands, 'contact signals != commands');
assert.equal(new Set(signals().map((s) => `${s.keys.id}:${s.row_ver}`)).size, stats.commands, 'duplicate contact signals');
assert.equal(legacySignals.length, stats.legacyWrites, 'legacy signals != API writes');
assert.equal(bOwn.messages.length, 0, 'leak into scope B');

// Узгодженість колонок у кожному рядку: стара = round(нова), обидві NULL або обидві задані.
const c = await admin.query<{ bad: string }>(
  `select count(*) as bad from demo.contact where (score is null) <> (score_num is null) or score <> round(score_num)::int`,
);
const l = await admin.query<{ bad: string }>(
  `select count(*) as bad from demo.legacy_note where (prio is null) <> (prio_num is null) or prio <> round(prio_num)::smallint`,
);
assert.equal(c.rows[0]!.bad, '0', 'contact columns diverged');
assert.equal(l.rows[0]!.bad, '0', 'legacy_note columns diverged');

// Читання обох збірок через PostgREST під RLS узгоджене.
const rOld = await fx.userA.db.from('contact').select(oldBuild.select).in('id', ids);
const rNew = await aNew.from('contact').select(newBuild.select).in('id', ids);
assert.equal(rOld.error, null);
assert.equal(rNew.error, null, JSON.stringify(rNew.error));
const newById = new Map(rNew.data!.map((r) => [r.id, r]));
for (const o of rOld.data!) {
  const n = newById.get(o.id)!;
  assert.equal(o.version, n.version);
  assert.equal(o.score, n.score === null ? null : Math.round(Number(n.score)));
}
const rB = await bNew.from('contact').select(newBuild.select).in('id', ids);
assert.equal(rB.data!.length, 0, 'B reads A rows after expand');

// Проба 4: порядок тригерів і NEW того самого рядка — трасований запис.
async function traced(role: 'simetra_command' | 'authenticated', sql: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: env.dbUrl });
  const notices: string[] = [];
  client.on('notice', (n) => notices.push(n.message ?? ''));
  await client.connect();
  await client.query('begin');
  await client.query(`select set_config('request.jwt.claims', $1, true), set_config('p0d.trace', 'on', true)`, [
    JSON.stringify({ sub: fx.userA.id, role: 'authenticated' }),
  ]);
  await client.query(`set local role ${role}`);
  await client.query(sql, params);
  const counts = await client.query(
    `select relname, n_tup_ins::int as ins, n_tup_upd::int as upd from pg_stat_xact_user_tables
      where (schemaname = 'demo' and relname in ('contact', 'legacy_note')) or (schemaname = 'realtime' and relname like 'messages%')
        and (n_tup_ins + n_tup_upd) > 0 order by relname`,
  );
  await client.query('commit');
  await client.end();
  return { notices, counts: counts.rows };
}
const id0 = ids[1]!;
const t1 = await traced('simetra_command', `select demo.contact_save($1::jsonb, (select row_ver from demo.contact where id = $2)) as r`, [
  JSON.stringify({ id: id0, score: 42 }),
  id0,
]);
console.log('trace old-build command', t1);
const t2 = await traced('simetra_command', `select demo.contact_save($1::jsonb, (select row_ver from demo.contact where id = $2)) as r`, [
  JSON.stringify({ id: id0, score_num: 17.6 }),
  id0,
]);
console.log('trace new-build command', t2);
const t3 = await traced('authenticated', `update demo.legacy_note set prio = 5 where id = $1`, [noteIds[0]]);
console.log('trace legacy write', t3);

const order = t1.notices.map((n) => n.split(' ')[1]);
assert.deepEqual(order, ['contact_a_trace', 'contact_m_sync_score', 'contact_z_trace', 'contact_after_trace']);
assert.ok(t1.notices.every((n) => n.includes('depth=1')), 'trigger recursion');
assert.ok(t1.notices[0]!.includes('old=42 new=') && !t1.notices[0]!.includes('new=42'), 'a_trace should see unsynced NEW');
assert.ok(t1.notices[2]!.includes('old=42 new=42.00'), 'z_trace should see synced NEW');
assert.ok(t2.notices[2]!.includes('old=18 new=17.60'));
for (const t of [t1, t2, t3]) {
  const table = t === t3 ? 'legacy_note' : 'contact';
  assert.deepEqual(t.counts.find((r) => r.relname === table), { relname: table, ins: 0, upd: 1 }, 'extra UPDATE from sync');
  const msgs = t.counts.filter((r) => String(r.relname).startsWith('messages')).reduce((s, r) => s + Number(r.ins), 0);
  assert.equal(msgs, 1, 'not exactly one realtime message per write');
}

console.log('PROBE3 OK', { ...stats, signals: signals().length, legacySignals: legacySignals.length });
await pool.end();
await admin.end();
await Promise.all([fx.userA.db.removeAllChannels(), fx.userB.db.removeAllChannels()]);
process.exit(0);
