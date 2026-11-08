// Тотожність SSR-знімка: суб'єкт, хеш каталогу, версія прав, параметри
// запиту, строк придатності. Сервер вкладає їх у знімок; клієнт після
// гідратації звіряє з контрактом `version`. Розбіжність прав — виняток
// безпеки: дані прибираються негайно, UI показує причину.
import { ITEM, type CoreSession } from "../core"
import { getVersion } from "../server/fns"
import { traced } from "./source"

export const CATALOG_HASH = "catalog-v1"
export const SNAPSHOT_TTL_MS = 60_000

export interface SnapshotMeta {
  subject: string
  catalogHash: string
  rightsVersion: number
  issuedAt: number
  ttlMs: number
}

export function snapshotMeta(subject: string, rightsVersion = 1): SnapshotMeta {
  return {
    subject,
    catalogHash: CATALOG_HASH,
    rightsVersion,
    issuedAt: Date.now(),
    ttlMs: SNAPSHOT_TTL_MS,
  }
}

export type VerifyOutcome =
  "ok" | "rights-changed" | "subject-changed" | "catalog-changed" | "expired"

/** Звірка після гідратації: один запит `version`, не запит даних. */
export async function verifyAfterHydration(
  core: CoreSession,
  meta: SnapshotMeta
): Promise<VerifyOutcome> {
  const v = await traced("getVersion", () => getVersion())
  if (core.closed) return "ok"
  let outcome: VerifyOutcome = "ok"
  if (v.subject !== meta.subject) outcome = "subject-changed"
  else if (v.rightsVersion !== meta.rightsVersion) outcome = "rights-changed"
  else if (v.catalogHash !== meta.catalogHash) outcome = "catalog-changed"
  else if (Date.now() - meta.issuedAt > meta.ttlMs) outcome = "expired"
  if (outcome === "rights-changed" || outcome === "subject-changed") {
    // Виняток безпеки: усі рядки знімка зникають з усіх виглядів одразу.
    const keys = Object.values(core.dehydrate().objects).flatMap((rows) =>
      rows.map((r) => r.key)
    )
    core.commit((w) => w.purge(ITEM, keys), core.token())
  }
  return outcome
}
