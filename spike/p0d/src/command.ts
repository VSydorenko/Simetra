// Транзакція команди у формі T3 (Р21): BEGIN → claims LOCAL → SET LOCAL ROLE →
// ядро → COMMIT. Попередження бази збираються: realtime.send ковтає помилку
// відправки в WARNING, і лише так її видно.
import pg from 'pg';
import { env } from './env.js';

export type CommandOutcome = { result: string | null; notices: string[] };

export function commandPool(max = 10): pg.Pool {
  return new pg.Pool({ connectionString: env.dbUrl, max });
}

export async function inCommand(
  pool: pg.Pool,
  userId: string,
  sql: string,
  params: unknown[],
  opts: { rollback?: boolean } = {},
): Promise<CommandOutcome> {
  const client = await pool.connect();
  const notices: string[] = [];
  // PoolClient у @types/pg не оголошує подію notice, хоч вона та сама, що в Client.
  const onNotice = (n: { severity?: string; message?: string }) => notices.push(`${n.severity}: ${n.message}`);
  const emitter = client as unknown as NodeJS.EventEmitter;
  emitter.on('notice', onNotice);
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await client.query('set local role simetra_command');
    const res = await client.query<{ r: string | null }>(sql, params);
    await client.query(opts.rollback ? 'rollback' : 'commit');
    return { result: res.rows[0]?.r ?? null, notices };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    emitter.off('notice', onNotice);
    client.release();
  }
}

export function contactSave(pool: pg.Pool, userId: string, item: Record<string, unknown>, expectedVersion: number | null) {
  return inCommand(pool, userId, 'select demo.contact_save($1::jsonb, $2::bigint) as r', [JSON.stringify(item), expectedVersion]);
}
