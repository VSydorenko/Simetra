import { enumerationSchema } from "../schemas/enumeration"
import { keyOrderOf, type KindDefinition } from "./standard"

/**
 * Значення перерахування — метадані, а не рядки: таблиці немає, посилання на
 * нього фізично — text із CHECK за мітками (спека §5, М15).
 */
export const enumerationKind: KindDefinition = {
  kind: "Enumeration",
  dir: "enumerations",
  schema: enumerationSchema,
  keyOrder: keyOrderOf(enumerationSchema),
  referenceable: true,
  writePattern: "none",
  actions: [],
  materializes: "none",
  declared: false,
  columnFields: [],
  valueElements: true,
  standardColumns: () => [],
  references: () => [],
}
