import {
  supabasePolicy,
  supabaseProfile,
  validatePolicy,
  type IntegrationProfile,
  type Policy,
} from "@supabase/pg-delta"
import { PROVIDER_UNMANAGED_EXTENSIONS, type EngineScope } from "simetra/schema"
import { PROVIDER_SCHEMAS } from "simetra/model"

/**
 * Базова політика провайдера `postgres` (рішення Р1 плану ПГ-2a): власна, не
 * похідна від Supabase. `better_auth` припущена (її створює міграція Better
 * Auth), але керованим лишається лише тригер застосунку на `better_auth.user`;
 * `extensions` — жорстке виключення. Виключена, але припущена схема стає
 * reference-only, тож без виключення ACL план відкликав би гранти `roles` на
 * `better_auth`, а засів тіні видав би `CREATE SCHEMA "extensions"` (42P06).
 */
export const postgresBasePolicy: Policy = {
  id: "simetra-postgres-base",
  assumedSchemas: ["better_auth"],
  filter: [
    {
      match: {
        all: [
          { kind: "trigger" },
          { schema: "better_auth" },
          { idField: { field: "table", glob: "user" } },
          { not: { edgeTo: { kind: "function", schema: "better_auth" } } },
        ],
      },
      action: "include",
    },
    {
      match: { schema: ["better_auth", "extensions"] },
      action: "exclude",
    },
    {
      match: {
        all: [{ kind: "schema" }, { name: ["better_auth", "extensions"] }],
      },
      action: "exclude",
    },
    {
      match: {
        all: [
          { kind: ["acl", "comment", "securityLabel"] },
          {
            any: [
              { target: { schema: ["better_auth", "extensions"] } },
              {
                target: {
                  kind: "schema",
                  name: ["better_auth", "extensions"],
                },
              },
            ],
          },
        ],
      },
      action: "exclude",
    },
  ],
}

const PROVIDER_BASE_POLICY: Record<EngineScope["provider"], Policy> = {
  supabase: supabasePolicy,
  postgres: postgresBasePolicy,
}

/**
 * Політика межі §6.9 поверх базової політики провайдера. Фільтр двигуна — «перше збігле
 * правило виграє», а власні правила стоять перед успадкованими, тож наші
 * правила лише звужують межу, а правила пресета вирішують, що в схемах
 * провайдера належить застосунку (тригер на `auth.users`, політика на
 * `storage.objects`, членство в `supabase_realtime`).
 *
 * Керована схема керується цілком, зокрема її типові привілеї для ролей
 * провайдера: бажаний стан оголошує їх явно (платформна спека §6.9).
 * Гранти самої схеми `public` політика теж не виключає: базовий стан дає
 * пресет провайдера (спека промоції §9.9) — тінь засіяна ним, а зворотна
 * генерація пише одиницею лише відмінність цілі від пресету.
 */
export function scopePolicy(scope: EngineScope): Policy {
  const inside = [...scope.schemas, ...PROVIDER_SCHEMAS[scope.provider]]
  const policy: Policy = {
    id: "simetra-scope",
    extends: [PROVIDER_BASE_POLICY[scope.provider]],
    filter: [
      {
        match: {
          all: [
            { kind: "extension" },
            { name: [...PROVIDER_UNMANAGED_EXTENSIONS[scope.provider]] },
          ],
        },
        action: "exclude",
      },
      // Предикат `schema` не спрацьовує на факті без схеми (розширення,
      // publication, ACL), тому `{ schema: "*" }` обмежує правило фактами зі схемою
      {
        match: { all: [{ schema: "*" }, { not: { schema: inside } }] },
        action: "exclude",
      },
      {
        match: { all: [{ kind: "schema" }, { not: { name: inside } }] },
        action: "exclude",
      },
      // Сателіти (гранти, коментарі, мітки) некерованих об'єктів і схем:
      // їхня власна схема — порожня, межу визначає ціль
      {
        match: {
          all: [
            { kind: ["acl", "comment", "securityLabel"] },
            {
              any: [
                {
                  all: [
                    { target: { schema: "*" } },
                    { not: { target: { schema: inside } } },
                  ],
                },
                {
                  all: [
                    { target: { kind: "schema" } },
                    { not: { target: { kind: "schema", name: inside } } },
                  ],
                },
              ],
            },
          ],
        },
        action: "exclude",
      },
      // Глобальні типові привілеї (без схеми) не належать жодній схемі застосунку
      {
        match: {
          all: [{ kind: "defaultPrivilege" }, { not: { schema: "*" } }],
        },
        action: "exclude",
      },
    ],
  }
  validatePolicy(policy)
  return policy
}

/**
 * Профіль двигуна для межі. Supabase: пресет з політикою межі замість його
 * власної. Postgres: без обробників розширень і без пресету провайдера.
 */
export function scopeProfile(scope: EngineScope): IntegrationProfile {
  const policy = scopePolicy(scope)
  if (scope.provider === "postgres")
    return { id: "simetra-postgres", handlers: [], policy }
  return { ...supabaseProfile, id: "simetra-supabase", policy }
}
