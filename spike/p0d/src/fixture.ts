// Синтетична фікстура: два значення скоупу, по користувачу в кожному.
// Ідентифікатори випадкові на кожен прогін — прогони не заважають один одному.
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import type { Database } from './database.types.js';
import type { Database as DatabaseV2 } from './database.v2.types.js';
import { env } from './env.js';

export type User = { id: string; token: string; db: SupabaseClient<Database, 'demo'> };
export type Fixture = { orgA: string; orgB: string; companyA: string; companyA2: string; userA: User; userB: User };

async function makeUser(admin: SupabaseClient): Promise<User> {
  const email = `p0d-${randomUUID()}@example.test`;
  const password = 'p0d-password-123';
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  const db = createClient<Database, 'demo'>(env.apiUrl, env.anonKey, {
    db: { schema: 'demo' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await db.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  await db.realtime.setAuth(signed.data.session.access_token);
  return { id: created.data.user.id, token: signed.data.session.access_token, db };
}

export async function makeFixture(): Promise<Fixture> {
  const admin = createClient(env.apiUrl, env.serviceKey, { auth: { persistSession: false } });
  const [userA, userB] = [await makeUser(admin), await makeUser(admin)];
  const orgA = randomUUID();
  const orgB = randomUUID();
  const companyA = randomUUID();
  const companyA2 = randomUUID();
  const client = new pg.Client({ connectionString: env.dbUrl });
  await client.connect();
  await client.query('insert into demo.org (id, title) values ($1, $2), ($3, $4)', [orgA, 'Org A', orgB, 'Org B']);
  await client.query('insert into demo.member (user_id, org_id) values ($1, $2), ($3, $4)', [userA.id, orgA, userB.id, orgB]);
  await client.query('insert into demo.company (id, org_id, title_txt) values ($1, $2, $3), ($4, $2, $5)', [
    companyA,
    orgA,
    'Acme',
    companyA2,
    'Referrer Inc',
  ]);
  await client.end();
  return { orgA, orgB, companyA, companyA2, userA, userB };
}

// Клієнт тієї самої сесії, типізований під Database нової збірки:
// кожна збірка компілюється зі своїм виходом typegen.
export function clientV2(user: User): SupabaseClient<DatabaseV2, 'demo'> {
  return createClient<DatabaseV2, 'demo'>(env.apiUrl, env.anonKey, {
    db: { schema: 'demo' },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${user.token}` } },
  });
}
