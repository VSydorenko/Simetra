// Питання автора П4-B. Г1: каст `::text` у select разом із фільтром за тією
// самою колонкою. Г2: embed цілі, невидимої під RLS; підказка для складеного FK.
// Типові асерції перевіряє tsc, рантаймові — цей скрипт проти PostgREST.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { env } from './env.js';
import { makeFixture } from './fixture.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type RowOf<Q> = Q extends PromiseLike<{ data: infer D }> ? NonNullable<D> extends readonly (infer R)[] ? R : never : never;

const fx = await makeFixture();
const db = fx.userA.db;
const admin = new pg.Client({ connectionString: env.dbUrl });
await admin.connect();

const companyB = randomUUID();
const hidden = randomUUID();
const withScore = randomUUID();
const noScore = randomUUID();
const crossScope = randomUUID();
const dealVisible = randomUUID();
const dealHidden = randomUUID();
await admin.query(`insert into demo.company (id, org_id, title_txt) values ($1, $2, 'B co'), ($3, $4, 'hidden by rights')`, [companyB, fx.orgB, hidden, fx.orgA]);
await admin.query(
  `insert into demo.contact (id, org_id, full_nm, score, company_id) values ($1, $4, 'with score', 5, $5), ($2, $4, 'no score', null, $5), ($3, $4, 'cross scope', 7, $6)`,
  [withScore, noScore, crossScope, fx.orgA, fx.companyA, companyB],
);
await admin.query(`insert into demo.deal (id, org_id, company_id, title, amount) values ($1, $3, $4, 'visible', 10.50), ($2, $3, $5, 'hidden target', null)`, [
  dealVisible,
  dealHidden,
  fx.orgA,
  fx.companyA,
  hidden,
]);
// Складений FK не дає послатися на компанію іншого скоупу.
await assert.rejects(
  admin.query(`insert into demo.deal (id, org_id, company_id, title) values ($1, $2, $3, 'x')`, [randomUUID(), fx.orgA, companyB]),
  /deal_company_fk/,
);

// Г1. Каст у select і фільтр за фізичною колонкою.
const g1 = db.from('contact').select('id, scoreText:score::text').in('id', [withScore, noScore]).eq('score', 5);
const g1all = db.from('contact').select('id, scoreText:score::text').in('id', [withScore, noScore]).order('full_nm');
const g1amount = db.from('deal').select('id, amountText:amount::text, amount').eq('id', dealVisible);
export type G1 = [
  Expect<Equal<RowOf<typeof g1>, { id: string; scoreText: string }>>,
  // Тип не враховує NULL: колонка nullable, а `::text` дає `string` без `| null`.
  Expect<Equal<RowOf<typeof g1amount>, { id: string; amountText: string; amount: number | null }>>,
];
// @ts-expect-error фільтр за аліасом касту — не колонка
db.from('contact').select('id, scoreText:score::text').eq('scoreText', '5');
const r1 = await g1;
assert.equal(r1.error, null);
assert.deepEqual(r1.data, [{ id: withScore, scoreText: '5' }]);
const r1all = await g1all;
console.log('G1 cast rows', r1all.data);
const nullCast = r1all.data!.find((r) => r.id === noScore)!;
assert.equal(nullCast.scoreText, null, 'cast of NULL is null at runtime');
const r1amount = await g1amount;
console.log('G1 numeric', r1amount.data, typeof r1amount.data![0]!.amount);

// Г2. Embed цілі, невидимої під RLS.
const g2contact = db.from('contact').select('id, company:company!contact_company_fk(id, companyTitle:title_txt)').eq('id', crossScope);
const g2deal = db.from('deal').select('id, company:company(id, companyTitle:title_txt)').in('id', [dealVisible, dealHidden]).order('title');
const g2dealHint = db.from('deal').select('id, company:company!deal_company_fk(id)').in('id', [dealVisible, dealHidden]);
const g2inner = db.from('deal').select('id, company:company!inner(id)').in('id', [dealVisible, dealHidden]);
const g2reverse = db.from('company').select('id, deals:deal(id)').eq('id', fx.companyA);
export type G2 = [
  Expect<Equal<RowOf<typeof g2contact>, { id: string; company: { id: string; companyTitle: string } | null }>>,
  // Складений NOT NULL FK: тип каже «завжди об'єкт», хоча RLS може сховати ціль.
  Expect<Equal<RowOf<typeof g2deal>, { id: string; company: { id: string; companyTitle: string } }>>,
  Expect<Equal<RowOf<typeof g2dealHint>, { id: string; company: { id: string } }>>,
  Expect<Equal<RowOf<typeof g2inner>, { id: string; company: { id: string } }>>,
];
const r2contact = await g2contact;
console.log('G2 cross-scope to-one', JSON.stringify(r2contact.data));
assert.deepEqual(r2contact.data, [{ id: crossScope, company: null }], 'hidden target: key present, value null');
const r2deal = await g2deal;
console.log('G2 rights-hidden composite FK', JSON.stringify(r2deal.data));
assert.equal(r2deal.error, null, 'composite FK embed needs no hint');
assert.equal(r2deal.data!.length, 2);
const hiddenRow = r2deal.data!.find((r) => r.id === dealHidden)!;
assert.ok('company' in hiddenRow);
assert.equal(hiddenRow.company, null, 'type says object, runtime null');
const r2hint = await g2dealHint;
assert.equal(r2hint.error, null);
const r2inner = await g2inner;
console.log('G2 !inner', JSON.stringify(r2inner.data));
assert.deepEqual(r2inner.data, [{ id: dealVisible, company: { id: fx.companyA } }], '!inner drops rows with hidden target');
const r2rev = await g2reverse;
console.log('G2 reverse', JSON.stringify(r2rev.data));
// Ціль невидима, тож її угоди не віддаються як дочірні — перевірка видимого боку.
assert.deepEqual(r2rev.data, [{ id: fx.companyA, deals: [{ id: dealVisible }] }]);
const hiddenParent = await db.from('company').select('id, deals:deal(id)').eq('id', hidden);
assert.deepEqual(hiddenParent.data, [], 'hidden company row absent');

console.log('PROBE5 OK');
await admin.end();
process.exit(0);
