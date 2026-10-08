import { z } from "zod"
import type { ApiRolePurpose } from "./project"

/**
 * Ролі API, яким об'єкт відкриває читання (спека промоції §9.3). Поле мають
 * лише види з RLS (факт реєстру `rowLevelSecurity`): без RLS таблиця не має
 * політик, і декларації нічим було б виконати. Політику генерує П3 з контракту
 * `publicRead`. Значення — призначення ролі, а не ім'я ролі в базі: ім'я дає
 * `PROVIDER_API_ROLES` провайдера проєкту. Перелік — словник файлів метаданих,
 * тож лишається літералами для `z.enum`, а `satisfies` прив'язує його до
 * призначень.
 */
export const PUBLIC_READ_ROLES = [
  "authenticated",
  "anon",
] as const satisfies readonly ApiRolePurpose[]
export type PublicReadRole = (typeof PUBLIC_READ_ROLES)[number]

export const publicReadSchema = z.enum(PUBLIC_READ_ROLES).optional().meta({
  description:
    "API role that may read every row of the object: authenticated users or anonymous visitors. Absent means no public read.",
})
