// Серверні функції полігона. Суб'єкт береться лише з cookie сесії, ніколи з
// аргументів клієнта; кожна відповідь несе суб'єкта, щоб клієнт відкинув чужу.
import { createServerFn } from '@tanstack/react-start'
import { deleteCookie, getCookie, setCookie } from '@tanstack/react-start/server'
import type { Op, WriteResult } from './db'
import { foreign, readCard, readPage, readUpTo, write } from './db'

interface Faults {
  readMs: number
  writeMs: number
  failNext?: { code: string; reason?: string }
  hold?: { promise: Promise<void>; release: () => void }
}
const faults = new Map<string, Faults>()
function faultsOf(subject: string): Faults {
  let f = faults.get(subject)
  if (!f) {
    f = { readMs: 0, writeMs: 0 }
    faults.set(subject, f)
  }
  return f
}
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

function subjectOrThrow(): string {
  const s = getCookie('sid')
  if (!s) throw new Error('unauthenticated')
  return s
}

export const getSession = createServerFn({ method: 'GET' }).handler(async () => {
  return { subject: getCookie('sid') ?? null }
})

export const login = createServerFn({ method: 'POST' })
  .validator((name: string) => name)
  .handler(async ({ data }) => {
    setCookie('sid', data, { httpOnly: true, path: '/', sameSite: 'lax' })
    return { subject: data }
  })

export const logout = createServerFn({ method: 'POST' }).handler(async () => {
  deleteCookie('sid', { path: '/' })
  return { subject: null }
})

export const fetchPage = createServerFn({ method: 'GET' })
  .validator((input: { after: number | null }) => input)
  .handler(async ({ data }) => {
    const subject = subjectOrThrow()
    await sleep(faultsOf(subject).readMs)
    return { subject, ...readPage(subject, data.after) }
  })

export const fetchUpTo = createServerFn({ method: 'GET' })
  .validator((input: { lastNum: number }) => input)
  .handler(async ({ data }) => {
    const subject = subjectOrThrow()
    await sleep(faultsOf(subject).readMs)
    return { subject, rows: readUpTo(subject, data.lastNum) }
  })

export const fetchCard = createServerFn({ method: 'GET' })
  .validator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const subject = subjectOrThrow()
    await sleep(faultsOf(subject).readMs)
    return { subject, card: readCard(subject, data.id) ?? null }
  })

export const runOps = createServerFn({ method: 'POST' })
  .validator((ops: Op[]) => ops)
  .handler(async ({ data }): Promise<WriteResult & { subject: string }> => {
    const subject = subjectOrThrow()
    const f = faultsOf(subject)
    await sleep(f.writeMs)
    if (f.hold) await f.hold.promise
    if (f.failNext) {
      const error = f.failNext
      f.failNext = undefined
      return { subject, ok: false, error }
    }
    return { subject, ...write(subject, data) }
  })

// Лише для тестів полігона: керування затримками, відмовами й чужими змінами.
export type Control =
  | { kind: 'latency'; readMs?: number; writeMs?: number }
  | { kind: 'failNext'; code: string; reason?: string }
  | { kind: 'hold' }
  | { kind: 'release' }
  | { kind: 'foreign'; change: Parameters<typeof foreign>[1] }

export const control = createServerFn({ method: 'POST' })
  .validator((c: Control) => c)
  .handler(async ({ data }) => {
    const subject = subjectOrThrow()
    const f = faultsOf(subject)
    if (data.kind === 'latency') {
      f.readMs = data.readMs ?? f.readMs
      f.writeMs = data.writeMs ?? f.writeMs
    } else if (data.kind === 'failNext') f.failNext = { code: data.code, reason: data.reason }
    else if (data.kind === 'hold') {
      let release!: () => void
      const promise = new Promise<void>((r) => (release = r))
      f.hold = { promise, release }
    } else if (data.kind === 'release') {
      f.hold?.release()
      f.hold = undefined
    } else foreign(subject, data.change)
    return { ok: true }
  })
