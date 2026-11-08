// Обв'язка сценаріїв: записувач оракула, позначки дій, вхід, керування фейковим сервером.
import { expect, type Page, test as base } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { analyze, format, type MarkOpts, type OracleLog } from '../oracle/rules'

const recorder = fileURLToPath(new URL('../oracle/recorder.js', import.meta.url))

export const test = base.extend<{ oracle: Oracle }>({
  oracle: async ({ page }, use) => {
    await page.addInitScript({ path: recorder })
    await use(new Oracle(page))
  },
})
export { expect }

export class Oracle {
  constructor(readonly page: Page) {}

  async mark(name: string, opts: MarkOpts = {}) {
    await this.page.evaluate(([n, o]) => (window as any).__oracleMark(n, o), [name, opts] as const)
  }

  async log(): Promise<OracleLog> {
    return this.page.evaluate(() => {
      const w = window as any
      const l = w.__oracle
      l.take?.('final')
      return {
        snaps: l.snaps,
        marks: l.marks,
        shifts: l.shifts,
        appMutationsAfterParse: l.appMutationsAfterParse,
        parsedAt: l.parsedAt,
        hydratedAt: w.__t4Hydrated,
        recoverable: w.__t4Recoverable ?? [],
        shiftsUnsupported: l.shiftsUnsupported,
      }
    })
  }

  async violations() {
    return analyze(await this.log())
  }

  /** Оракул зелений: жодного забороненого кадру. */
  async expectClean() {
    const vs = await this.violations()
    expect(vs, format(vs)).toEqual([])
  }

  /** Commit-и React (Profiler): зона даних `id` і оболонка `app`. */
  async commits(): Promise<{ id: string; phase: string; t: number }[]> {
    return this.page.evaluate(() => (window as any).__t4Commits)
  }

  /** Commit-и зони `id` після її гідратації (mount) — мають бути 0 без дії. */
  async regionUpdatesAfterHydration(id: string): Promise<{ mountAt: number; updates: number; shellUpdates: number }> {
    const cs = await this.commits()
    const mount = cs.find((c) => c.id === id && c.phase === 'mount')
    if (!mount) throw new Error(`region ${id} never mounted`)
    return {
      mountAt: mount.t,
      updates: cs.filter((c) => c.id === id && c.t > mount.t).length,
      shellUpdates: cs.filter((c) => c.id === 'app' && c.phase !== 'mount' && c.t > mount.t).length,
    }
  }
}

let seq = 0
export function uniqueSubject(prefix = 'alice') {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${seq++}`
}

/** Вхід через сторінку /login; далі SSR-завантаження списку цим суб'єктом. */
export async function loginAs(page: Page, subject: string) {
  await page.goto('/login')
  await page.waitForFunction(() => (window as any).__t4Hydrated)
  // Вхід — дія користувача: усе після неї вже не гідратація.
  await page.evaluate(() => (window as any).__oracleMark('login', { allow: ['shift', 'clear', 'reorder', 'scroll'] }))
  await page.fill('[data-field=login]', subject)
  await page.click('[data-action=login]')
  await page.waitForSelector('[data-region=list] [data-row-key]')
}

export async function control(page: Page, c: unknown) {
  await page.evaluate(async (cc) => (window as any).__t4Control(cc), c)
}

export async function settle(page: Page, ms = 150) {
  await page.waitForTimeout(ms)
}
