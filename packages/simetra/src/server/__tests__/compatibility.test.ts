import {
  catalogIndex,
  dataRequestSchema,
  operationFromWire,
  runtimeCatalogSchema,
  type DataRequest,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { checkCompatibility } from "../compatibility"
import { ID, link, orgMember, organization, region, sample } from "./fixtures"

const catalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [sample, region, link, organization, orgMember],
})

const index = catalogIndex(catalog.objects)

const UNKNOWN = "00000000-0000-4000-8000-0000000000ee"
const SECTION = sample.tabularSections[0]!.id
const LINE = { id: ID, qty_col: 1 }
const KERNELS = {
  [sample.id]: sample.kernelHash,
  [organization.id]: organization.kernelHash,
  [link.id]: link.kernelHash,
}

// Вхід — через схему конверта, як в обробнику: звірка бачить розібраний запит.
const request = (body: unknown): DataRequest["request"] =>
  dataRequestSchema.parse({ subject: "user-1", request: body }).request

const run = (operation: object, kernels: object | null = KERNELS) =>
  request({ type: "run", operation, ...(kernels === null ? {} : { kernels }) })
const create = (fields: object = {}, object = sample.id) =>
  run({ action: "create", object, ...fields })
const update = (fields: object = {}, object = sample.id) =>
  run({ action: "update", object, id: ID, expectedVersion: 1, ...fields })
const read = (query: object) =>
  request({ type: "read", query: { object: sample.id, limit: 10, ...query } })
const lines = (query: object) => read({ tabularSection: SECTION, ...query })

const staleOf = (object: string) => ({ code: "command.stale-client", object })

// Ворожі фізичні імена: поза каталогом, з лапками, крапкою, `;`, системна.
const HOSTILE = ["nope", '"code_col"', "public.code_col", "code_col;", "ctid"]

