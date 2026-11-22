import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import { COMMAND_SETTING, PLATFORM_ROLES } from "simetra/model"
import { buildPlan, executePlan } from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from "../schema-engine"
import { readSetupStatement } from "../../../simetra/src/server/transaction"
import {
  GAUGE_TABLE,
  claimsFor,
  gaugeCasLayer,
  policyDomain,
  profileLayer,
  setLocalSetting,
  withSessionOptions,
} from "../../../simetra/test/support"
import {
  heldResource,
  ownerLoginOf,
  seedRuntimeActor,
  withModelTarget,
  type RuntimeActor,
} from "./support/db"

/**
 * CAS за полями в ядрі `save` (спека П4 §6.6, І5, І11) над застосованою
 * ціллю. Що рівність закодованих форм (`to_jsonb` рядка «до» і бази,
 * приведеної до типу колонки) відрізняє зміну від тієї самої величини в
 * іншому записі — масштаб `numeric`, дублі ключів `json`, сусіднє
 * `double precision`, той самий момент в іншому поясі, — вирішує Postgres:
 * unit-тест бачить лише текст тіла. Сесія навмисно ворожа
 * (`extra_float_digits = -3`, пояс не UTC), а кожна команда ставить
 * налаштування справжнім оператором транзакції T3 — так доводиться І11.
 */

/** Сесія як від `ALTER ROLE … SET` ролі входу: без кроку налаштувань CAS збігся б хибно. */
const HOSTILE = "-c extra_float_digits=-3 -c TimeZone=Asia/Tokyo"

