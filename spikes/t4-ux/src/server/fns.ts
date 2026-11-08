// Серверні функції полігона. Суб'єкт береться лише з cookie сесії, ніколи з
// аргументів клієнта; кожна відповідь несе суб'єкта, щоб клієнт відкинув чужу.
import { createServerFn } from "@tanstack/react-start"
import {
  deleteCookie,
  getCookie,
  setCookie,
} from "@tanstack/react-start/server"
import type {
  CommandError,
  CommandResult,
  Operation,
  ReadQuery,
  ReadRows,
} from "../../../../packages/simetra/src/model/index"
import { ITEM } from "../core"
import { serverOf } from "./db"

interface Faults {
  readMs: number
  writeMs: number
  failNext?: CommandError
  /** Застосувати на сервері, а викликачу віддати відмову (відповідь утрачено). */
  lostReplyNext?: boolean
  hold?: { promise: Promise<void>; release: () => void }
  rightsVersion: number
}
const faults = new Map<string, Faults>()
function faultsOf(subject: string): Faults {
  let f = faults.get(subject)
  if (!f) {
    f = { readMs: 0, writeMs: 0, rightsVersion: 1 }
    faults.set(subject, f)
  }
  return f
}
const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()

// Сесія полігона: непрозорий cookie → суб'єкт (форма Better Auth: cookie +
// серверна сесія), без специфіки Supabase.
const sessions = new Map<string, string>()
function subjectOf(): string | null {
  const sid = getCookie("sid")
  return sid ? (sessions.get(sid) ?? null) : null
}
function subjectOrThrow(): string {
  const s = subjectOf()
  if (!s) throw new Error("unauthenticated")
  return s
}

export const getSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const subject = subjectOf()
    return {
      subject,
      rightsVersion: subject ? faultsOf(subject).rightsVersion : 0,
    }
  }
)

/** Контракт `version`: права й каталог для звірки знімка SSR після гідратації. */
export const getVersion = createServerFn({ method: "GET" }).handler(
  async () => {
    const subject = subjectOf()
    return {
      subject,
      catalogHash: "catalog-v1",
      rightsVersion: subject ? faultsOf(subject).rightsVersion : 0,
    }
  }
)

export const login = createServerFn({ method: "POST" })
  .validator((name: string) => name)
  .handler(async ({ data }) => {
    const sid = crypto.randomUUID()
    sessions.set(sid, data)
    setCookie("sid", sid, { httpOnly: true, path: "/", sameSite: "lax" })
    return { subject: data }
  })

export const logout = createServerFn({ method: "POST" }).handler(async () => {
  const sid = getCookie("sid")
  if (sid) sessions.delete(sid)
  deleteCookie("sid", { path: "/" })
  return { subject: null }
})

type Reply<T> =
  | { subject: string; ok: true; value: T }
  | { subject: string; ok: false; error: CommandError }

function failure(e: unknown): CommandError {
  const err = (e as { error?: CommandError })?.error
  return err?.code ? err : { code: "command.internal" }
}

export const readRows = createServerFn({ method: "POST" })
  .validator((q: ReadQuery) => q)
  .handler(async ({ data }): Promise<Reply<ReadRows>> => {
    const subject = subjectOrThrow()
    await sleep(faultsOf(subject).readMs)
    try {
      return { subject, ok: true, value: serverOf(subject).read(data) }
    } catch (e) {
      return { subject, ok: false, error: failure(e) }
    }
  })

export const runOps = createServerFn({ method: "POST" })
  .validator((ops: Operation[]) => ops)
  .handler(async ({ data }): Promise<Reply<CommandResult>> => {
    const subject = subjectOrThrow()
    const f = faultsOf(subject)
    await sleep(f.writeMs)
    if (f.hold) await f.hold.promise
    if (f.failNext) {
      const error = f.failNext
      f.failNext = undefined
      return { subject, ok: false, error }
    }
    if (f.lostReplyNext) {
      f.lostReplyNext = false
      try {
        serverOf(subject).run(data)
      } catch {
        // Сервер відмовив сам — викликач однаково бачить невідомий результат.
      }
      return {
        subject,
        ok: false,
        error: { code: "command.unavailable" } as CommandError,
      }
    }
    try {
      return { subject, ok: true, value: serverOf(subject).run(data) }
    } catch (e) {
      return { subject, ok: false, error: failure(e) }
    }
  })

// Лише для тестів полігона: затримки, відмови, чужі зміни, зміна прав.
export type Control =
  | { kind: "latency"; readMs?: number; writeMs?: number }
  | { kind: "failNext"; code: string; reason?: string }
  | { kind: "hold" }
  | { kind: "release" }
  | { kind: "edit"; id: string; values: Record<string, unknown> }
  | { kind: "remove"; id: string }
  | { kind: "insert"; id: string; values: Record<string, unknown> }
  | { kind: "rights"; version: number }
  | { kind: "lostReplyNext" }

export const control = createServerFn({ method: "POST" })
  .validator((c: Control) => c)
  .handler(async ({ data }) => {
    const subject = subjectOrThrow()
    const f = faultsOf(subject)
    const s = serverOf(subject)
    switch (data.kind) {
      case "latency":
        f.readMs = data.readMs ?? f.readMs
        f.writeMs = data.writeMs ?? f.writeMs
        break
      case "failNext":
        f.failNext = { code: data.code, reason: data.reason } as CommandError
        break
      case "hold": {
        let release!: () => void
        const promise = new Promise<void>((r) => (release = r))
        f.hold = { promise, release }
        break
      }
      case "release":
        f.hold?.release()
        f.hold = undefined
        break
      case "edit":
        return { ok: true, version: s.edit(ITEM, data.id, data.values) }
      case "remove":
        s.remove(ITEM, data.id)
        break
      case "insert":
        s.seed(ITEM, [{ id: data.id, ...data.values }])
        break
      case "lostReplyNext":
        f.lostReplyNext = true
        break
      case "rights":
        f.rightsVersion = data.version
        break
    }
    return { ok: true }
  })

/** Лінивий `count` (спека §6.4): повільний, іде потоком SSR окремо від рядків. */
export const countRows = createServerFn({ method: "GET" }).handler(async () => {
  const subject = subjectOrThrow()
  await sleep(400)
  return { subject, count: serverOf(subject).tables.get(ITEM)!.size }
})