describe("checkCompatibility: run", () => {
  it.each<[string, DataRequest["request"]]>([
    ["create з колонками вставки", create({ values: { code_col: "a" } })],
    [
      "create з парою",
      create({ values: { subject_col: ID, subject_type: "project" } }),
    ],
    ["update з колонками зміни", update({ values: { code_col: "a" } })],
    [
      "update: рядок ТЧ — за переліком вставки (колонка лише вставки)",
      update({
        tabularSections: { [SECTION]: [{ ...LINE, firstOnly_col: "x" }] },
      }),
    ],
    [
      "markDeletion",
      run({
        action: "markDeletion",
        object: sample.id,
        id: ID,
        expectedVersion: 1,
        mark: true,
      }),
    ],
    [
      "delete",
      run({ action: "delete", object: sample.id, id: ID, expectedVersion: 1 }),
    ],
    [
      "creatorMember — за вставкою довідника членства",
      create(
        { values: { code: "a" }, creatorMember: { title: "Owner" } },
        organization.id
      ),
    ],
    [
      "пакет сумісних операцій",
      request({
        type: "run",
        batch: [
          { action: "create", object: sample.id, values: { code_col: "a" } },
          { action: "delete", object: link.id, id: ID, expectedVersion: 1 },
        ],
        kernels: KERNELS,
      }),
    ],
  ])("%s — сумісно", (_, body) => {
    expect(checkCompatibility(index, body)).toBeUndefined()
  })

  it.each<[string, DataRequest["request"], string]>([
    ["невідомий UUID об'єкта", create({}, UNKNOWN), UNKNOWN],
    [
      "kernels відсутні",
      run({ action: "create", object: sample.id }, null),
      sample.id,
    ],
    [
      "хеш ядра іншого об'єкта",
      run(
        { action: "create", object: sample.id },
        { [link.id]: link.kernelHash }
      ),
      sample.id,
    ],
    [
      "інший хеш ядра",
      run(
        { action: "create", object: sample.id },
        { [sample.id]: "f".repeat(64) }
      ),
      sample.id,
    ],
    [
      "create: колонка поза вставкою",
      create({ values: { computed_col: 1 } }),
      sample.id,
    ],
    [
      "update: колонка лише вставки",
      update({ values: { frozen_col: "a" } }),
      sample.id,
    ],
    ["update: ключ шапки у values", update({ values: { id: ID } }), sample.id],
    ...HOSTILE.map((name): [string, DataRequest["request"], string] => [
      `шапка: вороже ім'я ${name}`,
      create({ values: { [name]: 1 } }),
      sample.id,
    ]),
    [
      "невідомий id ТЧ",
      update({ tabularSections: { [UNKNOWN]: [LINE] } }),
      sample.id,
    ],
    [
      "рядок ТЧ: колонка поза вставкою",
      update({
        tabularSections: { [SECTION]: [{ ...LINE, copy_id_col: "x" }] },
      }),
      sample.id,
    ],
    [
      "рядок ТЧ: колонка власника",
      create({ tabularSections: { [SECTION]: [{ ...LINE, parent_id: ID }] } }),
      sample.id,
    ],
    ...HOSTILE.map((name): [string, DataRequest["request"], string] => [
      `рядок ТЧ: вороже ім'я ${name}`,
      update({ tabularSections: { [SECTION]: [{ ...LINE, [name]: 1 }] } }),
      sample.id,
    ]),
    [
      "creatorMember: колонка поза вставкою членства",
      create({ creatorMember: { ctid: 1 } }, organization.id),
      organization.id,
    ],
    [
      "creatorMember: колонка шапки кореня, а не членства",
      create({ creatorMember: { code: "a" } }, organization.id),
      organization.id,
    ],
    [
      "пакет: одна несумісна операція — відмова цілком",
      request({
        type: "run",
        batch: [
          { action: "create", object: sample.id, values: { code_col: "a" } },
          { action: "delete", object: link.id, id: ID, expectedVersion: 1 },
          { action: "create", object: sample.id, values: { ctid: 1 } },
        ],
        kernels: KERNELS,
      }),
      sample.id,
    ],
    [
      "пакет: невідомий об'єкт другої операції",
      request({
        type: "run",
        batch: [
          { action: "create", object: sample.id },
          { action: "delete", object: UNKNOWN, id: ID, expectedVersion: 1 },
        ],
        kernels: KERNELS,
      }),
      UNKNOWN,
    ],
  ])("%s — stale-client", (_, body, object) => {
    expect(checkCompatibility(index, body)).toStrictEqual(staleOf(object))
  })
})

describe("checkCompatibility: values.__proto__", () => {
  // `z.record` Zod викидає `__proto__` під час розбору: звірка й мапінг
  // однаково його не бачать — ключ ігнорується розбором, а не відхиляється.
  const raw = (values: string) =>
    JSON.parse(
      `{"type":"run","kernels":${JSON.stringify(KERNELS)},"operation":` +
        `{"action":"create","object":"${sample.id}","values":${values}}}`
    ) as unknown

  it("__proto__ ігнорується розбором і в звірці, і в мапінгу", () => {
    const body = request(raw('{"__proto__":{"ctid":1},"code_col":"a"}'))
    expect(checkCompatibility(index, body)).toBeUndefined()
    if (body.type !== "run" || body.operation === undefined) throw new Error()
    const mapped = operationFromWire(index, body.operation)
    expect(mapped).toStrictEqual({
      ok: true,
      value: expect.objectContaining({ values: { code: "a" } }) as unknown,
    })
  })

  it("constructor розбір лишає — stale-client, як інша невідома колонка", () => {
    const body = request(raw('{"constructor":1}'))
    expect(checkCompatibility(index, body)).toStrictEqual(staleOf(sample.id))
  })
})

