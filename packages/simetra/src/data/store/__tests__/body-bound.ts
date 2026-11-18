import { jsonBytes, readPartToWire, type ReadQuery } from "simetra/model"
import type { FakeReadLog, FakeSource } from "../testing/fake-source"
import { keysOf } from "./core-support"

/** The wire part of a query with the list of its keys emptied. */
function partWithoutKeys(fake: FakeSource, query: ReadQuery): number {
  const where = "where" in query ? query.where : undefined
  const emptied: ReadQuery =
    where !== undefined && "op" in where && where.op === "in"
      ? ({ ...query, where: { ...where, value: [] } } as ReadQuery)
      : query
  const wire = readPartToWire(fake.index, { type: "query", query: emptied })
  if (!wire.ok) throw new Error("the part does not encode")
  return jsonBytes(wire.value)
}

// Верхня оцінка тіла запиту за кодеком, а не за виміром (джерела:
// `readPartToWire` / `readQueryMap` у `model/runtime/mapping.ts` і
// `knownSchema` / `knownVersionSchema` у `model/runtime/read.ts`):
//  - стала частини (об'єкт, форма): `{"type":"query","query":{...}}` з об'єктом
//    як UUID, колонками фізичних імен і порожнім списком ключів — її кодує
//    сам `readPartToWire`, тож число не вгадане;
//  - ключ у `where` (`in`): 36 символів UUID, дві лапки й кома — 39 Б; його
//    платить кожна частина, і з `known` теж — ключі йдуть і в `where`, і в
//    `known.keys`;
//  - конверт `known` частини: `"known":{"epoch":<64 hex>,"keys":[],"versions":[]}`
//    — кодується з порожніми списками, `epoch` — `versionEpochSchema`;
//  - ключ `known`: 39 Б ключа + версія найдовшою формою `knownVersionSchema`
//    (`^[1-9]\d{0,15}$`: 16 цифр, дві лапки, кома) — 19 Б;
//  - частина `version`: `{"type":"version"}`;
//  - 2 КіБ — запас §12.
const KEY_BYTES = 39
const KNOWN_KEY_BYTES = KEY_BYTES + jsonBytes("9".repeat(16)) + 1
const KNOWN_ENVELOPE_BYTES = jsonBytes({
  known: { epoch: "0".repeat(64), keys: [], versions: [] },
})
export const VERSION_PART_BYTES = jsonBytes({ type: "version" })
const SLACK = 2048
/** §12: the `version` part of a reply, 2 KiB + 128 B per catalog object. */
export const VERSION_BOUND = (objects: number) => 2048 + 128 * objects

export function bodyBound(
  fake: FakeSource,
  reads: readonly FakeReadLog[],
  hasVersion: boolean
): number {
  let bound = SLACK + (hasVersion ? VERSION_PART_BYTES : 0)
  for (const read of reads) {
    bound += partWithoutKeys(fake, read.query!)
    bound += keysOf(read.query).length * KEY_BYTES
    if (read.known !== undefined)
      bound += KNOWN_ENVELOPE_BYTES + read.known.keys.length * KNOWN_KEY_BYTES
  }
  return bound
}
