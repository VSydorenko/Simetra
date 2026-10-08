/**
 * Коди власних перевірок T0. Кожна перевірка, що не виражається самою схемою
 * Zod, додає issue з `params: { rule }` — так споживачі (стадії валідації,
 * студія) розпізнають порушення за стабільним кодом, а не за текстом
 * повідомлення. Нові коди дописують задачі, що додають перевірки.
 */
export const SCHEMA_RULES = [
  "type.length-required",
  "type.length-not-allowed",
  "type.precision-not-allowed",
  "type.scale-requires-precision",
  "type.ref-target-required",
  "type.ref-exclusive",
  "type.ref-not-allowed",
  "register.balance-control-type",
  "customTable.column-type",
  "customTable.identity-type",
  "pgEnum.value-duplicate",
  "scope.name-reserved",
  "scope.not-allowed",
  "type.cross-scope-not-allowed",
  "type.default-not-allowed",
  "type.default-mismatch",
  "type.default-invalid",
  "type.default-fill-mismatch",
  "type.default-empty-mismatch",
  "type.unique-ignore-case-type",
  "attribute.unique-within-requires-unique",
  "type.bound-type",
  "type.bound-conflict",
  "type.bound-order",
  "type.bound-invalid",
  "type.format-type",
  "type.pattern-invalid",
  "posting.parse",
  "debt.not-canonical",
] as const

export type SchemaRule = (typeof SCHEMA_RULES)[number]
