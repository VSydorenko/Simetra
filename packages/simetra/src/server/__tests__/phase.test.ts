import {
  BATCH_MAX,
  CommandFailure,
  TABULAR_LINES_MAX,
  readQuerySchema,
  type CommandError,
  type ReadQuery,
} from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { prepareInput } from "../phase"
import { issueReason, prepareRead } from "../read"
import { catalog, rootCatalog } from "./fixtures"
import { CLIENT, ORGANIZATION } from "./harness"

const refusalOf = (input: unknown): CommandError | undefined => {
  try {
    prepareInput(rootCatalog, input)
  } catch (e) {
    if (e instanceof CommandFailure) return e.error
    throw e
  }
  return undefined
}

const create = { action: "create", object: CLIENT, values: { code: "A" } }
const overLimit = (object: unknown) => ({
  action: "create",
  object,
  tabularSections: {
    lines: Array.from({ length: TABULAR_LINES_MAX + 1 }, () => ({})),
  },
})
const once = () => {
  let read = false
  return {
    get() {
      if (read) throw new Error("second read")
      read = true
      return ORGANIZATION
    },
  }
}
const tooLarge = (object?: CommandError["object"]): CommandError => ({
  code: "command.invalid",
  reason: "tabular-too-large",
  path: "lines",
  ...(object === undefined ? {} : { object }),
})

/**
 * Причина межі зі схеми доходить до `command.invalid`; шлях ТЧ — логічне ім'я
 * без префікса й індексу пакета, `object` — з операції, що відмовила, лише
 * коли каталог його знає.
 */
describe("prepareInput reasons", () => {
  it.each<[string, unknown, CommandError]>([
    [
      "a batch over BATCH_MAX has no path",
      Array(BATCH_MAX + 1).fill(create),
      { code: "command.invalid", reason: "batch-too-large" },
    ],
    [
      "an over-limit section of a single operation",
      overLimit(ORGANIZATION),
      tooLarge(ORGANIZATION),
    ],
    [
      "an over-limit section of the second operation of a batch",
      [create, overLimit(ORGANIZATION)],
      tooLarge(ORGANIZATION),
    ],
    [
      "an object outside the catalog is not echoed",
      [create, overLimit({ kind: "Catalog", name: "Nowhere" })],
      tooLarge(),
    ],
    [
      "a malformed object is not echoed",
      [create, overLimit({ kind: "Catalog", name: 1 })],
      tooLarge(),
    ],
    [
      // Схема читає вхід раніше: геттер, що кидає одразу, — інша відмова.
      "an object behind a getter that throws on a second read is not echoed",
      [create, Object.defineProperty(overLimit(undefined), "object", once())],
      tooLarge(),
    ],
  ])("%s", (_, input, error) => {
    expect(refusalOf(input)).toEqual(error)
  })
})

describe("issueReason", () => {
  const issue = (reason?: string): z.core.$ZodIssue => ({
    code: "custom",
    path: [],
    message: "x",
    ...(reason === undefined ? {} : { params: { reason } }),
  })

  it.each<[string, z.core.$ZodIssue[], string | undefined]>([
    ["no issue carries a reason", [issue()], undefined],
    [
      "the reason of a later issue",
      [issue(), issue("batch-too-large")],
      "batch-too-large",
    ],
  ])("%s", (_, issues, reason) => {
    expect(issueReason(new z.ZodError(issues))).toBe(reason)
  })
})

describe("prepareRead reasons", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("puts the reason and its issue path into command.invalid", () => {
    vi.spyOn(readQuerySchema, "safeParse").mockReturnValueOnce({
      success: false,
      error: new z.ZodError([
        { code: "custom", path: ["where"], message: "x" },
        {
          code: "custom",
          path: ["keys"],
          message: "x",
          params: { reason: "too-large" },
        },
      ]) as z.ZodError<ReadQuery>,
    })
    expect(prepareRead(catalog, {})).toEqual({
      error: { code: "command.invalid", reason: "too-large", path: "keys" },
    })
  })
})
