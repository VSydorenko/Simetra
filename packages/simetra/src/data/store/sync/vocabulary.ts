import type { ObjectName } from "../types"

/*
 * Словник ядра синхронізації (спека ядра синхронізації §5.2, §5.3, §5.4,
 * Додаток Б): закриті переліки як дані. Назва, якої тут немає, не
 * компілюється, тож походження читання не може вигадати причину чи код.
 * Модуль не залежить від решти сховища, крім типів: його беруть і шлюз
 * допуску, і діагностика.
 */

/** Причини читання (§5.3). */
export const READ_REASONS = [
  "mount",
  "user",
  "retry",
  "requirement",
  "interval",
  "signal",
  "write-confirm",
] as const
export type ReadReason = (typeof READ_REASONS)[number]

/** Умови допуску (§5.3). */
export const ADMISSION_CONDITIONS = [
  "closed",
  "stale-object",
  "discard-bound",
  "tab-hidden",
  "target-invisible",
  "paused",
  "promised",
  "hydrating",
] as const
export type AdmissionCondition = (typeof ADMISSION_CONDITIONS)[number]

/** Види вимог свіжості (§5.2), у порядку таблиці. */
export const REQUIREMENT_KINDS = [
  "composition-unconfirmed",
  "channel-rejoin",
  "hydration-trust",
  "access-narrowed",
  "target-behind-header",
  "min-version",
  "value-hidden",
  "row-unfinished",
  "version-epoch-switched",
  "rights-unconfirmed",
  "version-unconfirmed",
] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/** Види цілей читання (§5.4). */
export const TARGET_KINDS = ["view", "page", "keys", "service"] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

/** Службові частини, які читає ядро (§5.8). */
export const SERVICE_PARTS = ["version", "rights"] as const
export type ServicePart = (typeof SERVICE_PARTS)[number]

/**
 * Коди рядків інвентаря шляхів читання `main` (Додаток Б, колонка «Код»).
 * Тест `.docs` звіряє цей перелік із таблицею спеки в обидва боки.
 */
export const SITE_CODES = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
  "M8",
  "P1",
  "P2",
  "P3",
  "R1",
  "R2",
  "R3",
  "R4",
  "R5",
  "R6",
  "R7",
  "R8",
  "R9",
  "R10",
  "R11",
  "R12",
  "R13",
  "R14",
  "R15",
  "R16",
  "R17",
  "R18",
  "K1",
  "K2",
  "K3",
  "K4",
  "S1",
  "S2",
  "S3",
] as const
export type SiteCode = (typeof SITE_CODES)[number]

/**
 * Службовий код прямих викликів `StoreSource.read` у тестах. Він поза
 * `SITE_CODES` навмисно: це не рядок інвентаря, і збирач О1 не дасть йому
 * пройти як читанню ядра.
 */
export const TEST_SITE = "test" as const
export type TestSite = typeof TEST_SITE

/** Причина читання; вимога несе свій вид. */
export type ReadCause =
  | { readonly reason: Exclude<ReadReason, "requirement"> }
  | { readonly reason: "requirement"; readonly requirement: RequirementKind }

/** Ціль читання: вид і об'єкт (службова частина — її назва). */
export type ReadTarget =
  | {
      readonly kind: Exclude<TargetKind, "service">
      readonly object: ObjectName
    }
  | { readonly kind: "service"; readonly service: ServicePart }

/** Причина й рядок інвентаря: усе походження, крім цілі. */
export type ReadWhy = ReadCause & { readonly site: SiteCode }

/** Походження читання без запитувача й оренди (їх додає `source.ts`). */
export type ReadIntent = ReadCause & {
  readonly target: ReadTarget
  readonly site: SiteCode | TestSite
}