async function compiled(): Promise<CompiledModel> {
  const result = await compile(policyDomain(gaugeCasLayer(), profileLayer()))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

type Row = Record<string, unknown>

interface Env {
  owner: pg.Client
  session: pg.Client
  actor: RuntimeActor
}

/** Один виклик `save`: вхід, версія-база й база CAS за полями. */
interface Step {
  item: Row
  version: string
  expected: Row | null
}

/**
 * Виклики ядра в одній транзакції команди: claims з кожним закріпленим
 * налаштуванням T3 і роль команд (`readSetupStatement` — той самий текст
 * claims, що й у команди), далі `save` кожного кроку зі своїм контекстом.
 * `commit` — зберегти; інакше відкат (читання рядка через ядро). Результат —
 * останнього кроку; відмова — помилка Postgres.
 */
async function saveSteps(
  env: Env,
  steps: readonly Step[],
  commit: boolean
): Promise<Row | pg.DatabaseError> {
  const { session } = env
  await session.query("BEGIN")
  try {
    const setup = readSetupStatement(
      JSON.stringify(claimsFor("user", env.actor.user)),
      15_000,
      16_000,
      PLATFORM_ROLES.command
    )
    await session.query(setup.text, [...setup.params])
    let result: Row = {}
    for (const { item, version, expected } of steps) {
      await setLocalSetting(
        session,
        COMMAND_SETTING,
        JSON.stringify({ action: "update", object: GAUGE_TABLE, root: item.id })
      )
      const { rows } = await session.query<{ r: string }>(
        `SELECT public.${GAUGE_TABLE}_save($1::jsonb, $2::bigint, $3::jsonb) AS r`,
        [
          JSON.stringify(item),
          version,
          expected === null ? null : JSON.stringify(expected),
        ]
      )
      result = JSON.parse(rows[0]!.r) as Row
    }
    await session.query(commit ? "COMMIT" : "ROLLBACK")
    return result
  } catch (error) {
    await session.query("ROLLBACK")
    if (error instanceof pg.DatabaseError) return error
    throw error
  }
}

const save = (
  env: Env,
  item: Row,
  version: string,
  expected: Row | null,
  commit: boolean
) => saveSteps(env, [{ item, version, expected }], commit)

const target = heldResource<Env>(async (use) => {
  const model = await compiled()
  await withModelTarget(model, async (url) => {
    const owner = new pg.Client({ connectionString: url })
    await owner.connect()
    try {
      // Типи прийнятої таблиці, яких логічні типи не дають; ядро бере тип
      // колонки з бази (`jsonb_populate_record`, `to_jsonb` рядка)
      await owner.query(
        `ALTER TABLE public.${GAUGE_TABLE} ALTER COLUMN ratio TYPE double precision, ALTER COLUMN raw TYPE json USING raw::json`
      )
      const actor = await seedRuntimeActor(owner)
      const session = new pg.Client({
        connectionString: withSessionOptions(url, HOSTILE),
      })
      await session.connect()
      try {
        await use({ owner, session, actor })
      } finally {
        await session.end()
      }
    } finally {
      await owner.end()
    }
  })
})

describe("CAS by fields in the save core", () => {
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  /** Рядок `Gauge`, записаний власником повз ядро зі значенням `column`. */
  const seed = async (column: string, literal: string) => {
    const id = randomUUID()
    await env.owner.query(
      `INSERT INTO public.${GAUGE_TABLE} (id, org_id, ${column}) VALUES ($1, $2, ${literal})`,
      [id, env.actor.org]
    )
    return id
  }
  const versionOf = async (id: string) =>
    (
      await env.owner.query<{ v: string }>(
        `SELECT version::text AS v FROM public.${GAUGE_TABLE} WHERE id = $1`,
        [id]
      )
    ).rows[0]!.v
  /** Рядок так, як його бачить клієнт: результат ядра (порожня зміна, відкат). */
  const readThroughCore = async (id: string) => {
    const row = await save(env, { id }, await versionOf(id), null, false)
    if (row instanceof pg.DatabaseError) throw row
    return row
  }
  /** Зміна `column` на `next` з базою `base` за застарілою версією `1`. */
  const casUpdate = (
    id: string,
    column: string,
    next: unknown,
    base: unknown
  ) => save(env, { id, [column]: next }, "1", { [column]: base }, true)
  const FIELDS = {
    code: "P0001",
    message: "command.conflict",
    detail: "fields",
  }

  // Кожен рядок: колонка, збережене значення (SQL), база, рівна збереженому
  // в іншому записі, і база, що відрізняється на найменший крок.
  it.each([
    // Масштаб колонки: `1.5` і `1.5000000000` — та сама величина
    ["numeric with scale", "amount", "1.5", "1.5", "1.5000000001"],
    // Понад 2^53: сусіднє ціле `number` не розрізнив би
    [
      "bigint",
      "counter",
      "9007199254740993",
      "9007199254740993",
      "9007199254740992",
    ],
    [
      "jsonb",
      "payload",
      `'{"a": 1, "b": [1, 2]}'`,
      { b: [1, 2], a: 1 },
      { a: 1, b: [2, 1] },
    ],
    // Дубль ключа й пробіли `json`: жодне читання їх не показує — не зміна
    [
      "json with a duplicate key",
      "raw",
      `'{"a": 1,  "a": 2}'`,
      { a: 2 },
      { a: 1 },
    ],
    // І11: під `extra_float_digits = -3` обидва — `0.3`
    [
      "double precision",
      "ratio",
      "0.30000000000000004",
      0.30000000000000004,
      0.3,
    ],
    ["null", "reading", "NULL", null, 0],
    ["a value against a null base", "reading", "0", 0, null],
    // Той самий момент в іншому поясі; сусідня мікросекунда — зміна
    [
      "timestamptz",
      "at",
      "'2026-11-22 10:00:00+00'",
      "2026-11-22T12:00:00+02:00",
      "2026-11-22T10:00:00.000001+00:00",
    ],
    ["date", "day", "'2026-11-22'", "2026-11-22", "2026-11-23"],
  ] as const)(
    "%s: an equal base passes, a neighbouring one is conflict fields",
    async (_, column, stored, equal, neighbour) => {
      const next = column === "raw" || column === "payload" ? { z: 1 } : equal
      const refused = await seed(column, stored)
      expect(await casUpdate(refused, column, next, neighbour)).toMatchObject({
        ...FIELDS,
        hint: await versionOf(refused),
      })
      const passed = await seed(column, stored)
      expect(await casUpdate(passed, column, next, equal)).toMatchObject({
        id: passed,
      })
    }
  )

  // Рішення архітекторки до Р4: база — те, що клієнт прочитав через ядро;
  // `json`, записаний повз ядро з пробілами й дублем ключа, нею не стає
  // вічним конфліктом, а справжня зміна — стає, і повтор з перечитаною
  // базою проходить (без циклу).
  it("json written outside the core: the base read through the core passes; after a real change the re-read base passes", async () => {
    const id = await seed("raw", `'{"a": 1,   "a": {"x":  [1,2]}}'`)
    const base = (await readThroughCore(id)).raw
    expect(base).toEqual({ a: { x: [1, 2] } })
    expect(await casUpdate(id, "raw", { b: 1 }, base)).toMatchObject({
      id,
      raw: { b: 1 },
    })
    // Чужа зміна повз ядро — та сама форма запису, інший зміст
    await env.owner.query(
      `UPDATE public.${GAUGE_TABLE} SET raw = '{"b":  2, "b": 3}' WHERE id = $1`,
      [id]
    )
    expect(await casUpdate(id, "raw", { c: 1 }, { b: 1 })).toMatchObject({
      ...FIELDS,
      hint: await versionOf(id),
    })
    const reread = (await readThroughCore(id)).raw
    expect(reread).toEqual({ b: 3 })
    expect(await casUpdate(id, "raw", { c: 1 }, reread)).toMatchObject({
      id,
      raw: { c: 1 },
    })
  })

  // Тіло функції застосунку може поставити `SET LOCAL` закріпленого
  // налаштування, і без власних опцій ядра воно доживає до пізнішого виклику
  // ядра в тій самій транзакції команди: під `extra_float_digits = -15`
  // `1.1` і `1.4` кодуються як `1`, і чужа зміна пройшла б CAS.
  it("a trigger of an earlier phase lowers extra_float_digits: a later field CAS still sees the change", async () => {
    await env.owner.query(
      `CREATE FUNCTION public.gauge_lower_precision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN SET LOCAL extra_float_digits = -15; RETURN NULL; END $$;
       GRANT EXECUTE ON FUNCTION public.gauge_lower_precision() TO PUBLIC;
       CREATE TRIGGER gauge_lower_precision AFTER UPDATE ON public.${GAUGE_TABLE} FOR EACH ROW EXECUTE FUNCTION public.gauge_lower_precision();`
    )
    try {
      const earlier = await seed("reading", "0")
      const changed = await seed("ratio", "1.4")
      expect(
        await saveSteps(
          env,
          [
            {
              item: { id: earlier, reading: 1 },
              version: await versionOf(earlier),
              expected: null,
            },
            {
              item: { id: changed, ratio: 2 },
              version: "1",
              expected: { ratio: 1.1 },
            },
          ],
          true
        )
      ).toMatchObject({ ...FIELDS, hint: await versionOf(changed) })
    } finally {
      await env.owner.query(
        `DROP TRIGGER gauge_lower_precision ON public.${GAUGE_TABLE};
         DROP FUNCTION public.gauge_lower_precision();`
      )
    }
  })

  // І11 у результаті: `double precision` без втрат під ворожою сесією.
  it("double precision comes back without loss under extra_float_digits = -3", async () => {
    const id = await seed("ratio", "0.30000000000000004")
    expect((await readThroughCore(id)).ratio).toBe(0.30000000000000004)
  })
})

// Підпис ядра змінився без перегрузки (Р2): ціль, що має `save` старого
// покоління (`(jsonb, bigint)`), після застосування моделі рушієм має лише
// новий підпис — інакше старий виклик ішов би повз CAS і повз нові відмови.
// DB, бо що лишає в базі план pg-delta, вирішує рушій над справжнім станом.
it("applying the model drops the old two-argument save overload", async () => {
  const model = await compiled()
  await withModelTarget(model, async (url) => {
    const target = { url: ownerLoginOf(url) }
    const owner = new pg.Client({ connectionString: target.url })
    await owner.connect()
    try {
      await owner.query(
        `CREATE FUNCTION public.${GAUGE_TABLE}_save(p_item jsonb, p_expected_version bigint) RETURNS text LANGUAGE sql AS $$ SELECT 'old' $$`
      )
      const overloads = async () =>
        (
          await owner.query<{ args: string }>(
            `SELECT pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
              FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1
              ORDER BY 1`,
            [`${GAUGE_TABLE}_save`]
          )
        ).rows.map((r) => r.args)
      expect(await overloads()).toEqual([
        "p_item jsonb, p_expected_version bigint",
        "p_item jsonb, p_expected_version bigint, p_expected_values jsonb",
      ])
      const outcome = await buildPlan(
        createPgDeltaEngine(),
        {
          reader: createApplyDatabase({ readOnly: true }),
          scratch: createApplyDatabase({ readOnly: false }),
        },
        model,
        { target },
        []
      )
      if (outcome.status !== "planned")
        throw new Error(
          `${outcome.status}: ${outcome.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`
        )
      const applied = await executePlan(
        createApplyDatabase({ readOnly: false }),
        target,
        outcome.artifact,
        {
          mode: "apply",
          planHash: outcome.artifact.planHash,
          allow: outcome.artifact.requiredPermissions,
          snapshot: canonicalSnapshot(model),
        }
      )
      expect(applied.status).toBe("committed")
      expect(await overloads()).toEqual([
        "p_item jsonb, p_expected_version bigint, p_expected_values jsonb",
      ])
    } finally {
      await owner.end()
    }
  })
}, 180_000)
