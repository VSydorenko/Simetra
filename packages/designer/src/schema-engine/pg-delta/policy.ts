import {
  supabasePolicy,
  supabaseProfile,
  validatePolicy,
  type IntegrationProfile,
  type Policy,
} from "@supabase/pg-delta"
import {
  SUPABASE_EXTENSIONS,
  SUPABASE_SCHEMAS,
  type EngineScope,
} from "simetra/schema"

/**
 * Політика межі §6.9 поверх `supabasePolicy`. Фільтр двигуна — «перше збігле
 * правило виграє», а власні правила стоять перед успадкованими, тож наші
 * правила лише звужують межу, а правила пресета вирішують, що в схемах
 * провайдера належить застосунку (тригер на `auth.users`, політика на
 * `storage.objects`, членство в `supabase_realtime`).
 *
 * Керована схема керується цілком, зокрема її типові привілеї для ролей
 * провайдера: бажаний стан оголошує їх явно (рішення плану E2a за спайком, 6).
 * Гранти самої схеми `public` політика теж не виключає: базовий стан дає
 * пресет провайдера (спека промоції §9.9) — тінь засіяна ним, а зворотна
 * генерація пише одиницею лише відмінність цілі від пресету.
 */
export function scopePolicy(scope: EngineScope): Policy {
  const inside = [...scope.schemas, ...SUPABASE_SCHEMAS]
  const policy: Policy = {
    id: "simetra-scope",
    extends: [supabasePolicy],
    filter: [
      {
        match: {
          all: [{ kind: "extension" }, { name: [...SUPABASE_EXTENSIONS] }],
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

/** Профіль двигуна для межі: пресет Supabase з політикою межі замість його власної. */
export function scopeProfile(scope: EngineScope): IntegrationProfile {
  return {
    ...supabaseProfile,
    id: "simetra-supabase",
    policy: scopePolicy(scope),
  }
}
