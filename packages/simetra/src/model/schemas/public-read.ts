import { z } from "zod"
import type { RequestRolePurpose } from "./project"

/**
 * Ролі API, яким об'єкт відкриває читання (спека промоції §9.3). Поле мають
 * лише види з RLS (факт реєстру `rowLevelSecurity`): без RLS таблиця не має
 * політик, і декларації нічим було б виконати. Політику генерує П3 з контракту
 * `publicRead`. Значення — слово файлу метаданих, а не ім'я ролі в базі:
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

export const publicReadSchema = z.enum(PUBLIC_READ_ROLES).optional().meta({
  description:
    "API role that may read every row of the object: authenticated users or anonymous visitors. Absent means no public read.",
})
