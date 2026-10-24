import {
  COMMAND_SETTING,
  PLATFORM_SCHEMA,
  type DatabaseProvider,
} from "simetra/model"
import { qualified, type Contracts, type QualifiedName } from "../contracts"
import { compareStrings } from "../diagnostics"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import { hasRightsFunctions } from "./functions"

const platform = (name: string): QualifiedName => ({
  schema: PLATFORM_SCHEMA,
  name,
})

/**
 * Імена функцій контексту команди (спека прав §5.3, Р2b1-2): одне місце для
 * генератора, політик запису, тригера ефектів і тестів. `parsed` —
 * приватний розбір, решта — поверхні над ним.
 */
export const COMMAND_FUNCTIONS = {
  parsed: platform("command_parsed"),
  action: platform("command_action"),
  root: platform("command_root"),
  current: platform("command_current"),
} as const satisfies Record<string, QualifiedName>

type Contract = Pick<Contracts, "rights" | "roles" | "users">

/**
 * Пари (`object`, `action`), які команда може назвати: дії з непорожнім
 * `effects.dml` (дія без запису не є командою). Перелік вшито в розбір, щоб
 * вигадана дія не пропускала записів за природною дією іншого об'єкта.
 */
function actionPairs(rights: Contract["rights"]): [string, string][] {
  return rights
    .flatMap((contract) =>
      contract.actions
        .filter((action) => action.effects.dml.length > 0)
        .map((action): [string, string] => [contract.kindLabel, action.action])
    )
    .sort((a, b) => compareStrings(a[0], b[0]) || compareStrings(a[1], b[1]))
}

/**
 * Генератор `command` (Р2b1-2): розбір налаштування `COMMAND_SETTING` один,
 * три поверхні лише кличуть його — розсинхрону формату між ними немає.
 * `LANGUAGE plpgsql STABLE SECURITY INVOKER`: розбір не потребує прав на
 * дані, а `EXECUTE` має лише роль команд. Тіла plpgsql граф не читає, тож
 * кожна поверхня називає розбір явним ребром `requires`.
 */
export function buildCommandUnits(
  contracts: Contract,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts)) return []
  const F = COMMAND_FUNCTIONS
  const parsedNode: CreationNode = {
    type: "unit",
    // Ідентичність канонізує `boolean` до `bool` (як `pg_proc`).
    identity: `function:${qualified(COMMAND_FUNCTIONS.parsed)}(bool)`,
  }
  const declarations: {
    fn: QualifiedName
    /** Аргументи з іменами — у `CREATE`; лише типи — у `GRANT`. */
    args: string
    types: string
    returns: string
    body: string
    requires?: readonly CreationNode[]
  }[] = [
    {
      fn: F.parsed,
      args: "p_strict boolean, OUT action text, OUT object text, OUT root uuid",
      types: "boolean",
      returns: "record",
      body: parsedBody(actionPairs(contracts.rights)),
    },
    {
      fn: F.action,
      args: "",
      types: "",
      returns: "text",
      body: `BEGIN\n  RETURN (SELECT p.action FROM ${qualified(F.parsed)}(true) AS p);\nEND`,
      requires: [parsedNode],
    },
    {
      fn: F.root,
      args: "p_object text",
      types: "text",
      returns: "uuid",
      // Корінь лише для свого об'єкта: інший об'єкт у контексті — не корінь.
      body: `BEGIN\n  RETURN (SELECT CASE WHEN p.object = p_object THEN p.root END FROM ${qualified(F.parsed)}(true) AS p);\nEND`,
      requires: [parsedNode],
    },
    {
      fn: F.current,
      args: "OUT action text, OUT object text, OUT root uuid",
      types: "",
      returns: "record",
      // Безвиняткова для відсутнього контексту: тригер ефектів має відрізнити
      // «контексту немає» без винятку.
      body: `BEGIN\n  SELECT p.action, p.object, p.root INTO action, object, root FROM ${qualified(F.parsed)}(false) AS p;\n  RETURN;\nEND`,
      requires: [parsedNode],
    },
  ]
  return declarations
    .flatMap(({ fn, args, types, returns, body, requires }) => {
      const tag = dollarTag(body)
      const create =
        `CREATE OR REPLACE FUNCTION ${qualified(fn)}(${args})\n` +
        `RETURNS ${returns}\n` +
        `LANGUAGE plpgsql STABLE SECURITY INVOKER\n` +
        `SET search_path = ''\n` +
        `AS ${tag}\n${body}\n${tag};`
      return [
        { sql: create, requires },
        ...executeGrants(
          `${qualified(fn)}(${types})`,
          ["command"],
          provider
        ).map((sql) => ({ sql, requires: undefined })),
      ]
    })
    .map(({ sql, requires }): SqlUnit => ({
      ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
      module,
      generator: "command",
      ...(requires === undefined ? {} : { requires }),
    }))
    .sort((a, b) => compareStrings(a.identity, b.identity))
}

/**
 * Тіло розбору. Відмова — завжди `42501` / `command.context`; `DETAIL`
 * каже причину: `missing` (лише суворий розбір), `malformed` (не об'єкт JSON,
 * ключі не рівно три, порожній `action`/`object`, `root` не UUID) і
 * `unknown-action` (пари немає серед дій із записом). `pg_input_is_valid` —
 * без підтранзакції, яку дав би блок `EXCEPTION`.
 */
function parsedBody(pairs: readonly [string, string][]): string {
  const raise = (detail: string) =>
    `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.context', DETAIL = '${detail}';`
  // Порожній перелік: пара з `NULL` нічому не дорівнює — відмова за будь-якої дії.
  const values =
    pairs.length === 0
      ? "(NULL::text, NULL::text)"
      : pairs.map(([o, a]) => `(${sqlLiteral(o)}, ${sqlLiteral(a)})`).join(", ")
  return [
    "DECLARE",
    `  v_raw text := current_setting(${sqlLiteral(COMMAND_SETTING)}, true);`,
    "  v_ctx jsonb;",
    "BEGIN",
    "  IF v_raw IS NULL OR v_raw = '' THEN",
    "    IF p_strict THEN",
    `      ${raise("missing")}`,
    "    END IF;",
    "    RETURN;",
    "  END IF;",
    "  IF NOT pg_input_is_valid(v_raw, 'jsonb') THEN",
    `    ${raise("malformed")}`,
    "  END IF;",
    "  v_ctx := v_raw::jsonb;",
    "  IF jsonb_typeof(v_ctx) IS DISTINCT FROM 'object'",
    "    OR (SELECT count(*) FROM jsonb_object_keys(v_ctx)) <> 3",
    "    OR jsonb_typeof(v_ctx -> 'action') IS DISTINCT FROM 'string'",
    "    OR jsonb_typeof(v_ctx -> 'object') IS DISTINCT FROM 'string'",
    "    OR jsonb_typeof(v_ctx -> 'root') IS DISTINCT FROM 'string'",
    "    OR (v_ctx ->> 'action') = ''",
    "    OR (v_ctx ->> 'object') = ''",
    "    OR NOT pg_input_is_valid(v_ctx ->> 'root', 'uuid') THEN",
    `    ${raise("malformed")}`,
    "  END IF;",
    "  action := v_ctx ->> 'action';",
    "  object := v_ctx ->> 'object';",
    "  root := (v_ctx ->> 'root')::uuid;",
    `  IF NOT EXISTS (SELECT 1 FROM (VALUES ${values}) AS t (o, a) WHERE t.o = object AND t.a = action) THEN`,
    `    ${raise("unknown-action")}`,
    "  END IF;",
    "  RETURN;",
    "END",
  ].join("\n")
}
