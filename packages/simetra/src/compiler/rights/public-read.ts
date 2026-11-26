import type { AccessContract } from "../contracts"
import { renderCondition, type RightsCondition } from "./predicates"

/**
 * Чи відкриває `publicRead` рядки лише дійсному користувачу (спека прав §5.2):
 * `authenticated` — так, бо сесія з недійсним чи не прив'язаним користувачем
 * (`current_user_id()` — NULL) не відрізняється від гостя, а гостю об'єкт
 * закритий; `anon` — ні, гість і так читає. Без функції користувача
 * (`hasSessionUser`) дійсність судити нічим — рядки відкриті ролі запиту, як і
 * досі.
 */
export function publicReadNeedsUser(
  contract: Pick<AccessContract, "publicRead">,
  sessionUser: boolean
): boolean {
  return (
    sessionUser &&
    contract.publicRead.length > 0 &&
    contract.publicRead.every((purpose) => purpose === "user")
  )
}

/**
 * Умова публічного читання таблиці (спека прав §5.2, §5.4) — AND умов; порожній
 * масив — `true`. Єдиний будівник для політики `<t>_public_read`, гілки
 * запобіжника й пояснення прав: інакше шляхи розійшлися б і пояснення чи
 * запобіжник відкрили б рядок, якого RLS не показує. Умова форми — логічні
 * `field`, а не колонки: той самий вузол для шапки й її ТЧ, колонку своєї
 * таблиці обирає рендер за `AccessContract.published`.
 */
export function publicReadConditions(
  contract: Pick<AccessContract, "publicRead" | "published">,
  sessionUser: boolean
): RightsCondition[] {
  // Порожній масив — `true`: без цієї перевірки таблиця без `publicRead`
  // відкрилась би кожному.
  if (contract.publicRead.length === 0) {
    throw new Error("internal: public read conditions of a closed table")
  }
  return [
    ...(contract.published === undefined
      ? []
      : [
          { kind: "rowLiteral", field: "published", value: true } as const,
          { kind: "rowLiteral", field: "deletionMark", value: false } as const,
        ]),
    ...(publicReadNeedsUser(contract, sessionUser)
      ? [{ kind: "validUser" } as const]
      : []),
  ]
}

/**
 * Чи відкриває `publicRead` таблиці всі рядки — рядкова форма без умови
 * публікації. Одне джерело для читачів «усі рядки відкриті»: межі читання,
 * політик прав, запобіжника, пояснення, сигналу й каталогу рантайму.
 */
export function opensEveryRow(
  contract: Pick<AccessContract, "publicRead" | "published">
): boolean {
  return contract.publicRead.length > 0 && contract.published === undefined
}

/** Чи відкриває `publicRead` лише опубліковані рядки (умовна форма). */
export function opensPublishedRows(
  contract: Pick<AccessContract, "publicRead" | "published">
): boolean {
  return contract.publicRead.length > 0 && contract.published !== undefined
}

/**
 * Текст AND умов будівника над колонками таблиці `published`; `row` — змінна
 * рядка чи псевдонім, як у `renderCondition`.
 */
export function renderConditions(
  conditions: readonly RightsCondition[],
  published: AccessContract["published"],
  row?: string
): string {
  return conditions.length === 0
    ? "true"
    : conditions.map((c) => renderCondition(c, row, published)).join(" AND ")
}
