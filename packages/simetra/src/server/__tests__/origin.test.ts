import { LIMIT_REASONS } from "simetra/model"
import { describe, expect, it } from "vitest"
import { checkRequestOrigin, type RequestOrigin } from "../origin"

const OWN = "https://app.example.com"
const refusal = { code: "command.forbidden", reason: LIMIT_REASONS.origin }

describe("checkRequestOrigin: HTTP", () => {
  it.each<[string, Partial<RequestOrigin>, boolean]>([
    ["Sec-Fetch-Site cross-site", { secFetchSite: "cross-site" }, true],
    ["Sec-Fetch-Site same-site", { secFetchSite: "same-site" }, true],
    ["Sec-Fetch-Site none", { secFetchSite: "none" }, true],
    ["Sec-Fetch-Site same-origin", { secFetchSite: "same-origin" }, false],
    [
      "Origin чужий без Sec-Fetch-Site",
      { origin: "https://evil.example" },
      true,
    ],
    ["Origin власний без Sec-Fetch-Site", { origin: OWN }, false],
    [
      "same-origin з чужим Origin",
      { secFetchSite: "same-origin", origin: "https://evil.example" },
      true,
    ],
    [
      "same-origin з власним Origin",
      { secFetchSite: "same-origin", origin: OWN },
      false,
    ],
    [
      "cross-site з власним Origin",
      { secFetchSite: "cross-site", origin: OWN },
      true,
    ],
    ["обох заголовків немає", {}, true],
    ["Sec-Fetch-Site Same-Origin", { secFetchSite: "Same-Origin" }, true],
    [
      "Sec-Fetch-Site з пробілом попереду",
      { secFetchSite: " same-origin" },
      true,
    ],
    [
      "Sec-Fetch-Site з пробілом позаду",
      { secFetchSite: "same-origin " },
      true,
    ],
    ["Sec-Fetch-Site порожній", { secFetchSite: "" }, true],
    ["Origin порожній", { origin: "" }, true],
    [
      "Origin з верхнім регістром хоста",
      { origin: "https://APP.example.com" },
      true,
    ],
  ])("%s", (_name, headers, refused) => {
    const result = checkRequestOrigin(
      { expectedOrigin: OWN, ...headers },
      { request: { type: "run" } }
    )
    expect(result).toEqual(refused ? refusal : undefined)
  })

  it.each([
    "null",
    "",
    "not a url",
    "https://app.example.com/",
    "https://app.example.com/path",
    "HTTPS://APP.example.com",
  ])("expectedOrigin неканонічний %j", (expectedOrigin) => {
    expect(
      checkRequestOrigin(
        { expectedOrigin, secFetchSite: "same-origin" },
        undefined
      )
    ).toEqual(refusal)
  })

  it("тип запиту в HTTP-гілці не читається", () => {
    const trap = new Proxy(
      {},
      {
        get: () => {
          throw new Error("read")
        },
      }
    )
    expect(
      checkRequestOrigin(
        { expectedOrigin: OWN, secFetchSite: "same-origin" },
        trap
      )
    ).toBeUndefined()
  })
})

describe("checkRequestOrigin: inProcess", () => {
  const wrap = (type: unknown) => ({ request: { type } })
  it.each<[string, unknown, boolean]>([
    ["read", wrap("read"), false],
    // Частини походження не дивиться: будь-які частини `read` — лише читання.
    [
      "read з частинами",
      {
        request: {
          type: "read",
          items: [{ type: "query" }, { type: "version" }, { type: "x" }],
        },
      },
      false,
    ],
    // Окремого запиту `version` більше немає (B1c): старий тип — відмова.
    ["version", wrap("version"), true],
    ["run", wrap("run"), true],
    ["receipt", wrap("receipt"), true],
    ["невідомий тип", wrap("rights2"), true],
    ["тип не рядок", wrap(1), true],
    ["тип String-об'єкт", wrap(Object("read")), true],
    ["без типу", { request: {} }, true],
    ["без request", {}, true],
    ["null", null, true],
    ["undefined", undefined, true],
    ["рядок", "read", true],
    [
      "геттер type кидає",
      {
        request: {
          get type() {
            throw new Error("boom")
          },
        },
      },
      true,
    ],
    [
      "геттер request кидає",
      {
        get request() {
          throw new Error("boom")
        },
      },
      true,
    ],
    [
      "Proxy кидає на get",
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("boom")
          },
        }
      ),
      true,
    ],
  ])("%s", (_name, raw, refused) => {
    expect(checkRequestOrigin({ inProcess: true }, raw)).toEqual(
      refused ? refusal : undefined
    )
  })

  it.each<[string, unknown, boolean]>([
    ["inProcess: false без заголовків", { inProcess: false }, true],
    [
      "inProcess: false з власним Origin — правила HTTP",
      { inProcess: false, expectedOrigin: OWN, origin: OWN },
      false,
    ],
    [
      "inProcess: false з чужим Origin",
      { inProcess: false, expectedOrigin: OWN, origin: "https://evil.example" },
      true,
    ],
    ["inProcess: 1", { inProcess: 1 }, true],
  ])("не-true inProcess іде HTTP-гілкою: %s", (_name, origin, refused) => {
    expect(
      checkRequestOrigin(origin as RequestOrigin, { request: { type: "read" } })
    ).toEqual(refused ? refusal : undefined)
  })

  it("type читається один раз", () => {
    let reads = 0
    const raw = {
      request: {
        get type() {
          reads += 1
          return "read"
        },
      },
    }
    expect(checkRequestOrigin({ inProcess: true }, raw)).toBeUndefined()
    expect(reads).toBe(1)
  })
})
