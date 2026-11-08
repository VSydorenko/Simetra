// Критерій 3 спайку 4: p95 кадру під час швидкої прокрутки вікна, production.
// Метод: прокрутка в сторінці — scrollTop += крок на кожному rAF (300 кадрів),
// інтервали між rAF (час кадру), commit-и React зони `rows` (Profiler, потрібна
// збірка `T4_PROFILING=1`) і Long Animation Frames (Chromium). Звіт — p50,
// p95, max. Запуск: `T4_PROD=1 T4_PERF=1 npx playwright test perf-window`.
import { expect, loginAs, settle, test, uniqueSubject } from "./harness"

const run = process.env.T4_PERF ? test : test.skip

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const at = (q: number) =>
    s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0
  return {
    n: s.length,
    p50: +at(0.5).toFixed(1),
    p95: +at(0.95).toFixed(1),
    max: +(s.at(-1) ?? 0).toFixed(1),
  }
}

for (const mode of ["fixed", "var"] as const) {
  for (const step of [1200, 6000]) {
    run(
      `швидка прокрутка: ${mode}, ${step} px/кадр`,
      async ({ page }, info) => {
        test.setTimeout(120_000)
        await loginAs(page, uniqueSubject("alice-win"))
        await page.goto(`/window?h=${mode}`)
        await page.waitForFunction(() => (window as any).__t4Hydrated)
        await settle(page, 500)
        const r = await page.evaluate(async (step) => {
          const el = document.querySelector("[data-scroll=list]") as HTMLElement
          const commits = (window as any).__t4Commits as {
            id: string
            t: number
            d?: number
          }[]
          const from = commits.length
          const lafs: number[] = []
          try {
            new PerformanceObserver((l) => {
              for (const e of l.getEntries()) lafs.push(e.duration)
            }).observe({ type: "long-animation-frame" as any })
          } catch {}
          const frames: number[] = []
          let last = performance.now()
          for (let i = 0; i < 300; i++) {
            await new Promise<void>((res) => requestAnimationFrame(() => res()))
            const now = performance.now()
            frames.push(now - last)
            last = now
            el.scrollTop += step
          }
          await new Promise((res) => setTimeout(res, 300))
          const rows = commits
            .slice(from)
            .filter((c) => c.id === "rows" && typeof c.d === "number")
            .map((c) => c.d!)
          return { frames, rows, lafs, top: el.scrollTop }
        }, step)
        const out = {
          mode,
          step,
          browser: info.project.name,
          frame: stats(r.frames),
          commit: stats(r.rows),
          longFrames: r.lafs.length,
          longMax: Math.max(0, ...r.lafs),
          scrolled: r.top,
        }
        console.log(JSON.stringify(out))
        expect(r.frames.length).toBe(300)
      }
    )
  }
}
