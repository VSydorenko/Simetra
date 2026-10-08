import { z } from "zod"
import { appSchemaNameSchema } from "./pg-schema"
import { localizedStringSchema } from "./localized-string"
import type { SchemaRule } from "./rules"
import { ATTRIBUTE_CASES, elementNameSchema } from "./identity"
import { NO_SCOPE, scopeKindSchema } from "./scope"

/**
 * Пресети провайдера бази (платформна спека §6.9). Проєкт вибирає пресет
 * ключем, а його вміст — факти образу провайдера — лишається кодом платформи.
 */
export const DATABASE_PROVIDERS = ["supabase"] as const
export type DatabaseProvider = (typeof DATABASE_PROVIDERS)[number]

/** Таблиця провайдера, на яку можна підписатися подією, з її колонками. */
export interface ProviderEventSource {
  schema: string
  table: string
  /** У порядку `ordinal_position` образу; `whenChanged` називає їх як є. */
  columns: readonly string[]
}

/**
 * Таблиці провайдера, які застосунок може слухати підпискою (спека промоції
 * §9.3): запис у них команд платформи не проходить (реєстрація користувача,
 * завантаження файлу). Колонки — факт образу провайдера; розходження з
 * локальним стеком ловить DB-тест, а лежання на поверхні тригерів пресету
 * схеми — тест T2 (T0 його не імпортує).
 */
export const PROVIDER_EVENT_SOURCES: Readonly<
  Record<DatabaseProvider, readonly ProviderEventSource[]>
> = {
  supabase: [
    {
      schema: "auth",
      table: "users",
      columns: [
        "instance_id",
        "id",
        "aud",
        "role",
        "email",
        "encrypted_password",
        "email_confirmed_at",
        "invited_at",
        "confirmation_token",
        "confirmation_sent_at",
        "recovery_token",
        "recovery_sent_at",
        "email_change_token_new",
        "email_change",
        "email_change_sent_at",
        "last_sign_in_at",
        "raw_app_meta_data",
        "raw_user_meta_data",
        "is_super_admin",
        "created_at",
        "updated_at",
        "phone",
        "phone_confirmed_at",
        "phone_change",
        "phone_change_token",
        "phone_change_sent_at",
        "confirmed_at",
        "email_change_token_current",
        "email_change_confirm_status",
        "banned_until",
        "reauthentication_token",
        "reauthentication_sent_at",
        "is_sso_user",
        "deleted_at",
        "is_anonymous",
      ],
    },
    {
      schema: "storage",
      table: "objects",
      columns: [
        "id",
        "bucket_id",
        "name",
        "owner",
        "created_at",
        "updated_at",
        "last_accessed_at",
        "metadata",
        "path_tokens",
        "version",
        "owner_id",
        "user_metadata",
        "archived_at",
        "is_delete_marker",
        "is_versioned",
      ],
    },
  ],
}

/**
 * Ролі API провайдера за призначенням (спека користувачів §3): від них
 * виконуються запити API — із сесією користувача, без сесії й із сервісним
 * ключем. Імена ролей генератори беруть лише звідси, за
 * `project.database.provider`. Типовими привілеями своїх схем провайдер дає
 * кожній із них `EXECUTE` на кожну нову функцію (на Supabase — `ALTER DEFAULT
 * PRIVILEGES … IN SCHEMA public`); `REVOKE … FROM PUBLIC` такий грант не
 * знімає, тож функція з обмеженим `EXECUTE` відкликає його в кожної
 * неназваної ролі поштучно. Збіг зі стеком перевіряє DB-тест членства.
 */
export interface ProviderApiRoles {
  /** Запит із сесією користувача. */
  authenticated: string
  /** Запит без сесії. */
  anon: string
  /** Сервісний ключ: сесії немає, RLS обходиться. */
  service: string
}
export type ApiRolePurpose = keyof ProviderApiRoles

export const PROVIDER_API_ROLES: Readonly<
  Record<DatabaseProvider, ProviderApiRoles>
> = {
  supabase: {
    authenticated: "authenticated",
    anon: "anon",
    service: "service_role",
  },
}

/**
 * Звідки береться відображуване ім'я нового користувача: колонка таблиці
 * облікових записів або ключ JSON-колонки метаданих.
 */
export type IdentityNameSource =
  { column: string } | { json: string; key: string }

/**
 * Таблиця облікових записів провайдера ідентичності для тригерної провізії
 * (спека користувачів §5): SQL провізії й недійсності платформа генерує один
 * загальний над цими фактами, тож новий провайдер — новий запис даних, а не
 * новий SQL. Ключ облікового запису — uuid: він і `subject` (як текст), і
 * `id` рядка «Користувачі» (С8).
 */
