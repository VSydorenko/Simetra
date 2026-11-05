// Проба 1: tsc виводить тип рядка з логічними ключами без any і приведень.
import { createClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';
import { contactColumns, contactSelect } from './generated-contact.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;

const db = createClient<Database, 'demo'>('http://localhost', 'key', { db: { schema: 'demo' } });

// Фільтри — за фізичними іменами з карти.
const query = db
  .from('contact')
  .select(contactSelect)
  .eq(contactColumns.organization, '00000000-0000-0000-0000-000000000000')
  .order(contactColumns.fullName);

type Row = NonNullable<Awaited<typeof query>['data']>[number];

type ExpectedRow = {
  id: string;
  organization: string;
  contactEmail: string | null;
  fullName: string;
  version: number;
  score: number | null;
  company: { id: string; companyTitle: string } | null;
  referrer: { id: string; companyTitle: string } | null;
};

export type Checks = [
  Expect<Equal<IsAny<Row>, false>>,
  Expect<Equal<Row, ExpectedRow>>,
  Expect<Equal<IsAny<Row['company']>, false>>,
];

// Від'ємні перевірки: tsc мусить відхилити кожен рядок під @ts-expect-error.
// Фільтр за логічним ім'ям — не колонка таблиці.
// @ts-expect-error логічне ім'я у фільтрі
db.from('contact').select(contactSelect).eq('contactEmail', 'x');
// Неіснуюча колонка в select дає тип-помилку в рядку, а не any.
type RowOf<Q> = Q extends PromiseLike<{ data: infer D }> ? NonNullable<D> extends readonly (infer R)[] ? R : never : never;
type HasError<T> = T extends { error: true } ? true : false;

const bad = db.from('contact').select('id, nope:no_such_col');
// Embed без `!fk_name` при двох FK на ту саму ціль — тип-помилка в полі.
const ambiguous = db.from('contact').select('id, company(id)');
// Рядок, зібраний у рантаймі (тип `string`), — виведення немає: кодоген мусить давати літерал.
const runtime = db.from('contact').select(['id', 'contactEmail:email_addr'].join(', '));
// Зворотний embed тим самим FK — масив з логічними ключами.
const reverse = db.from('company').select('id, people:contact!contact_company_fk(id, fullName:full_nm)');

export type NegativeChecks = [
  Expect<HasError<RowOf<typeof bad>>>,
  Expect<HasError<RowOf<typeof ambiguous>['company']>>,
  Expect<HasError<RowOf<typeof runtime>>>,
  Expect<Equal<RowOf<typeof reverse>, { id: string; people: { id: string; fullName: string }[] }>>,
];
// @ts-expect-error фізичний ключ у результаті відсутній — є лише логічний
export const physicalKeyAbsent: Row['email_addr'] = null;
