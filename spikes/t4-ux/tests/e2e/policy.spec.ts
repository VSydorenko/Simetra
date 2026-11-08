// Політики дії predict / await: показ і час «клік → видимий результат».
// Затримка мережі — серверна (control latency): однаково для Chromium і
// WebKit (CDP-throttling є лише в Chromium). Кожен прогін — під оракулом.
import { writeFileSync, mkdirSync } from 'node:fs'
import { control, expect, settle, test } from './harness'
import { openList } from './flows'

const LAT = [50, 150, 400]
const REPS = 5
const results: Record<string, unknown>[] = []

for (const policy of ['predict', 'await'] as const)
  for (const ms of LAT)
    test(`політика ${policy}, затримка ${ms} мс`, async ({ page, oracle, browserName }) => {
      await openList(page, { breaks: undefined })
      await page.goto(`/?policy=${policy}`)
      await page.waitForFunction(() => (window as any).__t4Commits?.some((c: any) => c.id === 'list'))
      await settle(page, 300)
      await control(page, { kind: 'latency', writeMs: ms })
      const samples: { visible: number; confirmed: number }[] = []
      for (let i = 0; i < REPS; i++) {
        const row = page.locator('[data-region=list] [data-row-key]').nth(i + 1)
        const key = (await row.getAttribute('data-row-key'))!
        const before = await row.locator('[data-field=status]').textContent()
        await oracle.mark(`toggle-${i}`)
        const t = await page.evaluate(
          ({ key, before }) =>
            new Promise<{ visible: number; confirmed: number }>((resolve) => {
              const sel = `[data-region=list] [data-row-key="${key}"]`
              const t0 = performance.now()
              let visible = -1
              const check = () => {
                const el = document.querySelector(sel)!
                const v = el.querySelector('[data-field=status]')!.textContent
                const st = el.querySelector('[data-state]')!.getAttribute('data-state')
                if (visible < 0 && v !== before) visible = performance.now() - t0
                if (visible >= 0 && st === 'synced') return resolve({ visible, confirmed: performance.now() - t0 })
                requestAnimationFrame(check)
              }
              ;(document.querySelector(`${sel} [data-action=toggle]`) as HTMLButtonElement).click()
              requestAnimationFrame(check)
            }),
          { key, before },
        )
        samples.push(t)
        await settle(page, 100)
      }
      await oracle.expectClean()
      const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
      const r = {
        browser: browserName,
        policy,
        latencyMs: ms,
        visibleMedianMs: Math.round(med(samples.map((s) => s.visible))),
        confirmedMedianMs: Math.round(med(samples.map((s) => s.confirmed))),
      }
      results.push(r)
      test.info().annotations.push({ type: 'timing', description: JSON.stringify(r) })
      if (policy === 'predict') expect(r.visibleMedianMs).toBeLessThan(50)
      else expect(r.visibleMedianMs).toBeGreaterThanOrEqual(ms)
    })

test.afterAll(({ browserName }) => {
  mkdirSync('test-results', { recursive: true })
  writeFileSync(`test-results/policy-${browserName}-${process.pid}.json`, JSON.stringify(results, null, 2))
})