describe("checkCompatibility: read", () => {
  it.each<[string, DataRequest["request"]]>([
    [
      "in за ключем і за версією",
      read({
        where: {
          and: [
            { attribute: "id", op: "in", value: [ID] },
            { attribute: "version", op: "in", value: ["1"] },
          ],
        },
      }),
    ],
    [
      "фільтр за парою — її column",
      read({
        where: {
          attribute: "subject_col",
          op: "eq",
          value: { type: "project", id: ID },
        },
      }),
    ],
    [
      "сортування за реквізитом",
      read({ orderBy: [{ attribute: "code_col", direction: "asc" }] }),
    ],
    [
      "фільтр за лінивою колонкою — далі command.invalid, не звірка",
      request({
        type: "read",
        query: {
          object: link.id,
          limit: 10,
          where: { attribute: "archive_id", op: "isNull" },
        },
      }),
    ],
    [
      "include",
      request({
        type: "read",
        query: { object: link.id, limit: 10, include: ["region_id"] },
      }),
    ],
    [
      "картка з ТЧ за id",
      request({
        type: "read",
        query: { object: sample.id, id: ID, tabularSections: [SECTION] },
      }),
    ],
    [
      "картка з усіма ТЧ",
      request({
        type: "read",
        query: { object: sample.id, id: ID, tabularSections: true },
      }),
    ],
    [
      "сторінка ТЧ за власником і номером",
      lines({
        where: { attribute: "parent_id", op: "eq", value: ID },
        orderBy: [{ attribute: "line_number", direction: "asc" }],
      }),
    ],
    [
      "ТЧ власника",
      request({
        type: "read",
        query: { object: sample.id, tabularSection: SECTION, owner: ID },
      }),
    ],
    [
      "лічильник",
      request({ type: "read", query: { object: sample.id, count: true } }),
    ],
    ["version", request({ type: "version" })],
  ])("%s — сумісно", (_, body) => {
    expect(checkCompatibility(index, body)).toBeUndefined()
  })

  it.each<[string, DataRequest["request"], string]>([
    [
      "невідомий UUID об'єкта",
      request({ type: "read", query: { object: UNKNOWN, limit: 1 } }),
      UNKNOWN,
    ],
    ...HOSTILE.map((name): [string, DataRequest["request"], string] => [
      `фільтр: вороже ім'я ${name}`,
      read({
        where: {
          or: [
            { attribute: "code_col", op: "eq", value: "a" },
            { not: { attribute: name, op: "isNull" } },
          ],
        },
      }),
      sample.id,
    ]),
    [
      "сортування: невідома колонка",
      read({ orderBy: [{ attribute: "ctid", direction: "asc" }] }),
      sample.id,
    ],
    [
      "include: невідома колонка",
      request({
        type: "read",
        query: { object: link.id, limit: 1, include: ["ctid"] },
      }),
      link.id,
    ],
    [
      "where: колонка мітки пари",
      read({
        where: { attribute: "subject_type", op: "eq", value: "project" },
      }),
      sample.id,
    ],
    [
      "orderBy: колонка мітки пари",
      read({ orderBy: [{ attribute: "subject_type", direction: "asc" }] }),
      sample.id,
    ],
    [
      "include: колонка мітки пари",
      read({ include: ["subject_type"] }),
      sample.id,
    ],
    [
      "картка: невідомий id ТЧ",
      request({
        type: "read",
        query: { object: sample.id, id: ID, tabularSections: [UNKNOWN] },
      }),
      sample.id,
    ],
    [
      "сторінка ТЧ: невідомий id ТЧ",
      request({
        type: "read",
        query: { object: sample.id, tabularSection: UNKNOWN, limit: 1 },
      }),
      sample.id,
    ],
    [
      "сторінка ТЧ: колонка шапки",
      lines({ where: { attribute: "code_col", op: "eq", value: "a" } }),
      sample.id,
    ],
    [
      "сторінка ТЧ: системна колонка",
      lines({ orderBy: [{ attribute: "ctid", direction: "asc" }] }),
      sample.id,
    ],
    [
      "лічильник: невідома колонка",
      request({
        type: "read",
        query: {
          object: sample.id,
          count: true,
          where: { attribute: "ctid", op: "isNull" },
        },
      }),
      sample.id,
    ],
  ])("%s — stale-client", (_, body, object) => {
    expect(checkCompatibility(index, body)).toStrictEqual(staleOf(object))
  })
})
