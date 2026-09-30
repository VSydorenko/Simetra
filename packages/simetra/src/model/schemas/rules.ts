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
] as const

export type SchemaRule = (typeof SCHEMA_RULES)[number]
