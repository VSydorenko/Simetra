import { z } from "zod"
import type { SchemaRule } from "./rules"

/** Ім'я файлу переліку боргу в корені `metadata/`. */
export const SQL_DEBT_FILE = "sql-debt.json"

/**
 * Перелік боргу дослівного SQL (план промоції 2b, рішення 12): ідентичності
 * одиниць поза закритою оболонкою, які тека вже мала, коли її розклав
 * `introspect`. Ратчет лише звужується: нова одиниця боргу, якої тут немає, —
 * помилка компіляції, а `fix` лише прибирає записи. Відсортований і без
 * дублів — тоді diff переліку показує саме зміну боргу, а не порядок запису.
 */
export const sqlDebtSchema = z
  .strictObject({
    $schema: z.string().optional().meta({
      description: "Editor hint: path to the JSON Schema of this file.",
    }),
    units: z.array(z.string()).meta({
      description:
        "Identities of verbatim SQL units accepted as debt (outside the closed function shell), sorted and without duplicates. Written by introspect; fix only removes entries.",
    }),
  })
  .meta({
    description:
      "Debt ratchet of verbatim SQL: a debt unit missing from this list is an error.",
  })
  .superRefine((debt, ctx) => {
    debt.units.forEach((unit, index) => {
      const previous = debt.units[index - 1]
      // Порівняння за кодовими одиницями, як у компілятора: порядок не
      // залежить від локалі середовища.
      if (index > 0 && !(previous! < unit)) {
        ctx.addIssue({
          code: "custom",
          message:
            previous === unit
              ? `Debt entry "${unit}" is listed twice`
              : `Debt entry "${unit}" is out of order`,
          path: ["units", index],
          params: { rule: "debt.not-canonical" satisfies SchemaRule },
        })
      }
    })
  })

export type SqlDebt = z.infer<typeof sqlDebtSchema>
