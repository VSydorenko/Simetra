import { pgEnumSchema } from "../schemas/pg-enum"
import { keyOrderOf, type KindDefinition } from "./standard"

/**
 * Прийнятий енам-тип Postgres. На нього посилається лише колонка
 * `CustomTable`, тож загальним посиланням `Ref` він недоступний.
 */
export const pgEnumKind: KindDefinition = {
  kind: "PgEnum",
  dir: "pg-enums",
  schema: pgEnumSchema,
  keyOrder: keyOrderOf(pgEnumSchema),
  referenceable: false,
  writePattern: "none",
  actions: [],
  materializes: "enumType",
  scope: "absent",
  declared: true,
  columnFields: [],
  valueElements: false,
  standardColumns: () => [],
  references: () => [],
}
