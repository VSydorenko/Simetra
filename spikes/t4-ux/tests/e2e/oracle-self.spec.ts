// Критерій 1: оракул ловить кожен заборонений кадр на навмисно зламаній
// реалізації. Кожна мутація — свій тип заборони; тест падає, якщо оракул
// мовчить або ловить не той тип.
import type { ViolationKind } from '../oracle/rules'
import * as f from './flows'
import { expect, test, type Oracle } from './harness'
import type { Page } from '@playwright/test'

type Flow = (page: Page, oracle: Oracle, opts: { breaks?: string }) => Promise<unknown>

const cases: Array<{ brk: string; flow: Flow; expect: ViolationKind[]; what: string }> = [
  { brk: 'skeleton', flow: f.backgroundRefresh, expect: ['empty-after-data'], what: 'скелет під час перечитування, коли дані були' },
  { brk: 'flash', flow: f.editField, expect: ['empty-after-data', 'presence-aba'], what: 'рядок зникає й з\'являється після підтвердження' },
  { brk: 'revert', flow: f.editField, expect: ['value-aba'], what: 'значення повертається до старого й назад' },
  { brk: 'reorder', flow: f.backgroundRefresh, expect: ['reorder', 'shift'], what: 'перечитування переставляє рядки' },
  { brk: 'heightjump', flow: f.backgroundRefresh, expect: ['height'], what: 'стрибок висоти рядка без зміни тексту' },
  { brk: 'scrolljump', flow: f.scrollWindow, expect: ['scroll-jump'], what: 'стрибок прокрутки після підвантаження' },
  { brk: 'lazyshift', flow: f.listCardList, expect: ['height', 'layout-shift'], what: 'ліниве поле без зарезервованого місця' },
  { brk: 'keepcore', flow: (p, o, x) => f.switchUser(p, o, x), expect: ['forbidden-text'], what: 'старе ядро після зміни суб\'єкта' },
]

// lazyshift потребує лінивої фази картки: ядро 958e32f2 її не дає (вигляд
// `card` порожній до читання), тож ця мутація вимірюється лише на фейку
// (коміт 4fccfcc1) — до виправлення вигляду картки в спайку 1.
const NEEDS_CARD_FROM_STORE = new Set(['lazyshift'])

for (const c of cases)
  (NEEDS_CARD_FROM_STORE.has(c.brk) ? test.fixme : test)(`оракул ловить: ${c.brk} — ${c.what}`, async ({ page, oracle }) => {
    // Зламаний потік може падати й на власних перевірках — нас цікавить журнал.
    await c.flow(page, oracle, { breaks: c.brk }).catch(() => undefined)
    const kinds = new Set((await oracle.violations()).map((v) => v.kind))
    expect([...kinds].some((k) => c.expect.includes(k)), `очікували ${c.expect.join('|')}, отримали ${[...kinds].join(',') || 'нічого'}`).toBe(true)
  })

test('оракул ловить: hydration — DOM після гідратації відрізняється від серверного HTML', async ({ page, oracle }) => {
  await f.ssrEntry(page, oracle, 'hydration').catch(() => undefined)
  const kinds = new Set((await oracle.violations()).map((v) => v.kind))
  expect(kinds.has('hydration-mutation') || kinds.has('hydration-error')).toBe(true)
})
