/*
 * Доказ осідання (спека ядра синхронізації §5.4, Р-SK2-7): розмічене
 * значення, яким прохід осідання підтверджує вимоги свіжості. Перелік видів —
 * дані: SK-6 додає `visibility-snapshot` і `stream-position` новими
 * варіантами, не змінюючи форми.
 */

/** Види доказу, що вже є; нові види додають сюди й у `Evidence`. */
export const EVIDENCE_KINDS = [
  "session-start",
  "row-version",
  "service-sent",
] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]

export type Evidence =
  /** Відповідь прочитано після старту сесії: доказує лише «не раніше цієї епохи». */
  | { readonly kind: "session-start"; readonly epoch: number }
  /** Версія рядка у своїй епосі версій (з епох версій частин відповіді). */
  | {
      readonly kind: "row-version"
      readonly versionEpoch: string | null
      readonly version: number
    }
  /** Службова частина: епоха миті відправки, а не відповіді. */
  | { readonly kind: "service-sent"; readonly epoch: number }
