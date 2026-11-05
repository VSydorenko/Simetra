// Мінімальний PostgREST-адаптер проби: підписка на приватний канал скоупу,
// мапінг фізичних ключів сигналу на логічні згенерованою картою, перечитування
// рядків через PostgREST під RLS.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';
import { contactColumns, contactPhysicalToLogical, contactSelect } from './generated-contact.js';

// Сигнал у фізичній формі — як його шле ядро (Р31: вид, ключі, версія).
export type RawSignal = {
  id: string; // id повідомлення, дописує realtime.send
  kind: string;
  op: string;
  keys: Record<string, string>;
  row_ver: number;
};

type PhysToLogical = typeof contactPhysicalToLogical;
export type ContactSignal = {
  messageId: string;
  op: string;
  keys: { [P in 'id' | 'org_id' as PhysToLogical[P]]: string };
  version: number;
};

export function mapContactSignal(raw: RawSignal): ContactSignal {
  const keys = {} as Record<string, string>;
  for (const [phys, value] of Object.entries(raw.keys)) {
    const logical = (contactPhysicalToLogical as Record<string, string>)[phys];
    if (logical === undefined) throw new Error(`unmapped signal key ${phys}`);
    keys[logical] = value;
  }
  return {
    messageId: raw.id,
    op: raw.op,
    keys: keys as ContactSignal['keys'],
    version: raw[contactColumns.version],
  };
}

export function refetchContacts(db: SupabaseClient<Database, 'demo'>, ids: string[]) {
  return db.from('contact').select(contactSelect).in(contactColumns.id, ids);
}

export type Subscription = {
  channel: RealtimeChannel;
  status: string[];
  messages: { event: string; payload: Record<string, unknown> }[];
};

// Підписка на топік скоупу; статуси й усі повідомлення накопичуються для перевірок.
export function subscribeScope(db: SupabaseClient<Database, 'demo'>, topic: string): Subscription {
  const sub: Subscription = { channel: db.channel(topic, { config: { private: true } }), status: [], messages: [] };
  sub.channel
    .on('broadcast', { event: '*' }, (m) => {
      sub.messages.push({ event: m.event, payload: m.payload as Record<string, unknown> });
    })
    .subscribe((s, err) => {
      sub.status.push(err ? `${s}:${err.message}` : s);
    });
  return sub;
}
