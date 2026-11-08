// p95 «побудова знімка ядра + рендер React» на вигляді `full` у 5000 рядків.
// Зміна приходить як сигнал (Writer.patch) — шлях без мережі; вимір від
// виклику commit ядра до кінця commit-у React зони (Profiler onRender).
import { expect, loginAs, settle, test, uniqueSubject } from './harness'

const N = 60

for (const kind of ['value', 'sort'] as const)
  test(`full 5000: p95 знімок + рендер, зміна ${kind === 'value' ? 'значення' : 'ключа сортування'}`, async ({ page, oracle, browserName }) => {
    await loginAs(page, uniqueSubject('alice-full'))
    await page.goto('/full')
    await page.waitForFunction(() => Number(document.querySelector('[data-count]')?.getAttribute('data-count')) === 5000, null, { timeout: 30_000 })
    await settle(page, 1200)
    const samples = await page.evaluate(
      async ({ n, kind }) => {
        const core = (window as any).__t4Holder.core
        const handle = core.view({ kind: 'full', object: 'Catalog.Item', orderBy: [{ attribute: 'num', direction: 'asc' }] })
        const out: { core: number; total: number }[] = []
        for (let i = 0; i < n; i++) {
          const rows = handle.getSnapshot().rows
          const r = rows[(i * 37) % rows.length]
          const values = kind === 'value' ? { ...r.values, name: `patched ${i}` } : { ...r.values, num: (r.values.num as number) + 1 }
          const commits = (window as any).__t4Commits as { id: string; t: number }[]
          const before = commits.length
          const t0 = performance.now()
          core.commit((w: any) => w.patch('Catalog.Item', [{ key: r.key, version: r.version + 1, values }]), core.token())
          handle.getSnapshot()
          const t1 = performance.now()
          await new Promise<void>((resolve) => {
            const wait = () => (commits.slice(before).some((c) => c.id === 'full') ? resolve() : setTimeout(wait, 0))
            wait()
          })
          const end = commits.slice(before).find((c) => c.id === 'full')!.t
          out.push({ core: t1 - t0, total: end - t0 })
          await new Promise((r) => requestAnimationFrame(() => r(null)))
        }
        return out
      },
      { n: N, kind },
    )
    const p = (xs: number[], q: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!
    const r = {
      browser: browserName,
      kind,
      coreP50: +p(samples.map((s) => s.core), 0.5).toFixed(2),
      coreP95: +p(samples.map((s) => s.core), 0.95).toFixed(2),
      totalP50: +p(samples.map((s) => s.total), 0.5).toFixed(2),
      totalP95: +p(samples.map((s) => s.total), 0.95).toFixed(2),
    }
    console.log('PERF', JSON.stringify(r))
    test.info().annotations.push({ type: 'perf', description: JSON.stringify(r) })
    expect(r.totalP95).toBeLessThan(50)
    await oracle.violations()
  })