export interface IdentitySource {
  table: { schema: string; name: string }
  keyColumn: string
  /** Джерела найменування за пріоритетом; порожні значення пропускаються. */
  nameSources: readonly IdentityNameSource[]
  /** Ознака анонімного входу: такі облікові записи не провізуються. */
  anonymousColumn?: string
  /** М'яке видалення облікового запису: ненульове значення — недійсність. */
  deletedAtColumn?: string
  /** Значення `simetra.identities.provider` для цього провайдера. */
  providerKey: string
}

/**
 * Факти провайдера ідентичності за пресетом бази. Колонки — факт образу
 * провайдера: їх наявність на стеку перевіряє DB-тест, а лежання таблиці на
 * поверхні тригерів пресету — тест T2 (T0 його не імпортує).
 *
 * Чого `IdentitySource` не виражає — межа, яку другий провайдер перевіряє
 * першою, бо платформний шар вважає це спільним для всіх:
 * - контракт сесії: `current_setting('request.jwt.claims')` і claim `sub`
 *   у ньому (функція поточного користувача);
 * - правило С8: ключ облікового запису — uuid, він же `id` користувача, а
 *   `subject` — цей ключ як `::text`;
 * - імена ролей API — окремий факт T0, `PROVIDER_API_ROLES` вище;
 * - фіксовані імена функцій і тригерів шару (`simetra.current_user_id`,
 *   `simetra.provision_user`, `simetra_provision_user` тощо) — у генераторі
 *   T1, не в даних провайдера.
 */
export const PROVIDER_IDENTITY_SOURCES: Readonly<
  Record<DatabaseProvider, IdentitySource>
> = {
  supabase: {
    table: { schema: "auth", name: "users" },
    keyColumn: "id",
    nameSources: [
      { json: "raw_user_meta_data", key: "full_name" },
      { json: "raw_user_meta_data", key: "name" },
      { column: "email" },
    ],
    anonymousColumn: "is_anonymous",
    deletedAtColumn: "deleted_at",
    providerKey: "supabase",
  },
}

/** Файл проєкту: ідентичність, правила іменування й часовий пояс застосунку. */
export const projectSchema = z
  .strictObject({
    $schema: z.string().optional().meta({
      description: "Editor hint: path to the JSON Schema of this file.",
    }),
    name: z.string().meta({ description: "Application name." }),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the application.",
    }),
    defaultLocale: z
      .enum(["uk", "en"])
      .default("uk")
      .meta({ description: "Locale used when none is requested." }),
    defaultSchema: appSchemaNameSchema.default("public").meta({
      description: "PostgreSQL schema for objects that declare none.",
    }),
    // Без дефолту Zod: тихий дефолт сховав би від застосунку рішення, на якому
    // стоїть межа керування базою. Дефолт існує лише на межі `introspect`.
    database: z
      .strictObject({
        provider: z.enum(DATABASE_PROVIDERS).meta({
          description:
            "Database provider preset that defines the management boundary.",
        }),
      })
      .meta({ description: "Database of the application." }),
    naming: z
      .strictObject({
        attributeCase: z.enum(ATTRIBUTE_CASES).default("camelCase").meta({
          description: "Casing style of logical attribute names.",
        }),
      })
      .default({ attributeCase: "camelCase" })
      .meta({ description: "Naming rules of the application." }),
    /**
     * IANA-пояс, у якому платформа визначає день, місяць, квартал і рік
     * моменту (спека П2 §3). Існування імені перевіряє компілятор
     * (`project.timezone-unknown`) за переліком поясів рушія.
     */
    timezone: z.string().min(1).default("UTC").meta({
      description:
        "IANA time zone in which the platform determines day, month, quarter and year.",
    }),
    scopeKinds: z.array(scopeKindSchema).default([]).meta({
      description:
        "Scope kinds of the application; leave empty for a single-tenant application.",
    }),
    // Бакет — ключ політик сховища провайдера; сам бакет створює провайдер,
    // а тут лише декларація, за якою П3 генерує політики за скоупом.
    storageBuckets: z
      .array(
        z.strictObject({
          bucket: z.string().min(1).meta({
            description: "Name of the provider storage bucket.",
          }),
          scopeKind: elementNameSchema.meta({
            description:
              "Name of the project scope kind that scopes access to the bucket.",
          }),
        })
      )
      .default([])
      .meta({
        description:
          "Provider storage buckets whose access policies follow a scope kind.",
      }),
  })
  .superRefine((project, ctx) => {
    project.scopeKinds.forEach((kind, index) => {
      // `none` — значення `scope` об'єкта «поза скоупом»; вид з таким іменем
      // зробив би його неоднозначним.
      if (kind.name === NO_SCOPE) {
        ctx.addIssue({
          code: "custom",
          message: `Scope kind name "${NO_SCOPE}" is reserved`,
          path: ["scopeKinds", index, "name"],
          params: { rule: "scope.name-reserved" satisfies SchemaRule },
        })
      }
    })
  })

export type Project = z.infer<typeof projectSchema>
