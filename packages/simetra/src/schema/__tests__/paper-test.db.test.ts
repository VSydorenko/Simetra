import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { readCatalog } from "../../../test/db/catalog"
import { withRollback } from "../../../test/db/connection"
import {
  diffCatalogs,
  scopeReplacementViolations,
  type CatalogDiff,
} from "../../../test/db/diff"
import { readReferenceDomain } from "../../compiler/__tests__/fixtures/reference-domain"

/**
 * Паперовий тест (спека П2 §10.2, М4): рукописна «прийнята» форма документа
 * `ServiceAccrual` — так його написав би застосунок без платформи — і рендер
 * скомпільованого домену розгортаються в схеми `accepted` і `app` однієї
 * транзакції з відкатом (тінь E1). Різниця «прийнята → скомпільована» має бути
 * рівно відсутніми стандартними елементами виду; фікстура — їхній точний
 * перелік, тож будь-яка інша зміна моделі чи рендера валить тест.
 */

const ACCEPTED = new URL(
  "../../../../../examples/reference/accepted/",
  import.meta.url
)

/** Таблиці документа, його ТЧ і регістрів — предмет порівняння (§10.2). */
const TABLES = [
  "service_accrual",
  "service_accrual_services",
  "service_accrual_performers",
  "performer_settlements",
  "performer_settlements_turnovers_month",
  "performer_settlements_totals",
  "income_expenses",
  "income_expenses_turnovers_month",
]

describe("paper test", () => {
  it("compiled minus accepted is exactly the kind's standard elements", async () => {
    const result = await compile(readReferenceDomain())
    expect(result.diagnostics).toEqual([])
    const expected = JSON.parse(
      readFileSync(new URL("expected-diff.json", ACCEPTED), "utf8")
    ) as CatalogDiff

    // Носій скоупу таблиці бере вид (фізичний знімок), а не тест: перша
    // колонка, що несе значення скоупу.
    const carriers = new Map<string, string>()
    for (const table of result.model!.physical.tables) {
      const carrier = table.columns.find(
        (column) => column.origin.scopeKindId !== undefined
      )
      if (carrier !== undefined) carriers.set(table.name, carrier.name)
    }

    const { accepted, compiled } = await withRollback(async (client) => {
      await client.query(renderDesiredState(result.model!).sql)
      await client.query(
        readFileSync(new URL("service-accrual.sql", ACCEPTED), "utf8")
      )
      // Кожна схема — окремим читанням: плейсхолдер схеми в текстах тоді
      // однозначний, і однакові об'єкти двох схем дають однакові форми.
      return {
        accepted: await readCatalog(client, ["accepted"]),
        compiled: await readCatalog(client, ["app"]),
      }
    })
    const diff = diffCatalogs(accepted, compiled, TABLES)

    // Фікстура — повний перелік, тож будь-яка нова різниця валить тест.
    expect(diff).toEqual(expected)
    // Правило М4 окремо від фікстури: змін немає, а кожне видалення — простий
    // FK чи індекс посилання, замінений складеним із носієм скоупу першим.
    // Прийнята форма лишається чесною (звичайні FK), тож заміна в плані є.
    expect(
      scopeReplacementViolations(diff, accepted, compiled, carriers)
    ).toEqual([])
  })
})
