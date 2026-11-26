import { z } from "zod"
import type { RequestRolePurpose } from "./project"

/**
 * Ролі API, яким об'єкт відкриває читання (спека промоції §9.3). Поле мають
 * лише види з RLS (факт реєстру `rowLevelSecurity`): без RLS таблиця не має
 * політик, і декларації нічим було б виконати. Політику генерує
 * `buildAccessUnits` з контракту `Contracts.access`. Значення — слово файлу метаданих, а не ім'я ролі в базі:
 * призначення дає `PUBLIC_READ_PURPOSES`, ім'я — `PROVIDER_API_ROLES`
 * провайдера проєкту.
 */
export const PUBLIC_READ_ROLES = ["authenticated", "anon"] as const
export type PublicReadRole = (typeof PUBLIC_READ_ROLES)[number]

/**
 * Призначення ролі для кожного значення `publicRead` — лише роль запиту: тип
 * не допускає сервісну роль, тож читання таблиці їй не відкривається
 * (платформна спека §6.7).
 */
export const PUBLIC_READ_PURPOSES: Readonly<
  Record<PublicReadRole, RequestRolePurpose>
> = {
  authenticated: "user",
  anon: "anonymous",
}

/**
 * Умовна форма `publicRead` (спека публічної частини §5.1): роль читає лише
 * опубліковані рядки. `published` — лише `true`: рядкова форма вже означає
 * «усі рядки», а `false` не мав би зрозумілого значення.
 */
export const publicReadConditionalSchema = z.strictObject({
  role: z.enum(PUBLIC_READ_ROLES),
  published: z.literal(true),
})

export type PublicRead =
  PublicReadRole | z.infer<typeof publicReadConditionalSchema>

export const publicReadSchema = z
  .union([z.enum(PUBLIC_READ_ROLES), publicReadConditionalSchema])
  .optional()
  .meta({
    description:
      "API role that may read the object: authenticated users or anonymous visitors. A string opens every row; an object { role, published: true } opens only rows marked published. Absent means no public read.",
  })

/**
 * Роль і ознака умови з обох форм — єдине місце розбору значення поля.
 */
export function parsePublicRead(
  value: PublicRead | undefined
): { role: PublicReadRole; conditional: boolean } | undefined {
  if (value === undefined) return undefined
  return typeof value === "string"
    ? { role: value, conditional: false }
    : { role: value.role, conditional: value.published }
}
